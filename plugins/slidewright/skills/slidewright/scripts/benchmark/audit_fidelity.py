#!/usr/bin/env python3
"""Forensic OOXML audit for the owned Slidewright fidelity suite."""

from __future__ import annotations

import argparse
import json
import math
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P, "a": A}
EMU_PER_PX = 9525


def approx(actual: float, expected: float, tolerance: float = 1.1) -> bool:
    return math.isclose(actual, expected, abs_tol=tolerance)


def color(node: ET.Element | None) -> str | None:
    if node is None:
        return None
    rgb = node.find(".//a:srgbClr", NS)
    return f"#{rgb.get('val').upper()}" if rgb is not None and rgb.get("val") else None


def shape_name(shape: ET.Element) -> str | None:
    prop = shape.find("p:nvSpPr/p:cNvPr", NS)
    return prop.get("name") if prop is not None else None


def fail(report: dict, slide: str, element: str, field: str, expected, actual) -> None:
    report["failures"].append({"slide": slide, "element": element, "field": field, "expected": expected, "actual": actual})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx")
    parser.add_argument("suite")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    suite = json.loads(Path(args.suite).read_text(encoding="utf-8"))
    report = {"valid": True, "slides": 0, "elements": 0, "groups": 0, "pictures": 0, "failures": []}
    with zipfile.ZipFile(args.pptx) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        if size is None:
            fail(report, "deck", "canvas", "size", suite["canvas"], None)
        else:
            actual_size = {"width": round(int(size.get("cx")) / EMU_PER_PX), "height": round(int(size.get("cy")) / EMU_PER_PX)}
            if actual_size != suite["canvas"]:
                fail(report, "deck", "canvas", "size", suite["canvas"], actual_size)
        for index, expected_slide in enumerate(suite["slides"], start=1):
            root = ET.fromstring(archive.read(f"ppt/slides/slide{index}.xml"))
            report["slides"] += 1
            groups = root.findall(".//p:grpSp", NS)
            pictures = root.findall(".//p:pic", NS)
            report["groups"] += len(groups)
            report["pictures"] += len(pictures)
            group_names = [node.get("name") for node in root.findall(".//p:nvGrpSpPr/p:cNvPr", NS)]
            target_group = next((group for group in groups if (group.find("p:nvGrpSpPr/p:cNvPr", NS) is not None and group.find("p:nvGrpSpPr/p:cNvPr", NS).get("name") == expected_slide["groupName"])), None)
            if expected_slide["groupName"] not in group_names:
                fail(report, expected_slide["id"], "group", "name", expected_slide["groupName"], group_names)
            if target_group is not None:
                actual_members = [shape_name(child) for child in list(target_group) if child.tag == f"{{{P}}}sp"]
                expected_members = [element["id"] for element in expected_slide["elements"]]
                if actual_members != expected_members:
                    fail(report, expected_slide["id"], "group", "members-and-z-order", expected_members, actual_members)
                if target_group.findall(".//a:grpSpLocks[@noUngrp='1']", NS):
                    fail(report, expected_slide["id"], "group", "ungroup-locks", 0, len(target_group.findall(".//a:grpSpLocks[@noUngrp='1']", NS)))
                positions = [element["position"] for element in expected_slide["elements"]]
                left = min(position["left"] for position in positions)
                top = min(position["top"] for position in positions)
                right = max(position["left"] + position["width"] for position in positions)
                bottom = max(position["top"] + position["height"] for position in positions)
                expected_bounds = {"left": left, "top": top, "width": right - left, "height": bottom - top}
                group_xfrm = target_group.find("p:grpSpPr/a:xfrm", NS)
                for prefix in ("", "ch"):
                    off_name = "chOff" if prefix else "off"
                    ext_name = "chExt" if prefix else "ext"
                    off = group_xfrm.find(f"a:{off_name}", NS) if group_xfrm is not None else None
                    ext = group_xfrm.find(f"a:{ext_name}", NS) if group_xfrm is not None else None
                    actual_bounds = None if off is None or ext is None else {"left": int(off.get("x")) / EMU_PER_PX, "top": int(off.get("y")) / EMU_PER_PX, "width": int(ext.get("cx")) / EMU_PER_PX, "height": int(ext.get("cy")) / EMU_PER_PX}
                    if actual_bounds is None or any(not approx(actual_bounds[field], expected_bounds[field]) for field in expected_bounds):
                        fail(report, expected_slide["id"], "group", f"{prefix or 'outer'}-bounds", expected_bounds, actual_bounds)
            if pictures:
                fail(report, expected_slide["id"], "deck", "native-only", 0, len(pictures))
            shapes = {shape_name(shape): shape for shape in root.findall(".//p:sp", NS) if shape_name(shape)}
            for expected in expected_slide["elements"]:
                report["elements"] += 1
                shape = shapes.get(expected["id"])
                if shape is None:
                    fail(report, expected_slide["id"], expected["id"], "exists", True, False)
                    continue
                xfrm = shape.find("p:spPr/a:xfrm", NS)
                off = xfrm.find("a:off", NS) if xfrm is not None else None
                ext = xfrm.find("a:ext", NS) if xfrm is not None else None
                if off is None or ext is None:
                    fail(report, expected_slide["id"], expected["id"], "geometry", expected["position"], None)
                else:
                    actual = {"left": int(off.get("x")) / EMU_PER_PX, "top": int(off.get("y")) / EMU_PER_PX, "width": int(ext.get("cx")) / EMU_PER_PX, "height": int(ext.get("cy")) / EMU_PER_PX}
                    for field in ("left", "top", "width", "height"):
                        if not approx(actual[field], expected["position"][field]):
                            fail(report, expected_slide["id"], expected["id"], field, expected["position"][field], round(actual[field], 3))
                    expected_rot = expected["position"].get("rotation", 0)
                    actual_rot = int(xfrm.get("rot", "0")) / 60000
                    if not approx(actual_rot, expected_rot, 0.01):
                        fail(report, expected_slide["id"], expected["id"], "rotation", expected_rot, actual_rot)
                if expected["type"] == "shape":
                    actual_fill = color(shape.find("p:spPr/a:solidFill", NS))
                    if expected["fill"] != "none" and actual_fill != expected["fill"].upper():
                        fail(report, expected_slide["id"], expected["id"], "fill", expected["fill"], actual_fill)
                    line = shape.find("p:spPr/a:ln", NS)
                    actual_line_width = int(line.get("w", "0")) / EMU_PER_PX if line is not None else 0
                    if not approx(actual_line_width, expected["line"]["width"]):
                        fail(report, expected_slide["id"], expected["id"], "line-width", expected["line"]["width"], actual_line_width)
                    actual_line_color = color(line)
                    if expected["line"]["color"] != "none" and actual_line_color != expected["line"]["color"].upper():
                        fail(report, expected_slide["id"], expected["id"], "line-color", expected["line"]["color"], actual_line_color)
                    continue
                actual_text = "".join(node.text or "" for node in shape.findall(".//a:t", NS))
                expected_text = "".join(run["text"] for run in expected["text"]["runs"])
                if actual_text != expected_text:
                    fail(report, expected_slide["id"], expected["id"], "text", expected_text, actual_text)
                body = shape.find("p:txBody/a:bodyPr", NS)
                inset_map = {"left": "lIns", "top": "tIns", "right": "rIns", "bottom": "bIns"}
                for field, attr in inset_map.items():
                    actual_inset = int(body.get(attr, "0")) / EMU_PER_PX if body is not None else None
                    if actual_inset is None or not approx(actual_inset, expected["style"]["insets"][field]):
                        fail(report, expected_slide["id"], expected["id"], f"inset-{field}", expected["style"]["insets"][field], actual_inset)
                expected_anchor = {"top": "t", "middle": "ctr", "bottom": "b"}[expected["style"]["verticalAlignment"]]
                actual_anchor = body.get("anchor") if body is not None else None
                if actual_anchor != expected_anchor:
                    fail(report, expected_slide["id"], expected["id"], "vertical-alignment", expected_anchor, actual_anchor)
                if body is None or body.get("wrap") != "square" or body.find("a:noAutofit", NS) is None:
                    fail(report, expected_slide["id"], expected["id"], "fit-contract", "wrap=square,noAutofit", ET.tostring(body, encoding="unicode") if body is not None else None)
                paragraph = shape.find("p:txBody/a:p/a:pPr", NS)
                expected_alignment = {"left": "l", "center": "ctr", "right": "r"}[expected["style"]["alignment"]]
                actual_alignment = paragraph.get("algn") if paragraph is not None else None
                if actual_alignment != expected_alignment:
                    fail(report, expected_slide["id"], expected["id"], "alignment", expected_alignment, actual_alignment)
                spacing = paragraph.find("a:lnSpc/a:spcPct", NS) if paragraph is not None else None
                actual_line_height = int(spacing.get("val", "0")) / 100000 if spacing is not None else None
                if actual_line_height is None or not approx(actual_line_height, expected["style"]["lineHeight"], 0.001):
                    fail(report, expected_slide["id"], expected["id"], "line-height", expected["style"]["lineHeight"], actual_line_height)
                run_nodes = shape.findall("p:txBody/a:p/a:r", NS)
                if len(run_nodes) != len(expected["text"]["runs"]):
                    fail(report, expected_slide["id"], expected["id"], "run-count", len(expected["text"]["runs"]), len(run_nodes))
                for run_index, expected_run in enumerate(expected["text"]["runs"]):
                    if run_index >= len(run_nodes):
                        break
                    props = run_nodes[run_index].find("a:rPr", NS)
                    if props is None:
                        fail(report, expected_slide["id"], expected["id"], f"run-{run_index}-properties", "present", None)
                        continue
                    actual_size = int(props.get("sz", "0")) / 100
                    if actual_size != expected_run["fontSizePt"]:
                        fail(report, expected_slide["id"], expected["id"], f"run-{run_index}-size", expected_run["fontSizePt"], actual_size)
                    actual_bold = props.get("b", "0") in {"1", "true"}
                    if actual_bold != bool(expected_run.get("bold", False)):
                        fail(report, expected_slide["id"], expected["id"], f"run-{run_index}-bold", bool(expected_run.get("bold", False)), actual_bold)
                    actual_italic = props.get("i", "0") in {"1", "true"}
                    if actual_italic != bool(expected_run.get("italic", False)):
                        fail(report, expected_slide["id"], expected["id"], f"run-{run_index}-italic", bool(expected_run.get("italic", False)), actual_italic)
                    latin = props.find("a:latin", NS)
                    actual_face = latin.get("typeface") if latin is not None else None
                    if actual_face != expected_run["typeface"]:
                        fail(report, expected_slide["id"], expected["id"], f"run-{run_index}-typeface", expected_run["typeface"], actual_face)
                    actual_color = color(props)
                    if actual_color != expected_run["color"].upper():
                        fail(report, expected_slide["id"], expected["id"], f"run-{run_index}-color", expected_run["color"], actual_color)
            if root.findall(".//a:spLocks[@noGrp='1']", NS):
                fail(report, expected_slide["id"], "deck", "group-locks", 0, len(root.findall(".//a:spLocks[@noGrp='1']", NS)))
    report["valid"] = not report["failures"] and report["groups"] == len(suite["slides"]) and report["pictures"] == 0
    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("valid", "slides", "elements", "groups", "pictures")}, indent=2))
    if report["failures"]:
        print(f"Failures: {len(report['failures'])}; see {args.json}")
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
