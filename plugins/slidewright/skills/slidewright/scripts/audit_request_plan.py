#!/usr/bin/env python3
"""Bind a guarded Slidewright request plan to its exported native PowerPoint objects."""

from __future__ import annotations

import argparse
import base64
import hashlib
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


def graphic_name(frame: ET.Element) -> str | None:
    prop = frame.find("p:nvGraphicFramePr/p:cNvPr", NS)
    return prop.get("name") if prop is not None else None


def semantic_payload(shape: ET.Element) -> dict | None:
    prop = shape.find("p:nvSpPr/p:cNvPr", NS)
    description = prop.get("descr", "") if prop is not None else ""
    prefix = "slidewright-chart:v1:"
    if not description.startswith(prefix):
        return None
    try:
        encoded, digest = description[len(prefix):].rsplit(":", 1)
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        if hashlib.sha256(raw).hexdigest() != digest:
            return None
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


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
        "schemaVersion": "slidewright-request-plan-audit/v3",
        "valid": False,
        "slides": 0,
        "expectedObjects": 0,
        "actualObjects": 0,
        "expectedTextObjects": 0,
        "matchedTextObjects": 0,
        "expectedParagraphs": 0,
        "matchedParagraphs": 0,
        "expectedTables": 0,
        "matchedTables": 0,
        "expectedSemanticIcons": 0,
        "matchedSemanticIcons": 0,
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
            shapes = root.findall("p:cSld/p:spTree/p:sp", NS)
            shape_tree = root.find("p:cSld/p:spTree", NS)
            object_nodes = list(shape_tree) if shape_tree is not None else []
            actual_order = []
            for node in object_nodes:
                if node.tag == f"{{{P}}}sp":
                    actual_order.append(shape_name(node))
                elif node.tag == f"{{{P}}}graphicFrame":
                    actual_order.append(graphic_name(node))
            expected_order = [shape["id"] for shape in expected_slide["shapes"]]
            report["expectedObjects"] += len(expected_order)
            report["actualObjects"] += len(actual_order)
            if actual_order != expected_order:
                fail(report, index, "slide", "object-names-and-order", expected_order, actual_order)
            actual_by_name = {shape_name(shape): shape for shape in shapes if shape_name(shape)}
            actual_tables_by_name = {graphic_name(frame): frame for frame in graphic_frames if graphic_name(frame)}
            for expected in expected_slide["shapes"]:
                shape = actual_tables_by_name.get(expected["id"]) if expected["type"] == "table" else actual_by_name.get(expected["id"])
                if shape is None:
                    fail(report, index, expected["id"], "exists", True, False)
                    continue
                xfrm = shape.find("p:xfrm", NS) if expected["type"] == "table" else shape.find("p:spPr/a:xfrm", NS)
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
                if expected["type"] == "table":
                    report["expectedTables"] += 1
                    before_failures = len(report["failures"])
                    expected_values = expected["table"]["values"]
                    row_nodes = shape.findall(".//a:tbl/a:tr", NS)
                    actual_values = [["".join(text.text or "" for text in cell.findall(".//a:t", NS)) for cell in row.findall("a:tc", NS)] for row in row_nodes]
                    if actual_values != expected_values:
                        fail(report, index, expected["id"], "table-values", expected_values, actual_values)
                    for row_index, row in enumerate(row_nodes):
                        style_name = "header" if row_index < int(expected["table"].get("headerRows", 1)) else "body"
                        style = expected["table"]["styles"][style_name]
                        for column_index, cell in enumerate(row.findall("a:tc", NS)):
                            cell_id = f"r{row_index + 1}c{column_index + 1}"
                            props = cell.find("a:tcPr", NS)
                            for side, attribute in {"left": "marL", "right": "marR", "top": "marT", "bottom": "marB"}.items():
                                actual_margin = int(props.get(attribute, "0")) / EMU_PER_PX if props is not None else None
                                if actual_margin is None or not approx(actual_margin, style["insets"][side], 0.01):
                                    fail(report, index, expected["id"], f"{cell_id}-inset-{side}", style["insets"][side], actual_margin)
                            run_props = cell.find("a:txBody/a:p/a:r/a:rPr", NS)
                            raw_size = run_props.get("sz") if run_props is not None else None
                            actual_size = int(raw_size) / 100 if raw_size and raw_size.isdigit() else None
                            if actual_size != style["fontSizePt"]:
                                fail(report, index, expected["id"], f"{cell_id}-size", style["fontSizePt"], actual_size)
                            actual_bold = run_props is not None and run_props.get("b", "0") in {"1", "true"}
                            if actual_bold != bool(style["bold"]):
                                fail(report, index, expected["id"], f"{cell_id}-bold", bool(style["bold"]), actual_bold)
                            latin = run_props.find("a:latin", NS) if run_props is not None else None
                            actual_face = latin.get("typeface") if latin is not None else None
                            if actual_face != style["typeface"]:
                                fail(report, index, expected["id"], f"{cell_id}-typeface", style["typeface"], actual_face)
                            actual_color = color(run_props)
                            if actual_color != style["color"].upper():
                                fail(report, index, expected["id"], f"{cell_id}-color", style["color"].upper(), actual_color)
                    if len(report["failures"]) == before_failures:
                        report["matchedTables"] += 1
                    continue
                if expected["type"] != "text":
                    if shape.findall(".//a:t", NS):
                        fail(report, index, expected["id"], "unexpected-text", 0, len(shape.findall(".//a:t", NS)))
                    continue
                report["expectedTextObjects"] += 1
                if expected.get("semanticType") == "icon":
                    report["expectedSemanticIcons"] += 1
                    payload = semantic_payload(shape)
                    binding = expected.get("semanticBinding", {})
                    expected_payload = {
                        "kind": "semantic-icon",
                        "representation": expected.get("icon", {}).get("representation"),
                        "icon": expected.get("icon", {}).get("name"),
                        "conceptId": binding.get("conceptId"),
                        "labelId": binding.get("labelId"),
                        "decorative": binding.get("decorative"),
                    }
                    if payload != expected_payload:
                        fail(report, index, expected["id"], "semantic-icon-metadata", expected_payload, payload)
                    else:
                        report["matchedSemanticIcons"] += 1
                expected_paragraphs = expected["text"].get("paragraphs") or [{"runs": expected["text"]["runs"], "bullet": False, "level": 0, "spaceBeforePt": 0, "spaceAfterPt": 0}]
                paragraph_nodes = shape.findall("p:txBody/a:p", NS)
                actual_text = ["".join(node.text or "" for node in paragraph.findall(".//a:t", NS)) for paragraph in paragraph_nodes]
                expected_text = [
                    ("  " * int(paragraph.get("level", 0)) + "\u2022 " if paragraph.get("bullet") else "")
                    + "".join(run["text"] for run in paragraph.get("runs", []))
                    for paragraph in expected_paragraphs
                ]
                if actual_text != expected_text:
                    fail(report, index, expected["id"], "paragraph-text", expected_text, actual_text)
                else:
                    report["matchedTextObjects"] += 1
                body = shape.find("p:txBody/a:bodyPr", NS)
                if body is None or body.get("wrap") != "square" or body.find("a:noAutofit", NS) is None:
                    fail(report, index, expected["id"], "fit-mode", "wrap=square,noAutofit", ET.tostring(body, encoding="unicode") if body is not None else None)
                expected_insets = expected["style"].get("insets", {"left": 0, "top": 0, "right": 0, "bottom": 0})
                inset_attributes = {"left": "lIns", "top": "tIns", "right": "rIns", "bottom": "bIns"}
                for side, attribute in inset_attributes.items():
                    actual_inset = int(body.get(attribute, "0")) / EMU_PER_PX if body is not None else None
                    if actual_inset is None or not approx(actual_inset, expected_insets.get(side, 0), 0.01):
                        fail(report, index, expected["id"], f"inset-{side}", expected_insets.get(side, 0), actual_inset)
                report["expectedParagraphs"] += len(expected_paragraphs)
                if len(paragraph_nodes) != len(expected_paragraphs):
                    fail(report, index, expected["id"], "paragraph-count", len(expected_paragraphs), len(paragraph_nodes))
                expected_runs = []
                for paragraph_index, expected_paragraph in enumerate(expected_paragraphs):
                    prefix = []
                    if expected_paragraph.get("bullet"):
                        prefix = [{"text": "  " * int(expected_paragraph.get("level", 0)) + "\u2022 ", "bold": False, "italic": False}]
                    expected_runs.extend(prefix + expected_paragraph.get("runs", []))
                    if paragraph_index >= len(paragraph_nodes):
                        continue
                    paragraph_node = paragraph_nodes[paragraph_index]
                    props = paragraph_node.find("a:pPr", NS)
                    before = props.find("a:spcBef/a:spcPts", NS) if props is not None else None
                    after = props.find("a:spcAft/a:spcPts", NS) if props is not None else None
                    actual_before = int(before.get("val", "0")) / 100 if before is not None else 0
                    actual_after = int(after.get("val", "0")) / 100 if after is not None else 0
                    expected_before = expected_paragraph.get("spaceBeforePt", 0)
                    expected_after = expected_paragraph.get("spaceAfterPt", 0)
                    if actual_before != expected_before:
                        fail(report, index, expected["id"], f"paragraph-{paragraph_index}-space-before", expected_before, actual_before)
                    if actual_after != expected_after:
                        fail(report, index, expected["id"], f"paragraph-{paragraph_index}-space-after", expected_after, actual_after)
                    if actual_before == expected_before and actual_after == expected_after:
                        report["matchedParagraphs"] += 1
                run_nodes = shape.findall("p:txBody/a:p/a:r", NS)
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
        and report["expectedParagraphs"] == report["matchedParagraphs"]
        and report["pictures"] == 0
        and report["graphicFrames"] == report["expectedTables"] == report["matchedTables"]
        and report["expectedSemanticIcons"] == report["matchedSemanticIcons"]
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
