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


def render_inventory(directory: Path) -> list[int]:
    result = []
    for item in directory.iterdir():
        if item.is_file() and item.name.startswith("slide-") and item.suffix.lower() == ".png":
            raw = item.stem.removeprefix("slide-")
            if not raw.isdigit() or int(raw) < 1:
                raise ValueError(f"Invalid rendered-slide filename: {item.name}")
            result.append(int(raw))
    return sorted(result)


def layout_part(archive: zipfile.ZipFile, slide_number: int) -> str:
    rel_name = f"ppt/slides/_rels/slide{slide_number}.xml.rels"
    root = ET.fromstring(archive.read(rel_name))
    rel = next(node for node in root.findall("pkg:Relationship", NS) if node.get("Type", "").endswith("/slideLayout"))
    return posixpath.normpath(posixpath.join("ppt/slides", rel.get("Target")))


def related_part(archive: zipfile.ZipFile, owner: str, relationship_suffix: str) -> str:
    directory, filename = posixpath.split(owner)
    rel_name = posixpath.join(directory, "_rels", filename + ".rels")
    root = ET.fromstring(archive.read(rel_name))
    rel = next(node for node in root.findall("pkg:Relationship", NS) if node.get("Type", "").endswith(relationship_suffix))
    return posixpath.normpath(posixpath.join(directory, rel.get("Target")))


def placeholder_key(shape: ET.Element) -> tuple[str, str] | None:
    ph = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    if ph is None:
        return None
    raw_type = ph.get("type", "body")
    normalized_type = {"ctrTitle": "title", "obj": "body"}.get(raw_type, raw_type)
    return normalized_type, ph.get("idx", "0")


def shape_by_name(root: ET.Element, name: str) -> ET.Element | None:
    matches = []
    for shape in root.findall(".//p:sp", NS):
        props = shape.find("p:nvSpPr/p:cNvPr", NS)
        if props is not None and props.get("name") == name:
            matches.append(shape)
    if len(matches) != 1:
        raise ValueError(f"Expected one native shape named {name!r}; found {len(matches)}.")
    return matches[0]


def explicit_box(shape: ET.Element) -> dict | None:
    xfrm = shape.find("p:spPr/a:xfrm", NS)
    off = xfrm.find("a:off", NS) if xfrm is not None else None
    ext = xfrm.find("a:ext", NS) if xfrm is not None else None
    if off is None or ext is None:
        return None
    return {"left": int(off.get("x")), "top": int(off.get("y")), "width": int(ext.get("cx")), "height": int(ext.get("cy"))}


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


def edited_shape_boxes(archive: zipfile.ZipFile, slide_number: int, names: set[str]) -> list[dict]:
    slide = ET.fromstring(archive.read(f"ppt/slides/slide{slide_number}.xml"))
    layout_name = layout_part(archive, slide_number)
    layout = ET.fromstring(archive.read(layout_name))
    master_name = related_part(archive, layout_name, "/slideMaster")
    master = ET.fromstring(archive.read(master_name))
    boxes = []
    for name in sorted(names):
        source_shape = shape_by_name(slide, name)
        box = explicit_box(source_shape)
        key = placeholder_key(source_shape)
        if box is None and key is not None:
            inherited = next((shape for shape in layout.findall(".//p:sp", NS) if placeholder_key(shape) == key), None)
            if inherited is not None:
                box = explicit_box(inherited)
        if box is None and key is not None:
            inherited = next((shape for shape in master.findall(".//p:sp", NS) if placeholder_key(shape) == key), None)
            if inherited is not None:
                box = explicit_box(inherited)
        if box is None:
            raise ValueError(f"Could not resolve explicit or inherited geometry for {name!r} ({key!r}).")
        boxes.append({"shapeName": name, "placeholderKey": key, **box})
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
        target_slide = int(plan["targetSlide"])
        edits = plan.get("edits", [])
        if not edits:
            raise ValueError("Template render comparison requires at least one declared edit.")
        boxes = edited_shape_boxes(archive, target_slide, {edit["shapeName"] for edit in edits})
        slide_count = len(presentation.findall("p:sldIdLst/p:sldId", NS))
    results = []
    preserve_only = {int(value) for value in plan.get("preserveOnlySlides", [])}
    if target_slide < 1 or target_slide > slide_count:
        raise ValueError(f"targetSlide {target_slide} is outside the {slide_count}-slide source deck.")
    if target_slide in preserve_only:
        raise ValueError("targetSlide cannot also be listed in preserveOnlySlides.")
    expected_preserve_only = set(range(1, slide_count + 1)) - {target_slide}
    if preserve_only != expected_preserve_only:
        raise ValueError(f"preserveOnlySlides must declare every non-target slide exactly: {sorted(expected_preserve_only)}")
    expected_inventory = list(range(1, slide_count + 1))
    if render_inventory(source_dir) != expected_inventory or render_inventory(edited_dir) != expected_inventory:
        raise ValueError(f"Both render directories must contain exactly slides {expected_inventory}.")
    for slide_number in range(1, slide_count + 1):
        source = Image.open(source_dir / f"slide-{slide_number}.png").convert("RGB")
        edited = Image.open(edited_dir / f"slide-{slide_number}.png").convert("RGB")
        if edited.size != source.size:
            Image.new("RGB", source.size, "#FF00FF").save(out_dir / f"slide-{slide_number}-diff.png")
            source.save(out_dir / f"slide-{slide_number}-overlay.png")
            results.append({
                "slide": slide_number,
                "valid": False,
                "dimensionsMatch": False,
                "sourceSize": list(source.size),
                "editedSize": list(edited.size),
                "exactPixelMatch": False,
                "outsideEditedMasksSimilarity": 0.0,
                "outsideEditedMasksExact": False,
                "insideEditedMasksChangedFraction": 0.0,
            })
            continue
        source_arr = np.asarray(source, dtype=np.float32)
        edited_arr = np.asarray(edited, dtype=np.float32)
        absolute = np.abs(source_arr - edited_arr)
        mask = np.zeros(source_arr.shape[:2], dtype=bool)
        if slide_number == target_slide:
            for box in boxes:
                left = max(0, round(box["left"] / slide_width * source.width) - 8)
                top = max(0, round(box["top"] / slide_height * source.height) - 8)
                right = min(source.width, round((box["left"] + box["width"]) / slide_width * source.width) + 8)
                bottom = min(source.height, round((box["top"] + box["height"]) / slide_height * source.height) + 8)
                mask[top:bottom, left:right] = True
        outside = absolute[~mask]
        inside = absolute[mask]
        outside_similarity = 1.0 - float(outside.mean()) / 255.0 if outside.size else 1.0
        outside_exact = bool((outside == 0).all()) if outside.size else True
        inside_changed = float((inside.max(axis=1) > 8).mean()) if inside.size else 0.0
        exact = bool((absolute.max(axis=2) == 0).all())
        valid = exact if slide_number in preserve_only else outside_exact and inside_changed > 0.001
        ImageEnhance.Contrast(ImageChops.difference(source, edited)).enhance(3).save(out_dir / f"slide-{slide_number}-diff.png")
        Image.blend(source, edited, 0.5).save(out_dir / f"slide-{slide_number}-overlay.png")
        results.append({"slide": slide_number, "valid": valid, "dimensionsMatch": True, "exactPixelMatch": exact, "outsideEditedMasksSimilarity": round(outside_similarity, 6), "outsideEditedMasksExact": outside_exact, "insideEditedMasksChangedFraction": round(inside_changed, 6)})
    report = {"valid": all(item["valid"] for item in results), "slideCount": slide_count, "editedShapeBoxesEmu": boxes, "slides": results}
    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
