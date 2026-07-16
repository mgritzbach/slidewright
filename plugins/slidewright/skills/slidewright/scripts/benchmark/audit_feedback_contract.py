#!/usr/bin/env python3
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
EMU_PER_PX = 9525


def slide_number(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 10**9


def shape_record(shape):
    identity = shape.find("p:nvSpPr/p:cNvPr", NS)
    xfrm = shape.find("p:spPr/a:xfrm", NS)
    if identity is None or xfrm is None:
        return None
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        return None
    paragraphs = []
    for paragraph in shape.findall("p:txBody/a:p", NS):
        text = "".join(node.text or "" for node in paragraph.findall(".//a:t", NS))
        ppr = paragraph.find("a:pPr", NS)
        bullet = ppr is not None and (ppr.find("a:buChar", NS) is not None or ppr.find("a:buAutoNum", NS) is not None)
        paragraphs.append({"text": text, "bullet": bullet})
    return {
        "name": identity.get("name", ""),
        "x": int(off.get("x", "0")),
        "y": int(off.get("y", "0")),
        "cx": int(ext.get("cx", "0")),
        "cy": int(ext.get("cy", "0")),
        "text": "\n".join(item["text"] for item in paragraphs),
        "paragraphs": paragraphs,
    }


def intersects(a, b):
    return min(a["x"] + a["cx"], b["x"] + b["cx"]) > max(a["x"], b["x"]) and min(a["y"] + a["cy"], b["y"] + b["cy"]) > max(a["y"], b["y"])


def expected_emu(value):
    return round(float(value) * EMU_PER_PX)


def audit(pptx: Path, plan_path: Path):
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    diagnostics = []
    slides = []
    with zipfile.ZipFile(pptx) as archive:
        slide_parts = sorted((name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)), key=slide_number)
        for part in slide_parts:
            root = ET.fromstring(archive.read(part))
            records = [record for record in (shape_record(shape) for shape in root.findall(".//p:sp", NS)) if record]
            slides.append({"part": part, "shapes": records, "byName": {record["name"]: record for record in records}})

    if len(slides) != len(plan.get("slides", [])):
        diagnostics.append({"ruleId": "OOXML_G27", "message": f"Expected {len(plan.get('slides', []))} slides, found {len(slides)}."})

    native_text = 0
    for index, plan_slide in enumerate(plan.get("slides", [])):
        if index >= len(slides):
            continue
        actual = slides[index]
        by_name = actual["byName"]
        text_shapes = [shape for shape in plan_slide.get("shapes", []) if shape.get("type") == "text"]
        native_text += len(text_shapes)
        actual_text = []
        for shape in text_shapes:
            record = by_name.get(shape["id"])
            if record is None:
                diagnostics.append({"ruleId": "OOXML_G24", "slide": index + 1, "shape": shape["id"], "message": "Named native text shape is missing."})
                continue
            actual_text.append(record)
            if not record["text"].strip():
                diagnostics.append({"ruleId": "OOXML_G27", "slide": index + 1, "shape": shape["id"], "message": "Required visible text is empty."})
            for paragraph in record["paragraphs"]:
                if paragraph["bullet"] and not paragraph["text"].replace("\u00a0", "").strip():
                    diagnostics.append({"ruleId": "OOXML_G28", "slide": index + 1, "shape": shape["id"], "message": "Empty bulleted paragraph survived export."})
        for left_index, left in enumerate(actual_text):
            for right in actual_text[left_index + 1:]:
                if intersects(left, right):
                    diagnostics.append({"ruleId": "OOXML_G24", "slide": index + 1, "shape": f"{left['name']}|{right['name']}", "message": "Native text boxes intersect."})

        headline_contract = plan_slide.get("layoutContract", {}).get("headline")
        if headline_contract:
            headline = by_name.get(headline_contract["shapeId"])
            planned_headline = next((shape for shape in plan_slide.get("shapes", []) if shape.get("id") == headline_contract["shapeId"]), None)
            if headline is None or planned_headline is None:
                diagnostics.append({"ruleId": "OOXML_G25", "slide": index + 1, "message": "Headline contract target is missing."})
            else:
                position = planned_headline["position"]
                if headline["x"] != expected_emu(position["left"]) or headline["cx"] != expected_emu(position["width"]):
                    diagnostics.append({"ruleId": "OOXML_G25", "slide": index + 1, "shape": headline["name"], "message": "Headline does not match the exact safe-width geometry."})
                container_id = headline_contract.get("containerId")
                if container_id:
                    container = by_name.get(container_id)
                    planned_container = next((shape for shape in plan_slide.get("shapes", []) if shape.get("id") == container_id), None)
                    padding = planned_container.get("padding", {}) if planned_container else {}
                    if container and (headline["x"] != container["x"] + expected_emu(padding.get("left", 0)) or headline["x"] + headline["cx"] != container["x"] + container["cx"] - expected_emu(padding.get("right", 0))):
                        diagnostics.append({"ruleId": "OOXML_G25", "slide": index + 1, "shape": headline["name"], "message": "Backed headline does not reach both inner safe edges."})

        for split in plan_slide.get("layoutContract", {}).get("structuralSplits", []):
            divider = by_name.get(split["shapeId"])
            planned_divider = next((shape for shape in plan_slide.get("shapes", []) if shape.get("id") == split["shapeId"]), None)
            headline = by_name.get(headline_contract["shapeId"]) if headline_contract else None
            ratio = 0.5 if split.get("ratio") == "center" else 2 / 3 if split.get("ratio") == "two-thirds" else None
            expected_x = expected_emu(plan_slide["frame"]["left"] + plan_slide["frame"]["width"] * ratio) if ratio else None
            if divider is None or planned_divider is None or headline is None or expected_x is None:
                diagnostics.append({"ruleId": "OOXML_G25", "slide": index + 1, "shape": split.get("shapeId"), "message": "Declared structural split is incomplete."})
                continue
            planned_position = planned_divider["position"]
            exact_geometry = (
                divider["x"] == expected_emu(planned_position["left"])
                and divider["y"] == expected_emu(planned_position["top"])
                and divider["cx"] == expected_emu(planned_position["width"])
                and divider["cy"] == expected_emu(planned_position["height"])
                and divider["x"] == expected_x
            )
            safe_edge = headline["x"] + headline["cx"] == divider["x"] if split.get("side") == "left" else headline["x"] == divider["x"] + divider["cx"]
            if not exact_geometry or not safe_edge:
                diagnostics.append({"ruleId": "OOXML_G25", "slide": index + 1, "shape": split["shapeId"], "message": "Headline or structural split does not match the exact declared center/two-thirds safe boundary."})

        for contract in plan_slide.get("layoutContract", {}).get("fitSurfaces", []):
            surface = by_name.get(contract["surfaceId"])
            planned_surface = next((shape for shape in plan_slide.get("shapes", []) if shape.get("id") == contract["surfaceId"]), None)
            children = [by_name.get(child_id) for child_id in contract.get("childIds", [])]
            if surface is None or planned_surface is None or not children or any(child is None for child in children):
                diagnostics.append({"ruleId": "OOXML_G26", "slide": index + 1, "shape": contract["surfaceId"], "message": "Text-backing contract is incomplete."})
                continue
            padding = planned_surface.get("padding", {})
            required_bottom = max(child["y"] + child["cy"] for child in children) + expected_emu(padding.get("bottom", 0))
            minimum_bottom = surface["y"] + expected_emu(contract.get("minHeight", 0))
            if surface["y"] + surface["cy"] != max(required_bottom, minimum_bottom):
                diagnostics.append({"ruleId": "OOXML_G26", "slide": index + 1, "shape": surface["name"], "message": "Text backing does not exactly grow to text plus symmetric padding."})

    topics = plan.get("coverage", {}).get("topics", [])
    previous_divider = -1
    coverage = []
    for topic in topics:
        owned = [(index, slide) for index, slide in enumerate(plan.get("slides", [])) if slide.get("topicId") == topic["id"]]
        dividers = [(index, slide) for index, slide in owned if slide.get("coverageRole") == "divider"]
        substantive = [(index, slide) for index, slide in owned if slide.get("coverageRole") == "substantive"]
        if len(dividers) != 1 or not substantive or (dividers and any(index < dividers[0][0] for index, _ in substantive)) or (dividers and dividers[0][0] <= previous_divider):
            diagnostics.append({"ruleId": "OOXML_G27", "topic": topic["id"], "message": "Topic divider/substantive coverage or order is invalid."})
            continue
        divider_index, divider = dividers[0]
        previous_divider = divider_index
        headline_id = divider.get("layoutContract", {}).get("headline", {}).get("shapeId")
        actual_headline = slides[divider_index]["byName"].get(headline_id) if divider_index < len(slides) else None
        if actual_headline is None or topic["title"].lower().rstrip("?") not in actual_headline["text"].lower().rstrip("?"):
            diagnostics.append({"ruleId": "OOXML_G27", "topic": topic["id"], "message": "Visible native divider title does not cover the declared topic."})
        coverage.append({"topic": topic["id"], "dividerSlide": divider_index + 1, "substantiveSlides": [index + 1 for index, _ in substantive]})

    report = {
        "valid": not diagnostics,
        "pptx": str(pptx),
        "slides": len(slides),
        "expectedSlides": len(plan.get("slides", [])),
        "topics": len(topics),
        "nativeTextShapes": native_text,
        "coverage": coverage,
        "diagnostics": diagnostics,
    }
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()
    report = audit(args.pptx, args.plan)
    encoded = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.write(encoded)
    raise SystemExit(0 if report["valid"] else 1)


if __name__ == "__main__":
    main()
