#!/usr/bin/env python3
"""Audit an observed-design reconstruction as native, editable OOXML."""

from __future__ import annotations

import argparse
import hashlib
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
    if prop is None:
        prop = shape.find("p:nvCxnSpPr/p:cNvPr", NS)
    return prop.get("name") if prop is not None else None


def fail(report: dict, element: str, field: str, expected, actual) -> None:
    report["failures"].append({"element": element, "field": field, "expected": expected, "actual": actual})


def split_expected_runs(text: dict) -> list[dict]:
    result = []
    for run in text["runs"]:
        for part in run["text"].split("\n"):
            if part:
                result.append({**run, "text": part})
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx")
    parser.add_argument("design")
    parser.add_argument("source_png")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    design = json.loads(Path(args.design).read_text(encoding="utf-8"))
    source_hash = hashlib.sha256(Path(args.source_png).read_bytes()).hexdigest()
    report = {
        "valid": True,
        "objects": 0,
        "nativeTextObjects": 0,
        "nativeShapeObjects": 0,
        "pictures": 0,
        "mediaParts": 0,
        "sourceRasterEmbedded": False,
        "groupLocks": 0,
        "failures": [],
    }
    with zipfile.ZipFile(args.pptx) as archive:
        names = archive.namelist()
        media = [name for name in names if name.startswith("ppt/media/") and not name.endswith("/")]
        report["mediaParts"] = len(media)
        report["sourceRasterEmbedded"] = any(hashlib.sha256(archive.read(name)).hexdigest() == source_hash for name in media)
        if report["sourceRasterEmbedded"]:
            fail(report, "deck", "source-raster-embedded", False, True)
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        expected_canvas = design["canvas"]
        actual_canvas = None if size is None else {
            "width": round(int(size.get("cx")) / EMU_PER_PX),
            "height": round(int(size.get("cy")) / EMU_PER_PX),
        }
        if actual_canvas != {"width": expected_canvas["width"], "height": expected_canvas["height"]}:
            fail(report, "deck", "canvas", expected_canvas, actual_canvas)
        root = ET.fromstring(archive.read("ppt/slides/slide1.xml"))
        pictures = root.findall(".//p:pic", NS)
        report["pictures"] = len(pictures)
        if pictures:
            fail(report, "deck", "pictures", 0, len(pictures))
        locks = root.findall(".//a:spLocks[@noGrp='1']", NS) + root.findall(".//a:grpSpLocks[@noUngrp='1']", NS)
        report["groupLocks"] = len(locks)
        if locks:
            fail(report, "deck", "group-locks", 0, len(locks))
        sp_tree = root.find(".//p:spTree", NS)
        native_nodes = [] if sp_tree is None else [node for node in list(sp_tree) if node.tag in {f"{{{P}}}sp", f"{{{P}}}cxnSp"}]
        actual_order = [shape_name(node) for node in native_nodes]
        expected_order = [obj["id"] for obj in sorted(design["objects"], key=lambda item: item["zIndex"])]
        if actual_order != expected_order:
            fail(report, "deck", "z-order", expected_order, actual_order)
        shapes = {shape_name(node): node for node in native_nodes if shape_name(node)}
        for expected in design["objects"]:
            report["objects"] += 1
            shape = shapes.get(expected["id"])
            if shape is None:
                fail(report, expected["id"], "exists", True, False)
                continue
            xfrm = shape.find("p:spPr/a:xfrm", NS)
            off = xfrm.find("a:off", NS) if xfrm is not None else None
            ext = xfrm.find("a:ext", NS) if xfrm is not None else None
            bbox = expected["bbox"]
            expected_position = {
                "left": bbox["left"] * expected_canvas["width"],
                "top": bbox["top"] * expected_canvas["height"],
                "width": bbox["width"] * expected_canvas["width"],
                "height": bbox["height"] * expected_canvas["height"],
            }
            actual_position = None if off is None or ext is None else {
                "left": int(off.get("x")) / EMU_PER_PX,
                "top": int(off.get("y")) / EMU_PER_PX,
                "width": int(ext.get("cx")) / EMU_PER_PX,
                "height": int(ext.get("cy")) / EMU_PER_PX,
            }
            if actual_position is None:
                fail(report, expected["id"], "geometry", expected_position, None)
            else:
                for field in expected_position:
                    if not approx(actual_position[field], expected_position[field]):
                        fail(report, expected["id"], field, round(expected_position[field], 3), round(actual_position[field], 3))
            if expected["type"] == "shape":
                report["nativeShapeObjects"] += 1
                expected_fill = expected["shape"]["fill"]
                actual_fill = color(shape.find("p:spPr/a:solidFill", NS))
                if expected_fill != "none" and actual_fill != expected_fill.upper():
                    fail(report, expected["id"], "fill", expected_fill, actual_fill)
                continue
            report["nativeTextObjects"] += 1
            paragraphs = shape.findall("p:txBody/a:p", NS)
            actual_text = "\n".join("".join(node.text or "" for node in paragraph.findall(".//a:t", NS)) for paragraph in paragraphs)
            if actual_text != expected["text"]["value"]:
                fail(report, expected["id"], "text", expected["text"]["value"], actual_text)
            body = shape.find("p:txBody/a:bodyPr", NS)
            if body is None or body.get("wrap") != "square" or body.find("a:noAutofit", NS) is None:
                fail(report, expected["id"], "fit-contract", "wrap=square,noAutofit", None if body is None else ET.tostring(body, encoding="unicode"))
            run_nodes = shape.findall("p:txBody/a:p/a:r", NS)
            expected_runs = split_expected_runs(expected["text"])
            if len(run_nodes) != len(expected_runs):
                fail(report, expected["id"], "run-count", len(expected_runs), len(run_nodes))
            for index, expected_run in enumerate(expected_runs[:len(run_nodes)]):
                props = run_nodes[index].find("a:rPr", NS)
                if props is None:
                    fail(report, expected["id"], f"run-{index}-properties", True, False)
                    continue
                expected_size = expected_run.get("fontSizePtGuess", expected["text"]["fontSizePtGuess"])
                actual_size = int(props.get("sz", "0")) / 100
                if actual_size != expected_size or not float(actual_size).is_integer():
                    fail(report, expected["id"], f"run-{index}-size", expected_size, actual_size)
                latin = props.find("a:latin", NS)
                actual_face = latin.get("typeface") if latin is not None else None
                expected_face = expected_run.get("fontFamilyGuess", expected["text"]["fontFamilyGuess"])
                if actual_face != expected_face:
                    fail(report, expected["id"], f"run-{index}-font", expected_face, actual_face)
                expected_color = expected_run.get("color", expected["text"]["color"])
                if color(props) != expected_color.upper():
                    fail(report, expected["id"], f"run-{index}-color", expected_color, color(props))
                expected_bold = bool(expected_run.get("bold", expected["text"].get("bold", False)))
                actual_bold = props.get("b", "0") in {"1", "true"}
                if actual_bold != expected_bold:
                    fail(report, expected["id"], f"run-{index}-bold", expected_bold, actual_bold)
    if report["nativeTextObjects"] < 3:
        fail(report, "deck", "minimum-native-text", ">=3", report["nativeTextObjects"])
    if report["nativeShapeObjects"] < 2:
        fail(report, "deck", "minimum-native-shapes", ">=2", report["nativeShapeObjects"])
    report["valid"] = not report["failures"]
    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("valid", "objects", "nativeTextObjects", "nativeShapeObjects", "pictures", "mediaParts", "sourceRasterEmbedded")}, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
