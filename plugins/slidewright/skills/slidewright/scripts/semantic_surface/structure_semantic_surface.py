#!/usr/bin/env python3
"""Apply stable names and a real nested PowerPoint group to the semantic suite."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P, "a": A}
ET.register_namespace("a", A)
ET.register_namespace("p", P)


def q(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}"


def nonvisual(node: ET.Element) -> ET.Element | None:
    for candidate in (
        "p:nvSpPr/p:cNvPr",
        "p:nvPicPr/p:cNvPr",
        "p:nvGraphicFramePr/p:cNvPr",
        "p:nvCxnSpPr/p:cNvPr",
        "p:nvGrpSpPr/p:cNvPr",
    ):
        found = node.find(candidate, NS)
        if found is not None:
            return found
    return None


def object_name(node: ET.Element) -> str:
    item = nonvisual(node)
    return item.get("name", "") if item is not None else ""


def set_name(node: ET.Element, name: str) -> None:
    item = nonvisual(node)
    if item is None:
        raise ValueError(f"Could not name {node.tag}")
    item.set("name", name)


def transform(node: ET.Element) -> ET.Element | None:
    if node.tag == q(P, "grpSp"):
        return node.find("p:grpSpPr/a:xfrm", NS)
    for path in ("p:spPr/a:xfrm", "p:spPr/a:xfrm", "p:xfrm"):
        found = node.find(path, NS)
        if found is not None:
            return found
    return node.find(".//a:xfrm", NS)


def bounds(nodes: list[ET.Element]) -> tuple[int, int, int, int]:
    boxes: list[tuple[int, int, int, int]] = []
    for node in nodes:
        xfrm = transform(node)
        if xfrm is None:
            continue
        off = xfrm.find("a:off", NS)
        ext = xfrm.find("a:ext", NS)
        if off is None or ext is None:
            continue
        x, y = int(off.get("x", "0")), int(off.get("y", "0"))
        width, height = int(ext.get("cx", "0")), int(ext.get("cy", "0"))
        boxes.append((x, y, x + width, y + height))
    if not boxes:
        raise ValueError("No transforms found for requested group")
    left = min(item[0] for item in boxes)
    top = min(item[1] for item in boxes)
    right = max(item[2] for item in boxes)
    bottom = max(item[3] for item in boxes)
    return left, top, right - left, bottom - top


def next_id(root: ET.Element) -> int:
    values = [int(item.get("id")) for item in root.findall(".//p:cNvPr", NS) if (item.get("id") or "").isdigit()]
    return max(values, default=1) + 1


def create_group(root: ET.Element, parent: ET.Element, names: list[str], group_name: str) -> ET.Element:
    children = list(parent)
    selected = [child for child in children if object_name(child) in names]
    if [object_name(child) for child in selected] != names:
        raise ValueError(f"Could not find group members in order for {group_name}: {[object_name(child) for child in selected]}")
    left, top, width, height = bounds(selected)
    group = ET.Element(q(P, "grpSp"))
    nv = ET.SubElement(group, q(P, "nvGrpSpPr"))
    ET.SubElement(nv, q(P, "cNvPr"), {"id": str(next_id(root)), "name": group_name})
    ET.SubElement(nv, q(P, "cNvGrpSpPr"))
    ET.SubElement(nv, q(P, "nvPr"))
    props = ET.SubElement(group, q(P, "grpSpPr"))
    xfrm = ET.SubElement(props, q(A, "xfrm"))
    ET.SubElement(xfrm, q(A, "off"), {"x": str(left), "y": str(top)})
    ET.SubElement(xfrm, q(A, "ext"), {"cx": str(width), "cy": str(height)})
    ET.SubElement(xfrm, q(A, "chOff"), {"x": str(left), "y": str(top)})
    ET.SubElement(xfrm, q(A, "chExt"), {"cx": str(width), "cy": str(height)})
    insert_at = min(children.index(child) for child in selected)
    for child in selected:
        parent.remove(child)
        group.append(child)
    parent.insert(insert_at, group)
    return group


def ordered_nodes(tree: ET.Element, tag: str) -> list[ET.Element]:
    return [child for child in list(tree) if child.tag == q(P, tag)]


def structure_slide(index: int, xml: bytes, image_alt: str) -> bytes:
    root = ET.fromstring(xml)
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError(f"Slide {index} has no shape tree")
    if index == 1:
        inner = create_group(root, tree, ["surface-01-metric-value", "surface-01-metric-label"], "surface-01-metric-group")
        create_group(root, tree, ["surface-01-card-bg", object_name(inner), "surface-01-status-pill", "surface-01-status-text"], "surface-01-card-group")
    elif index == 2:
        frames = ordered_nodes(tree, "graphicFrame")
        if len(frames) != 2:
            raise ValueError(f"Slide 2 expected two charts, found {len(frames)}")
        for node, name in zip(frames, ["surface-02-bar-chart", "surface-02-column-chart"], strict=True):
            set_name(node, name)
    elif index == 3:
        frames = ordered_nodes(tree, "graphicFrame")
        if len(frames) != 1:
            raise ValueError(f"Slide 3 expected one table, found {len(frames)}")
        set_name(frames[0], "surface-03-table")
    elif index == 4:
        connectors = ordered_nodes(tree, "cxnSp")
        pictures = ordered_nodes(tree, "pic")
        if len(connectors) != 2 or len(pictures) != 1:
            raise ValueError(f"Slide 4 expected two connectors and one image, found {len(connectors)} and {len(pictures)}")
        for node, name in zip(connectors, ["surface-04-connector-a", "surface-04-connector-b"], strict=True):
            set_name(node, name)
        set_name(pictures[0], "surface-04-reference-image")
        picture_properties = nonvisual(pictures[0])
        if picture_properties is None:
            raise ValueError("Slide 4 image has no non-visual properties")
        picture_properties.set("descr", image_alt)
        picture_properties.set("title", "Declared visual reference")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--contract", default="fixtures/semantic-surface/v1/semantic-contract.json")
    args = parser.parse_args()
    source = Path(args.input).resolve()
    output = Path(args.output).resolve()
    contract = json.loads(Path(args.contract).read_text(encoding="utf-8"))
    image_alt = next(slide["image"]["alt"] for slide in contract["slides"] if "image" in slide)
    output.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=".semantic-surface-", suffix=".pptx", dir=output.parent)
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(source) as zin, zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename.startswith("ppt/slides/slide") and item.filename.endswith(".xml"):
                    index = int(Path(item.filename).stem.removeprefix("slide"))
                    if 1 <= index <= 4:
                        data = structure_slide(index, data, image_alt)
                zout.writestr(item, data)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Structured semantic surface: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
