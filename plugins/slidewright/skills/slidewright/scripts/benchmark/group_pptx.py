#!/usr/bin/env python3
"""Wrap each benchmark slide's native objects in a real PowerPoint group."""

from __future__ import annotations

import argparse
import json
import shutil
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


def shape_xfrm(node: ET.Element) -> ET.Element | None:
    for path in ("p:spPr/a:xfrm", "p:pic/p:spPr/a:xfrm", "p:xfrm", "a:xfrm"):
        found = node.find(path, NS)
        if found is not None:
            return found
    return node.find(".//a:xfrm", NS)


def bounds(nodes: list[ET.Element]) -> tuple[int, int, int, int]:
    boxes = []
    for node in nodes:
        xfrm = shape_xfrm(node)
        if xfrm is None:
            continue
        off = xfrm.find("a:off", NS)
        ext = xfrm.find("a:ext", NS)
        if off is None or ext is None:
            continue
        x, y = int(off.get("x", "0")), int(off.get("y", "0"))
        cx, cy = int(ext.get("cx", "0")), int(ext.get("cy", "0"))
        boxes.append((x, y, x + cx, y + cy))
    if not boxes:
        raise ValueError("No shape transforms found for group")
    left = min(item[0] for item in boxes)
    top = min(item[1] for item in boxes)
    right = max(item[2] for item in boxes)
    bottom = max(item[3] for item in boxes)
    return left, top, right - left, bottom - top


def normalize_group_locks(root: ET.Element) -> None:
    for locks in root.findall(".//a:spLocks", NS):
        locks.attrib.pop("noGrp", None)


def group_slide(xml: bytes, group_name: str) -> bytes:
    root = ET.fromstring(xml)
    normalize_group_locks(root)
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError("Slide has no p:spTree")
    candidates = [child for child in list(tree) if child.tag in {q(P, "sp"), q(P, "pic"), q(P, "graphicFrame"), q(P, "cxnSp")}]
    if len(candidates) < 2:
        raise ValueError(f"Expected at least two groupable objects, found {len(candidates)}")
    left, top, width, height = bounds(candidates)
    ids = [int(node.get("id")) for node in root.findall(".//p:cNvPr", NS) if (node.get("id") or "").isdigit()]
    group_id = max(ids, default=1) + 1
    group = ET.Element(q(P, "grpSp"))
    nv = ET.SubElement(group, q(P, "nvGrpSpPr"))
    ET.SubElement(nv, q(P, "cNvPr"), {"id": str(group_id), "name": group_name})
    ET.SubElement(nv, q(P, "cNvGrpSpPr"))
    ET.SubElement(nv, q(P, "nvPr"))
    grp_pr = ET.SubElement(group, q(P, "grpSpPr"))
    xfrm = ET.SubElement(grp_pr, q(A, "xfrm"))
    ET.SubElement(xfrm, q(A, "off"), {"x": str(left), "y": str(top)})
    ET.SubElement(xfrm, q(A, "ext"), {"cx": str(width), "cy": str(height)})
    ET.SubElement(xfrm, q(A, "chOff"), {"x": str(left), "y": str(top)})
    ET.SubElement(xfrm, q(A, "chExt"), {"cx": str(width), "cy": str(height)})
    first_index = min(list(tree).index(node) for node in candidates)
    for node in candidates:
        tree.remove(node)
        group.append(node)
    tree.insert(first_index, group)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--suite", required=True)
    args = parser.parse_args()
    source, output = Path(args.input), Path(args.output)
    suite = json.loads(Path(args.suite).read_text(encoding="utf-8"))
    names = [slide["groupName"] for slide in suite["slides"]]
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        temp = Path(tmp) / "grouped.pptx"
        with zipfile.ZipFile(source, "r") as zin, zipfile.ZipFile(temp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename.startswith("ppt/slides/slide") and item.filename.endswith(".xml"):
                    stem = Path(item.filename).stem
                    index = int(stem.removeprefix("slide")) - 1
                    if 0 <= index < len(names):
                        data = group_slide(data, names[index])
                zout.writestr(item, data)
        shutil.copyfile(temp, output)
    print(f"Grouped {len(names)} slides into {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
