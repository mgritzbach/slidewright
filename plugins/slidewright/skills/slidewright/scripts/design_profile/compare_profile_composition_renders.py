#!/usr/bin/env python3
"""Compare a source-native composition render to its mapped source archetypes.

Only declared placeholder rectangles and dynamic slide-number fields are masked.
Every pixel outside those masks must remain exact, so a compositor cannot obtain
visual credit after drifting source chrome, geometry, imagery, or inheritance.
"""

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
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"p": P, "a": A, "pkg": PKG}


def render_inventory(directory: Path) -> list[int]:
    result: list[int] = []
    for item in directory.iterdir():
        if item.is_file() and item.name.startswith("slide-") and item.suffix.lower() == ".png":
            raw = item.stem.removeprefix("slide-")
            if not raw.isdigit() or int(raw) < 1:
                raise ValueError(f"Invalid rendered-slide filename: {item.name}")
            result.append(int(raw))
    return sorted(result)


def relationship_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    return posixpath.join(directory, "_rels", filename + ".rels")


def related_part(archive: zipfile.ZipFile, owner: str, suffix: str) -> str:
    rels = ET.fromstring(archive.read(relationship_part(owner)))
    rel = next(node for node in rels.findall("pkg:Relationship", NS) if node.get("Type", "").endswith(suffix))
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), rel.get("Target")))


def explicit_box(shape: ET.Element) -> dict[str, int] | None:
    xfrm = shape.find("p:spPr/a:xfrm", NS)
    off = xfrm.find("a:off", NS) if xfrm is not None else None
    ext = xfrm.find("a:ext", NS) if xfrm is not None else None
    if off is None or ext is None:
        return None
    return {
        "left": int(off.get("x")),
        "top": int(off.get("y")),
        "width": int(ext.get("cx")),
        "height": int(ext.get("cy")),
    }


def placeholder_key(shape: ET.Element) -> tuple[str, str] | None:
    placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
    if placeholder is None:
        return None
    raw_type = placeholder.get("type", "body")
    return {"ctrTitle": "title", "obj": "body"}.get(raw_type, raw_type), placeholder.get("idx", "0")


def shape_name(shape: ET.Element) -> str:
    props = shape.find("p:nvSpPr/p:cNvPr", NS)
    return "" if props is None else props.get("name", "")


def source_chain(archive: zipfile.ZipFile, slide_number: int) -> list[tuple[str, ET.Element]]:
    slide_part = f"ppt/slides/slide{slide_number}.xml"
    layout_part = related_part(archive, slide_part, "/slideLayout")
    master_part = related_part(archive, layout_part, "/slideMaster")
    return [(slide_part, ET.fromstring(archive.read(slide_part))),
            (layout_part, ET.fromstring(archive.read(layout_part))),
            (master_part, ET.fromstring(archive.read(master_part)))]


def resolved_named_box(chain: list[tuple[str, ET.Element]], name: str) -> dict[str, int]:
    slide_shape = next((shape for shape in chain[0][1].findall(".//p:sp", NS) if shape_name(shape) == name), None)
    if slide_shape is None:
        raise ValueError(f"Expected one source slide shape named {name!r}.")
    box = explicit_box(slide_shape)
    key = placeholder_key(slide_shape)
    if box is None and key is not None:
        for _, root in chain[1:]:
            inherited = next((shape for shape in root.findall(".//p:sp", NS) if placeholder_key(shape) == key), None)
            if inherited is not None:
                box = explicit_box(inherited)
                if box is not None:
                    break
    if box is None:
        raise ValueError(f"Could not resolve geometry for edited shape {name!r}.")
    return box


def dynamic_field_boxes(chain: list[tuple[str, ET.Element]]) -> list[dict[str, int | str]]:
    result: list[dict[str, int | str]] = []
    for part, root in chain:
        for shape in root.findall(".//p:sp", NS):
            if shape.find(".//a:fld[@type='slidenum']", NS) is None:
                continue
            box = explicit_box(shape)
            if box is not None:
                result.append({"role": "dynamic-slide-number", "part": part, "shapeName": shape_name(shape), **box})
    return result


def pixel_box(box: dict, image: Image.Image, slide_width: int, slide_height: int, padding: int = 10) -> tuple[int, int, int, int]:
    left = max(0, round(box["left"] / slide_width * image.width) - padding)
    top = max(0, round(box["top"] / slide_height * image.height) - padding)
    right = min(image.width, round((box["left"] + box["width"]) / slide_width * image.width) + padding)
    bottom = min(image.height, round((box["top"] + box["height"]) / slide_height * image.height) + padding)
    if right <= left or bottom <= top:
        raise ValueError(f"Mask has empty pixel geometry: {box}")
    return left, top, right, bottom


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source_pptx")
    parser.add_argument("plan")
    parser.add_argument("source_renders")
    parser.add_argument("composition_renders")
    parser.add_argument("--json", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    if plan.get("mode") != "compose-source-archetypes" or plan.get("derivationVersion") != "g22-v2":
        raise ValueError("Mapped visual comparison requires a g22-v2 composition plan.")
    slides = plan.get("slides", [])
    if [item.get("outputSlide") for item in slides] != list(range(1, len(slides) + 1)):
        raise ValueError("Composition plan output slides must be contiguous and ordered.")

    source_dir = Path(args.source_renders)
    composition_dir = Path(args.composition_renders)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    expected_source = list(range(1, int(plan["sourceSlideCount"]) + 1))
    expected_output = list(range(1, int(plan["outputSlideCount"]) + 1))
    if render_inventory(source_dir) != expected_source:
        raise ValueError(f"Source render inventory must be exactly {expected_source}.")
    if render_inventory(composition_dir) != expected_output:
        raise ValueError(f"Composition render inventory must be exactly {expected_output}.")

    with zipfile.ZipFile(args.source_pptx) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        slide_width, slide_height = int(size.get("cx")), int(size.get("cy"))
        chains = {int(item["sourceSlide"]): source_chain(archive, int(item["sourceSlide"])) for item in slides}

    results: list[dict] = []
    for item in slides:
        output_slide = int(item["outputSlide"])
        source_slide = int(item["sourceSlide"])
        source_image = Image.open(source_dir / f"slide-{source_slide}.png").convert("RGB")
        output_image = Image.open(composition_dir / f"slide-{output_slide}.png").convert("RGB")
        if output_image.size != source_image.size:
            raise ValueError(f"Slide {output_slide} dimensions differ from mapped source slide {source_slide}.")
        masks: list[dict] = []
        for edit in item.get("edits", []):
            masks.append({"role": "declared-placeholder-edit", "shapeName": edit["shapeName"],
                          **resolved_named_box(chains[source_slide], edit["shapeName"])})
        masks.extend(dynamic_field_boxes(chains[source_slide]))

        source_arr = np.asarray(source_image, dtype=np.float32)
        output_arr = np.asarray(output_image, dtype=np.float32)
        absolute = np.abs(source_arr - output_arr)
        union = np.zeros(source_arr.shape[:2], dtype=bool)
        edit_results = []
        for mask_record in masks:
            left, top, right, bottom = pixel_box(mask_record, source_image, slide_width, slide_height)
            region = absolute[top:bottom, left:right]
            changed_fraction = float((region.max(axis=2) > 8).mean())
            union[top:bottom, left:right] = True
            record = {**mask_record, "pixelBox": [left, top, right, bottom], "changedFraction": round(changed_fraction, 6)}
            if mask_record["role"] == "declared-placeholder-edit":
                record["valid"] = changed_fraction > 0.001
                edit_results.append(record)

        outside = absolute[~union]
        outside_exact = bool((outside == 0).all()) if outside.size else True
        outside_similarity = 1.0 - float(outside.mean()) / 255.0 if outside.size else 1.0
        valid = outside_exact and bool(edit_results) and all(record["valid"] for record in edit_results)
        ImageEnhance.Contrast(ImageChops.difference(source_image, output_image)).enhance(3).save(out_dir / f"slide-{output_slide}-diff.png")
        Image.blend(source_image, output_image, 0.5).save(out_dir / f"slide-{output_slide}-overlay.png")
        results.append({
            "outputSlide": output_slide,
            "sourceSlide": source_slide,
            "valid": valid,
            "dimensionsMatch": True,
            "outsideDeclaredMasksExact": outside_exact,
            "outsideDeclaredMasksSimilarity": round(outside_similarity, 6),
            "declaredEdits": edit_results,
            "dynamicFieldMaskCount": sum(mask["role"] == "dynamic-slide-number" for mask in masks),
        })

    report = {
        "schemaVersion": "slidewright-profile-composition-visual-audit/v1",
        "valid": all(item["valid"] for item in results),
        "comparisonPolicy": "exact pixels outside declared placeholder and dynamic slide-number masks",
        "sourceSlideCount": len(expected_source),
        "outputSlideCount": len(expected_output),
        "slides": results,
    }
    destination = Path(args.json)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
