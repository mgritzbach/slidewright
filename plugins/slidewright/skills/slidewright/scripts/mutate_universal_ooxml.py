#!/usr/bin/env python3
"""Create isolated OOXML mutants for the universal design-contract benchmark."""

from __future__ import annotations

import argparse
from pathlib import Path
import zipfile
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P, "a": A}


def shape_name(shape: ET.Element) -> str | None:
    prop = shape.find("p:nvSpPr/p:cNvPr", NS)
    return prop.get("name") if prop is not None else None


def graphic_name(frame: ET.Element) -> str | None:
    prop = frame.find("p:nvGraphicFramePr/p:cNvPr", NS)
    return prop.get("name") if prop is not None else None


def mutate(parts: dict[str, bytes], mutation: str) -> None:
    roots = {name: ET.fromstring(data) for name, data in parts.items() if name.startswith("ppt/slides/slide") and name.endswith(".xml")}
    changed = False
    for name, root in roots.items():
        if mutation == "asymmetric-text-inset":
            for shape in root.findall("p:cSld/p:spTree/p:sp", NS):
                if shape_name(shape) == "s1-title":
                    shape.find("p:txBody/a:bodyPr", NS).set("rIns", "76200")
                    changed = True
        elif mutation == "paragraph-spacing-drift":
            for shape in root.findall("p:cSld/p:spTree/p:sp", NS):
                if shape_name(shape) == "s1-body":
                    spacing = shape.find("p:txBody/a:p/a:pPr/a:spcAft/a:spcPts", NS)
                    if spacing is None:
                        raise ValueError("Expected native paragraph spacing was not found.")
                    spacing.set("val", "800")
                    changed = True
        elif mutation == "asymmetric-table-inset":
            for frame in root.findall("p:cSld/p:spTree/p:graphicFrame", NS):
                if graphic_name(frame) == "s4-table":
                    rows = frame.findall(".//a:tbl/a:tr", NS)
                    cell_props = rows[1].findall("a:tc", NS)[0].find("a:tcPr", NS)
                    cell_props.set("marR", "114300")
                    changed = True
        elif mutation == "semantic-icon-metadata-loss":
            for shape in root.findall("p:cSld/p:spTree/p:sp", NS):
                if shape_name(shape) == "s5-goal-icon":
                    prop = shape.find("p:nvSpPr/p:cNvPr", NS)
                    prop.attrib.pop("descr", None)
                    changed = True
        elif mutation == "backing-geometry-drift":
            for shape in root.findall("p:cSld/p:spTree/p:sp", NS):
                if shape_name(shape) == "s1-callout-surface":
                    extent = shape.find("p:spPr/a:xfrm/a:ext", NS)
                    # Shrink past the 32px backing inset so native text visibly
                    # escapes the surface, not merely its plan-bound geometry.
                    extent.set("cx", str(int(extent.get("cx")) - 381000))
                    changed = True
        elif mutation == "repeated-component-style-drift":
            for shape in root.findall("p:cSld/p:spTree/p:sp", NS):
                if shape_name(shape) == "s3-left-heading":
                    color = shape.find("p:txBody/a:p/a:r/a:rPr/a:solidFill/a:srgbClr", NS)
                    color.set("val", "FF0000")
                    changed = True
        elif mutation == "headline-size-drift":
            for shape in root.findall("p:cSld/p:spTree/p:sp", NS):
                if shape_name(shape) == "s3-title":
                    run = shape.find("p:txBody/a:p/a:r/a:rPr", NS)
                    run.set("sz", "4000")
                    changed = True
        if changed:
            parts[name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            break
    if not changed:
        raise ValueError(f"Mutation target was not found for {mutation}.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("mutation", choices=[
        "asymmetric-text-inset",
        "paragraph-spacing-drift",
        "asymmetric-table-inset",
        "semantic-icon-metadata-loss",
        "backing-geometry-drift",
        "repeated-component-style-drift",
        "headline-size-drift",
    ])
    args = parser.parse_args()
    with zipfile.ZipFile(args.source) as source:
        parts = {item.filename: source.read(item.filename) for item in source.infolist() if not item.is_dir()}
    mutate(parts, args.mutation)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED) as target:
        for name in sorted(parts):
            target.writestr(name, parts[name])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
