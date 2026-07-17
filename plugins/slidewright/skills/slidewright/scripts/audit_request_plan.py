#!/usr/bin/env python3
"""Bind a guarded Slidewright request plan to its exported native PowerPoint objects."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P, "a": A}
EMU_PER_PX = 9525


def approx(actual: float, expected: float, tolerance: float = 1.1) -> bool:
    return math.isclose(actual, expected, abs_tol=tolerance)


def shape_name(shape: ET.Element) -> str | None:
    prop = shape.find("p:nvSpPr/p:cNvPr", NS)
    return prop.get("name") if prop is not None else None


def color(node: ET.Element | None) -> str | None:
    if node is None:
        return None
    rgb = node.find(".//a:srgbClr", NS)
    return f"#{rgb.get('val').upper()}" if rgb is not None and rgb.get("val") else None


def fail(report: dict, slide: int | str, element: str, field: str, expected, actual) -> None:
    report["failures"].append({"slide": slide, "element": element, "field": field, "expected": expected, "actual": actual})


def slide_names(archive: zipfile.ZipFile) -> list[str]:
    names = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    return sorted(names, key=lambda name: int(re.search(r"slide(\d+)\.xml$", name).group(1)))


def audit(pptx: Path, plan: dict) -> dict:
    report = {
        "schemaVersion": "slidewright-request-plan-audit/v1",
        "valid": False,
        "slides": 0,
        "expectedObjects": 0,
        "actualObjects": 0,
        "expectedTextObjects": 0,
        "matchedTextObjects": 0,
        "pictures": 0,
        "graphicFrames": 0,
        "failures": [],
    }
    with zipfile.ZipFile(pptx) as archive:
        if len(archive.namelist()) != len(set(archive.namelist())):
            fail(report, "deck", "package", "duplicate-members", 0, len(archive.namelist()) - len(set(archive.namelist())))
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        expected_canvas = plan["canvas"]
        actual_canvas = None if size is None else {"width": round(int(size.get("cx")) / EMU_PER_PX), "height": round(int(size.get("cy")) / EMU_PER_PX)}
        if actual_canvas != expected_canvas:
            fail(report, "deck", "canvas", "size", expected_canvas, actual_canvas)
        names = slide_names(archive)
        if len(names) != len(plan["slides"]):
            fail(report, "deck", "slides", "count", len(plan["slides"]), len(names))
        for index, expected_slide in enumerate(plan["slides"], start=1):
            if index > len(names):
                break
            root = ET.fromstring(archive.read(names[index - 1]))
            report["slides"] += 1
            pictures = root.findall(".//p:pic", NS)
            graphic_frames = root.findall(".//p:graphicFrame", NS)
            report["pictures"] += len(pictures)
            report["graphicFrames"] += len(graphic_frames)
            if pictures:
                fail(report, index, "slide", "pictures", 0, len(pictures))
            if graphic_frames:
                fail(report, index, "slide", "graphic-frames", 0, len(graphic_frames))
            shapes = root.findall("p:cSld/p:spTree/p:sp", NS)
            actual_order = [shape_name(shape) for shape in shapes]
            expected_order = [shape["id"] for shape in expected_slide["shapes"]]
            report["expectedObjects"] += len(expected_order)
            report["actualObjects"] += len(actual_order)
            if actual_order != expected_order:
                fail(report, index, "slide", "object-names-and-order", expected_order, actual_order)
            actual_by_name = {shape_name(shape): shape for shape in shapes if shape_name(shape)}
            for expected in expected_slide["shapes"]:
                shape = actual_by_name.get(expected["id"])
                if shape is None:
                    fail(report, index, expected["id"], "exists", True, False)
                    continue
                xfrm = shape.find("p:spPr/a:xfrm", NS)
                off = xfrm.find("a:off", NS) if xfrm is not None else None
                ext = xfrm.find("a:ext", NS) if xfrm is not None else None
                actual_position = None if off is None or ext is None else {
                    "left": int(off.get("x")) / EMU_PER_PX,
                    "top": int(off.get("y")) / EMU_PER_PX,
                    "width": int(ext.get("cx")) / EMU_PER_PX,
                    "height": int(ext.get("cy")) / EMU_PER_PX,
                }
                if actual_position is None:
                    fail(report, index, expected["id"], "position", expected["position"], None)
                else:
                    for field in ("left", "top", "width", "height"):
                        if not approx(actual_position[field], expected["position"][field]):
                            fail(report, index, expected["id"], field, expected["position"][field], round(actual_position[field], 3))
                if expected["type"] != "text":
                    if shape.findall(".//a:t", NS):
                        fail(report, index, expected["id"], "unexpected-text", 0, len(shape.findall(".//a:t", NS)))
                    continue
                report["expectedTextObjects"] += 1
                actual_text = "".join(node.text or "" for node in shape.findall(".//a:t", NS))
                expected_text = "".join(run["text"] for run in expected["text"]["runs"])
                if actual_text != expected_text:
                    fail(report, index, expected["id"], "text", expected_text, actual_text)
                else:
                    report["matchedTextObjects"] += 1
                body = shape.find("p:txBody/a:bodyPr", NS)
                if body is None or body.get("wrap") != "square" or body.find("a:noAutofit", NS) is None:
                    fail(report, index, expected["id"], "fit-mode", "wrap=square,noAutofit", ET.tostring(body, encoding="unicode") if body is not None else None)
                run_nodes = shape.findall("p:txBody/a:p/a:r", NS)
                expected_runs = expected["text"]["runs"]
                if len(run_nodes) != len(expected_runs):
                    fail(report, index, expected["id"], "run-count", len(expected_runs), len(run_nodes))
                for run_index, expected_run in enumerate(expected_runs):
                    if run_index >= len(run_nodes):
                        break
                    props = run_nodes[run_index].find("a:rPr", NS)
                    if props is None:
                        fail(report, index, expected["id"], f"run-{run_index}-properties", "present", None)
                        continue
                    raw_size = props.get("sz")
                    actual_size = int(raw_size) / 100 if raw_size and raw_size.isdigit() else None
                    if actual_size != expected["style"]["fontSizePt"]:
                        fail(report, index, expected["id"], f"run-{run_index}-size", expected["style"]["fontSizePt"], actual_size)
                    actual_bold = props.get("b", "0") in {"1", "true"}
                    if actual_bold != bool(expected_run.get("bold", False)):
                        fail(report, index, expected["id"], f"run-{run_index}-bold", bool(expected_run.get("bold", False)), actual_bold)
                    actual_italic = props.get("i", "0") in {"1", "true"}
                    if actual_italic != bool(expected_run.get("italic", False)):
                        fail(report, index, expected["id"], f"run-{run_index}-italic", bool(expected_run.get("italic", False)), actual_italic)
                    latin = props.find("a:latin", NS)
                    actual_face = latin.get("typeface") if latin is not None else None
                    if actual_face != expected["style"]["typeface"]:
                        fail(report, index, expected["id"], f"run-{run_index}-typeface", expected["style"]["typeface"], actual_face)
                    expected_color = (expected_run.get("color") or expected["style"]["color"]).upper()
                    actual_color = color(props)
                    if actual_color != expected_color:
                        fail(report, index, expected["id"], f"run-{run_index}-color", expected_color, actual_color)
    report["valid"] = (
        not report["failures"]
        and report["slides"] == len(plan["slides"])
        and report["expectedObjects"] == report["actualObjects"]
        and report["expectedTextObjects"] == report["matchedTextObjects"]
        and report["pictures"] == 0
        and report["graphicFrames"] == 0
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--json", required=True, dest="json_path", type=Path)
    args = parser.parse_args()
    report = audit(args.pptx, json.loads(args.plan.read_text(encoding="utf-8-sig")))
    args.json_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(report, indent=2) + "\n"
    args.json_path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
