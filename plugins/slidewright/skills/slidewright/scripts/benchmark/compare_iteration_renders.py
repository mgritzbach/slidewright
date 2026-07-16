#!/usr/bin/env python3
"""Require render drift to stay inside exported OOXML object bounds."""

import argparse
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
SHAPE_PATHS = {
    "sp": ("p:nvSpPr/p:cNvPr", "p:spPr/a:xfrm"),
    "grpSp": ("p:nvGrpSpPr/p:cNvPr", "p:grpSpPr/a:xfrm"),
    "pic": ("p:nvPicPr/p:cNvPr", "p:spPr/a:xfrm"),
    "graphicFrame": ("p:nvGraphicFramePr/p:cNvPr", "p:xfrm"),
    "cxnSp": ("p:nvCxnSpPr/p:cNvPr", "p:spPr/a:xfrm"),
}


def slide_size(archive):
    root = ET.fromstring(archive.read("ppt/presentation.xml"))
    size = root.find("p:sldSz", NS)
    return int(size.attrib["cx"]), int(size.attrib["cy"])


def exported_bounds(pptx: Path):
    result = {}
    with zipfile.ZipFile(pptx) as archive:
        canvas = slide_size(archive)
        slide_names = sorted(
            (name for name in archive.namelist() if name.startswith("ppt/slides/slide") and name.endswith(".xml")),
            key=lambda name: int(Path(name).stem.removeprefix("slide")),
        )
        for slide_number, slide_name in enumerate(slide_names, 1):
            root = ET.fromstring(archive.read(slide_name))
            tree = root.find("p:cSld/p:spTree", NS)
            for node in list(tree):
                local = node.tag.rsplit("}", 1)[-1]
                paths = SHAPE_PATHS.get(local)
                if not paths:
                    continue
                name_node = node.find(paths[0], NS)
                xfrm = node.find(paths[1], NS)
                if name_node is None or xfrm is None:
                    continue
                off = xfrm.find("a:off", NS)
                ext = xfrm.find("a:ext", NS)
                if off is None or ext is None:
                    continue
                result[name_node.attrib["name"]] = {
                    "slide": slide_number,
                    "bboxEmu": [int(off.attrib["x"]), int(off.attrib["y"]), int(ext.attrib["cx"]), int(ext.attrib["cy"])],
                }
    return canvas, result


def png_path(folder: Path, slide_number: int):
    candidates = [folder / f"slide-{slide_number}.png", folder / f"slide-{slide_number:02d}.png"]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"No rendered PNG for slide {slide_number} in {folder}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline_pptx")
    parser.add_argument("variant_pptx")
    parser.add_argument("baseline_render_dir")
    parser.add_argument("variant_render_dir")
    parser.add_argument("--mask-ids", required=True)
    parser.add_argument("--json", required=True)
    parser.add_argument("--padding", type=int, default=6)
    args = parser.parse_args()

    mask_ids = sorted(identifier for identifier in args.mask_ids.split(",") if identifier)
    canvas_before, before = exported_bounds(Path(args.baseline_pptx))
    canvas_after, after = exported_bounds(Path(args.variant_pptx))
    if canvas_before != canvas_after:
        raise ValueError("Slide sizes differ.")
    missing = [identifier for identifier in mask_ids if identifier not in before or identifier not in after]
    if missing:
        raise ValueError(f"Missing mask objects: {', '.join(missing)}")
    slide_count = max(record["slide"] for record in before.values())
    slides = []
    failures = []
    for slide_number in range(1, slide_count + 1):
        baseline = np.asarray(Image.open(png_path(Path(args.baseline_render_dir), slide_number)).convert("RGB"))
        variant = np.asarray(Image.open(png_path(Path(args.variant_render_dir), slide_number)).convert("RGB"))
        if baseline.shape != variant.shape:
            raise ValueError(f"Slide {slide_number} render sizes differ.")
        height, width = baseline.shape[:2]
        mask = np.zeros((height, width), dtype=bool)
        for identifier in mask_ids:
            for record in [before[identifier], after[identifier]]:
                if record["slide"] != slide_number:
                    continue
                x, y, cx, cy = record["bboxEmu"]
                left = max(0, int(np.floor(x / canvas_before[0] * width)) - args.padding)
                top = max(0, int(np.floor(y / canvas_before[1] * height)) - args.padding)
                right = min(width, int(np.ceil((x + cx) / canvas_before[0] * width)) + args.padding)
                bottom = min(height, int(np.ceil((y + cy) / canvas_before[1] * height)) + args.padding)
                mask[top:bottom, left:right] = True
        changed = np.any(baseline != variant, axis=2)
        inside_changed = int(np.count_nonzero(changed & mask))
        outside_changed = int(np.count_nonzero(changed & ~mask))
        outside_pixels = int(np.count_nonzero(~mask))
        outside_similarity = 1.0 if outside_pixels == 0 else 1.0 - outside_changed / outside_pixels
        has_mask = bool(np.any(mask))
        if outside_changed:
            failures.append(f"Slide {slide_number} has {outside_changed} changed pixels outside exported masks.")
        if has_mask and inside_changed < 25:
            failures.append(f"Slide {slide_number} changed only {inside_changed} pixels inside masks; possible no-op.")
        slides.append({
            "slide": slide_number,
            "hasMask": has_mask,
            "insideChangedPixels": inside_changed,
            "outsideChangedPixels": outside_changed,
            "outsideSimilarity": round(outside_similarity, 8),
        })
    report = {
        "valid": not failures,
        "maskSource": "exported-ooxml-geometry",
        "maskIds": mask_ids,
        "paddingPx": args.padding,
        "slides": slides,
        "failures": failures,
    }
    output = Path(args.json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
