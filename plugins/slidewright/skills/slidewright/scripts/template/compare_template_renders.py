#!/usr/bin/env python3
"""Compare template renders while masking only explicitly edited placeholders."""

from __future__ import annotations

import argparse
import json
import posixpath
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import numpy as np
from PIL import Image, ImageChops, ImageEnhance

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"p": P, "a": A, "r": R, "pkg": PKG}


def layout_part(archive: zipfile.ZipFile, slide_number: int) -> str:
    rel_name = f"ppt/slides/_rels/slide{slide_number}.xml.rels"
    root = ET.fromstring(archive.read(rel_name))
    rel = next(node for node in root.findall("pkg:Relationship", NS) if node.get("Type", "").endswith("/slideLayout"))
    return posixpath.normpath(posixpath.join("ppt/slides", rel.get("Target")))


def placeholder_key(shape: ET.Element) -> tuple[str, str] | None:
    ph = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    if ph is None:
        return None
    return ph.get("type", "body"), ph.get("idx", "0")


def edited_shape_keys(archive: zipfile.ZipFile, slide_number: int, names: set[str]) -> list[tuple[str, str]]:
    root = ET.fromstring(archive.read(f"ppt/slides/slide{slide_number}.xml"))
    keys = []
    for shape in root.findall(".//p:sp", NS):
        props = shape.find("p:nvSpPr/p:cNvPr", NS)
        if props is not None and props.get("name") in names:
            key = placeholder_key(shape)
            if key:
                keys.append(key)
    return keys


def placeholder_boxes(archive: zipfile.ZipFile, slide_number: int, names: set[str]) -> list[dict]:
    keys = edited_shape_keys(archive, slide_number, names)
    layout = ET.fromstring(archive.read(layout_part(archive, slide_number)))
    boxes = []
    for key in keys:
        target = next((shape for shape in layout.findall(".//p:sp", NS) if placeholder_key(shape) == key), None)
        if target is None:
            raise ValueError(f"Could not resolve layout placeholder {key}.")
        xfrm = target.find("p:spPr/a:xfrm", NS)
        off = xfrm.find("a:off", NS) if xfrm is not None else None
        ext = xfrm.find("a:ext", NS) if xfrm is not None else None
        if off is None or ext is None:
            raise ValueError(f"Layout placeholder {key} lacks explicit geometry.")
        boxes.append({"left": int(off.get("x")), "top": int(off.get("y")), "width": int(ext.get("cx")), "height": int(ext.get("cy"))})
    return boxes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_pptx")
    parser.add_argument("plan")
    parser.add_argument("source_renders")
    parser.add_argument("edited_renders")
    parser.add_argument("--json", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    source_dir, edited_dir, out_dir = Path(args.source_renders), Path(args.edited_renders), Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.source_pptx) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        slide_width, slide_height = int(size.get("cx")), int(size.get("cy"))
        boxes = placeholder_boxes(archive, int(plan["targetSlide"]), {edit["shapeName"] for edit in plan["edits"]})
    results = []
    for slide_number in range(1, 3):
        source = Image.open(source_dir / f"slide-{slide_number}.png").convert("RGB")
        edited = Image.open(edited_dir / f"slide-{slide_number}.png").convert("RGB").resize(source.size, Image.Resampling.LANCZOS)
        source_arr = np.asarray(source, dtype=np.float32)
        edited_arr = np.asarray(edited, dtype=np.float32)
        absolute = np.abs(source_arr - edited_arr)
        mask = np.zeros(source_arr.shape[:2], dtype=bool)
        if slide_number == int(plan["targetSlide"]):
            for box in boxes:
                left = max(0, round(box["left"] / slide_width * source.width) - 8)
                top = max(0, round(box["top"] / slide_height * source.height) - 8)
                right = min(source.width, round((box["left"] + box["width"]) / slide_width * source.width) + 8)
                bottom = min(source.height, round((box["top"] + box["height"]) / slide_height * source.height) + 8)
                mask[top:bottom, left:right] = True
        outside = absolute[~mask]
        inside = absolute[mask]
        outside_similarity = 1.0 - float(outside.mean()) / 255.0 if outside.size else 1.0
        inside_changed = float((inside.max(axis=1) > 8).mean()) if inside.size else 0.0
        exact = bool((absolute.max(axis=2) == 0).all())
        valid = exact if slide_number in plan["preserveOnlySlides"] else outside_similarity >= 0.999 and inside_changed > 0.001
        ImageEnhance.Contrast(ImageChops.difference(source, edited)).enhance(3).save(out_dir / f"slide-{slide_number}-diff.png")
        Image.blend(source, edited, 0.5).save(out_dir / f"slide-{slide_number}-overlay.png")
        results.append({"slide": slide_number, "valid": valid, "exactPixelMatch": exact, "outsideEditedMasksSimilarity": round(outside_similarity, 6), "insideEditedMasksChangedFraction": round(inside_changed, 6)})
    report = {"valid": all(item["valid"] for item in results), "editedPlaceholderBoxesEmu": boxes, "slides": results}
    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
