#!/usr/bin/env python3
"""Audit C18 native-object mutations and measure source-bound chart renders."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from PIL import Image

import audit_semantic_surface as surface


EMU_PER_POINT = 12700.0
NS = surface.NS
EXPECTED_SCHEMA = "slidewright-semantic-mutation/v1"
REPORT_SCHEMA = "slidewright-semantic-mutation-audit/v1"
RENDER_SCHEMA = "slidewright-semantic-mutation-render-evidence/v1"
VOLATILE_PART_CONTENT = {
    "docProps/app.xml",
    "docProps/core.xml",
    "ppt/presProps.xml",
    "ppt/viewProps.xml",
}
DASH_STYLE_TO_OOXML = {4: "dash", 5: "dashDot"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object.")
    return value


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def canonical_xml_bytes(value: bytes | ET.Element) -> bytes:
    """Return namespace/attribute canonical XML while preserving child order."""

    if isinstance(value, ET.Element):
        xml = ET.tostring(value, encoding="unicode")
    else:
        xml = value.decode("utf-8-sig")
    return ET.canonicalize(xml_data=xml).encode("utf-8")


def canonical_element_sha256(element: ET.Element) -> str:
    return hashlib.sha256(canonical_xml_bytes(element)).hexdigest()


def canonical_part_sha256(name: str, value: bytes) -> str:
    if name.lower().endswith((".xml", ".rels")) or name == "[Content_Types].xml":
        try:
            value = canonical_xml_bytes(value)
        except (ET.ParseError, UnicodeDecodeError, ValueError):
            pass
    return hashlib.sha256(value).hexdigest()


def fail(code: str, message: str, *, slide: int | None = None, object_name: str | None = None,
         expected: Any = None, actual: Any = None) -> dict[str, Any]:
    item: dict[str, Any] = {"code": code, "message": message}
    if slide is not None:
        item["slide"] = slide
    if object_name is not None:
        item["object"] = object_name
    if expected is not None:
        item["expected"] = expected
    if actual is not None:
        item["actual"] = actual
    return item


def qname(namespace: str, name: str) -> str:
    return f"{{{NS[namespace]}}}{name}"


def first_xfrm(element: ET.Element) -> ET.Element | None:
    for candidate in (
        element.find("p:spPr/a:xfrm", NS),
        element.find("p:grpSpPr/a:xfrm", NS),
        element.find("p:xfrm", NS),
    ):
        if candidate is not None:
            return candidate
    return None


def geometry(element: ET.Element) -> dict[str, int]:
    xfrm = first_xfrm(element)
    off = xfrm.find("a:off", NS) if xfrm is not None else None
    ext = xfrm.find("a:ext", NS) if xfrm is not None else None
    return {
        "x": int(off.get("x", "0")) if off is not None else 0,
        "y": int(off.get("y", "0")) if off is not None else 0,
        "cx": int(ext.get("cx", "0")) if ext is not None else 0,
        "cy": int(ext.get("cy", "0")) if ext is not None else 0,
    }


def rgb_from_fill(parent: ET.Element | None, default: str | None = None) -> str | None:
    if parent is None:
        return default
    node = parent.find("a:solidFill/a:srgbClr", NS)
    return node.get("val", "").upper() if node is not None and node.get("val") else default


def rgb_tuple(value: str) -> tuple[int, int, int]:
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]


def luminance(value: str) -> float:
    channels = []
    for channel in rgb_tuple(value):
        scaled = channel / 255.0
        channels.append(scaled / 12.92 if scaled <= 0.04045 else ((scaled + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def contrast(a: str, b: str) -> float:
    light, dark = sorted((luminance(a), luminance(b)), reverse=True)
    return (light + 0.05) / (dark + 0.05)


def chart_details(parts: dict[str, bytes], record: dict[str, Any]) -> dict[str, Any]:
    semantics = surface.chart_semantics(parts, record)
    target = record.get("relationshipTarget")
    if not isinstance(target, str) or target not in parts:
        return {"native": False, "semantics": semantics, "fontPoints": [], "seriesColors": [], "textColors": []}
    try:
        root = ET.fromstring(parts[target])
    except ET.ParseError:
        return {"native": False, "semantics": semantics, "fontPoints": [], "seriesColors": [], "textColors": []}
    sizes = [int(node.get("sz", "0")) / 100.0 for node in root.findall(".//*[@sz]") if node.get("sz", "").isdigit()]
    colors: list[str] = []
    for series in root.findall(".//c:ser", NS):
        color = rgb_from_fill(series.find("c:spPr", NS))
        if color:
            colors.append(color)
    text_colors = [node.get("val", "").upper() for node in root.findall(".//a:rPr/a:solidFill/a:srgbClr", NS) + root.findall(".//a:defRPr/a:solidFill/a:srgbClr", NS) if node.get("val")]
    return {
        "native": record.get("partExists") is True and record.get("relationshipExternal") is False,
        "semantics": semantics,
        "fontPoints": sizes,
        "seriesColors": colors,
        "textColors": text_colors,
    }


def table_details(element: ET.Element) -> dict[str, Any]:
    table = element.find("a:graphic/a:graphicData/a:tbl", NS)
    if table is None:
        return {"native": False, "rows": 0, "columns": 0, "cells": []}
    rows = table.findall("a:tr", NS)
    grid = table.find("a:tblGrid", NS)
    column_widths = [int(node.get("w", "0")) for node in grid.findall("a:gridCol", NS)] if grid is not None else []
    cells: list[dict[str, Any]] = []
    for row_index, row in enumerate(rows, start=1):
        row_height = int(row.get("h", "0"))
        for column_index, cell in enumerate(row.findall("a:tc", NS), start=1):
            props = cell.find("a:tcPr", NS)
            body = cell.find("a:txBody/a:bodyPr", NS)
            sizes = [int(node.get("sz", "0")) / 100.0 for node in cell.findall(".//*[@sz]") if node.get("sz", "").isdigit()]
            text = "".join(node.text or "" for node in cell.findall(".//a:t", NS))
            margins = {
                "left": int(props.get("marL", "0")) if props is not None else 0,
                "right": int(props.get("marR", "0")) if props is not None else 0,
                "top": int(props.get("marT", "0")) if props is not None else 0,
                "bottom": int(props.get("marB", "0")) if props is not None else 0,
            }
            fill = rgb_from_fill(props, "FFFFFF")
            text_colors = [node.get("val", "").upper() for node in cell.findall(".//a:rPr/a:solidFill/a:srgbClr", NS) if node.get("val")]
            width = column_widths[column_index - 1] if column_index <= len(column_widths) else 0
            available_width_points = max(0.0, (width - margins["left"] - margins["right"]) / EMU_PER_POINT)
            available_height_points = max(0.0, (row_height - margins["top"] - margins["bottom"]) / EMU_PER_POINT)
            font_points = min(sizes) if sizes else None
            wrap = body.get("wrap", "square") if body is not None else "square"
            average_glyph_width = (font_points or 0.0) * 0.55
            raw_lines = text.splitlines() or [""]
            if wrap == "none" or average_glyph_width <= 0 or available_width_points <= 0:
                estimated_lines = len(raw_lines)
                estimated_width = max((len(line) * average_glyph_width for line in raw_lines), default=0.0)
            else:
                characters_per_line = max(1, int(available_width_points / average_glyph_width))
                estimated_lines = sum(max(1, math.ceil(len(line) / characters_per_line)) for line in raw_lines)
                estimated_width = min(
                    available_width_points,
                    max((min(len(line), characters_per_line) * average_glyph_width for line in raw_lines), default=0.0),
                )
            estimated_height = estimated_lines * (font_points or 0.0) * 1.2
            cells.append({
                "row": row_index,
                "column": column_index,
                "text": text,
                "fontPoints": font_points,
                "margins": margins,
                "fill": fill,
                "textColors": text_colors,
                "widthPoints": width / EMU_PER_POINT,
                "heightPoints": row_height / EMU_PER_POINT,
                "availableWidthPoints": available_width_points,
                "availableHeightPoints": available_height_points,
                "wrap": wrap,
                "estimatedBoundWidthPoints": estimated_width,
                "estimatedBoundHeightPoints": estimated_height,
                "staticFits": (
                    font_points is not None
                    and estimated_width <= available_width_points + 0.5
                    and estimated_height <= available_height_points + 0.5
                ),
            })
    return {"native": True, "rows": len(rows), "columns": max((len(row.findall("a:tc", NS)) for row in rows), default=0), "cells": cells}


def line_details(element: ET.Element) -> dict[str, Any]:
    line = element.find("p:spPr/a:ln", NS)
    dash = line.find("a:prstDash", NS) if line is not None else None
    return {
        "weightPoints": int(line.get("w", "0")) / EMU_PER_POINT if line is not None else 0.0,
        "dash": dash.get("val") if dash is not None else None,
        "color": rgb_from_fill(line),
    }


def package_inventory(pptx: Path) -> tuple[dict[str, dict[str, Any]], dict[int, str], list[dict[str, Any]]]:
    parts, package_failures = surface.load_package_parts(pptx)
    inventory: dict[str, dict[str, Any]] = {}
    notes: dict[int, str] = {}
    if package_failures:
        return inventory, notes, package_failures
    slide_numbers = sorted(int(path.rsplit("slide", 1)[1].split(".xml", 1)[0]) for path in parts if path.startswith("ppt/slides/slide") and path.endswith(".xml"))
    for slide_number in slide_numbers:
        slide_part = f"ppt/slides/slide{slide_number}.xml"
        try:
            root = ET.fromstring(parts[slide_part])
        except ET.ParseError as error:
            package_failures.append(fail("SM001", f"Invalid slide XML: {error}", slide=slide_number))
            continue
        records, names_by_id = surface.enumerate_objects(root)
        elements = [record["_element"] for record in records]
        surface.enrich_objects(parts, slide_part, records, names_by_id)
        for record, element in zip(records, elements):
            name = record.get("name", "")
            item: dict[str, Any] = {
                "slide": slide_number,
                "name": name,
                "type": record.get("type"),
                "groupPath": record.get("groupPath", []),
                "zOrder": record.get("zOrder"),
                "geometry": geometry(element),
                "rawCanonicalSha256": canonical_element_sha256(element),
            }
            kind = item["type"]
            if kind == "shape":
                text = surface.shape_text(element)
                item["text"] = text
                item["textSha256"] = stable_hash(text)
            elif kind == "group":
                item["childCount"] = record.get("childCount")
            elif kind == "chart":
                item["chart"] = chart_details(parts, record)
                item["relationshipTarget"] = record.get("relationshipTarget")
                target = record.get("relationshipTarget")
                item["chartPartCanonicalSha256"] = canonical_part_sha256(target, parts[target]) if isinstance(target, str) and target in parts else None
            elif kind == "table":
                item["table"] = table_details(element)
            elif kind == "connector":
                item["from"] = (record.get("from") or {}).get("name")
                item["to"] = (record.get("to") or {}).get("name")
                item["fromSite"] = (record.get("from") or {}).get("idx")
                item["toSite"] = (record.get("to") or {}).get("idx")
                item["line"] = line_details(element)
            elif kind == "image":
                item["mediaSha256"] = record.get("mediaSha256")
                item["alt"] = record.get("alt")
            if name in inventory:
                package_failures.append(fail("SM001", "Object name is not globally unique.", slide=slide_number, object_name=name))
            inventory[name] = item
        notes_text, notes_error = surface.slide_notes(parts, slide_part)
        if notes_error:
            package_failures.append(fail("SM001", notes_error, slide=slide_number))
        notes[slide_number] = notes_text
    return inventory, notes, package_failures


def semantic_signature(item: dict[str, Any]) -> str:
    return stable_hash(item)


def named_elements(root: ET.Element, name: str) -> list[ET.Element]:
    return [element for element in root.iter() if element.tag in surface.OBJECT_TAGS and surface.object_name(element) == name]


def require_named_element(root: ET.Element, name: str) -> ET.Element:
    matches = named_elements(root, name)
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one object named {name!r}; found {len(matches)}.")
    return matches[0]


def mask_transform_position(element: ET.Element) -> None:
    xfrm = first_xfrm(element)
    if xfrm is None:
        raise ValueError(f"Object {surface.object_name(element)!r} has no transform to mask.")
    off = xfrm.find("a:off", NS)
    if off is None:
        raise ValueError(f"Object {surface.object_name(element)!r} has no position to mask.")
    off.set("x", "0")
    off.set("y", "0")


def mask_transform_geometry(element: ET.Element) -> None:
    xfrm = first_xfrm(element)
    if xfrm is None:
        raise ValueError(f"Object {surface.object_name(element)!r} has no transform to mask.")
    for attribute in ("flipH", "flipV"):
        xfrm.attrib.pop(attribute, None)
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        raise ValueError(f"Object {surface.object_name(element)!r} has an incomplete transform.")
    off.set("x", "0")
    off.set("y", "0")
    ext.set("cx", "0")
    ext.set("cy", "0")


def normalized_slide_part(value: bytes, mutation_case: dict[str, Any]) -> bytes:
    root = ET.fromstring(value)
    operation = mutation_case.get("operation")
    target = str(mutation_case.get("target", ""))
    if operation == "replace-table-cell":
        frame = require_named_element(root, target)
        table = frame.find("a:graphic/a:graphicData/a:tbl", NS)
        if table is None:
            raise ValueError("Declared table target has no native table XML.")
        cell_spec = mutation_case["cell"]
        rows = table.findall("a:tr", NS)
        row_index = int(cell_spec["row"]) - 1
        column_index = int(cell_spec["column"]) - 1
        if row_index not in range(len(rows)):
            raise ValueError("Declared table row is outside the native table.")
        cells = rows[row_index].findall("a:tc", NS)
        if column_index not in range(len(cells)):
            raise ValueError("Declared table column is outside the native table.")
        texts = cells[column_index].findall("a:txBody/a:p//a:t", NS)
        if not texts:
            raise ValueError("Declared table cell has no native text leaf.")
        for index, text in enumerate(texts):
            text.text = f"__SLIDEWRIGHT_DECLARED_TABLE_TEXT_{index}__"
    elif operation == "move-diagram-node":
        for name in [target, *mutation_case.get("moveWithTarget", [])]:
            mask_transform_position(require_named_element(root, str(name)))
        for name in mutation_case.get("attachedConnectors", []):
            mask_transform_geometry(require_named_element(root, str(name)))
    elif operation == "edit-connector-style":
        connector = require_named_element(root, target)
        line = connector.find("p:spPr/a:ln", NS)
        if line is None:
            raise ValueError("Declared connector target has no native line properties.")
        line.set("w", "0")
        for dash in line.findall("a:prstDash", NS):
            line.remove(dash)
        ET.SubElement(line, qname("a", "prstDash"), {"val": "__SLIDEWRIGHT_DECLARED_DASH__"})
    elif operation != "replace-chart-data":
        raise ValueError(f"Unsupported mutation operation {operation!r} while normalizing the slide.")
    return canonical_xml_bytes(root)


def normalized_chart_part(value: bytes) -> bytes:
    root = ET.fromstring(value)
    chart = root.find(".//c:barChart", NS)
    series = chart.findall("c:ser", NS) if chart is not None else []
    if len(series) != 1:
        raise ValueError(f"Controlled chart mutation requires exactly one series; found {len(series)}.")
    for tag in ("tx", "cat", "val"):
        node = series[0].find(f"c:{tag}", NS)
        if node is None:
            raise ValueError(f"Controlled chart series is missing c:{tag}.")
        node.clear()
        node.set("slidewrightMask", tag)
    return canonical_xml_bytes(root)


def compare_operation_closure(
    baseline_parts: dict[str, bytes],
    variant_parts: dict[str, bytes],
    baseline_inventory: dict[str, dict[str, Any]],
    variant_inventory: dict[str, dict[str, Any]],
    mutation_case: dict[str, Any],
) -> dict[str, Any]:
    """Compare every package part after masking only operation-declared leaves."""

    baseline_names = set(baseline_parts)
    variant_names = set(variant_parts)
    differences: list[dict[str, Any]] = []
    if baseline_names != variant_names:
        differences.append({
            "part": "<package-inventory>",
            "missing": sorted(baseline_names - variant_names),
            "added": sorted(variant_names - baseline_names),
        })
    target_slide = int(mutation_case["slide"])
    slide_part = f"ppt/slides/slide{target_slide}.xml"
    operation = mutation_case.get("operation")
    target = str(mutation_case.get("target", ""))
    baseline_chart_part = (baseline_inventory.get(target) or {}).get("relationshipTarget") if operation == "replace-chart-data" else None
    variant_chart_part = (variant_inventory.get(target) or {}).get("relationshipTarget") if operation == "replace-chart-data" else None
    if operation == "replace-chart-data" and baseline_chart_part != variant_chart_part:
        differences.append({"part": "<chart-relationship-target>", "baseline": baseline_chart_part, "variant": variant_chart_part})

    baseline_signatures: dict[str, str] = {}
    variant_signatures: dict[str, str] = {}
    for name in sorted(baseline_names & variant_names):
        try:
            if name in VOLATILE_PART_CONTENT:
                continue
            if name == slide_part:
                baseline_value = normalized_slide_part(baseline_parts[name], mutation_case)
                variant_value = normalized_slide_part(variant_parts[name], mutation_case)
                baseline_hash = hashlib.sha256(baseline_value).hexdigest()
                variant_hash = hashlib.sha256(variant_value).hexdigest()
            elif operation == "replace-chart-data" and name == baseline_chart_part == variant_chart_part:
                baseline_hash = hashlib.sha256(normalized_chart_part(baseline_parts[name])).hexdigest()
                variant_hash = hashlib.sha256(normalized_chart_part(variant_parts[name])).hexdigest()
            else:
                baseline_hash = canonical_part_sha256(name, baseline_parts[name])
                variant_hash = canonical_part_sha256(name, variant_parts[name])
            baseline_signatures[name] = baseline_hash
            variant_signatures[name] = variant_hash
            if baseline_hash != variant_hash:
                differences.append({"part": name, "baseline": baseline_hash, "variant": variant_hash})
        except (ET.ParseError, UnicodeDecodeError, ValueError, KeyError, TypeError) as error:
            differences.append({"part": name, "error": str(error)})
    return {
        "valid": not differences,
        "protectedPartCount": len(baseline_signatures),
        "excludedVolatileContent": sorted(VOLATILE_PART_CONTENT),
        "baselineSignature": stable_hash(baseline_signatures),
        "variantSignature": stable_hash(variant_signatures),
        "differences": differences,
    }


def rect(item: dict[str, Any]) -> tuple[float, float, float, float]:
    geo = item["geometry"]
    return tuple(float(geo[key]) / EMU_PER_POINT for key in ("x", "y", "cx", "cy"))  # type: ignore[return-value]


def inside(inner: tuple[float, float, float, float], outer: tuple[float, float, float, float], tolerance: float = 0.75) -> bool:
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    return ix >= ox - tolerance and iy >= oy - tolerance and ix + iw <= ox + ow + tolerance and iy + ih <= oy + oh + tolerance


def overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float], tolerance: float = 0.5) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return min(ax + aw, bx + bw) - max(ax, bx) > tolerance and min(ay + ah, by + bh) - max(ay, by) > tolerance


def powerpoint_label_checks(
    labels: Any, expected_values: list[Any], width_points: float, height_points: float,
) -> tuple[bool, bool, bool, list[tuple[float, float, float, float]]]:
    if not isinstance(labels, list) or len(labels) != len(expected_values) or not labels:
        return False, False, False, []
    boxes: list[tuple[float, float, float, float]] = []
    text_matches = True
    for index, label in enumerate(labels, start=1):
        required = ("index", "text", "leftPoints", "topPoints", "widthPoints", "heightPoints")
        if not isinstance(label, dict) or not all(key in label for key in required):
            return False, False, False, []
        numeric = [label.get(key) for key in ("leftPoints", "topPoints", "widthPoints", "heightPoints")]
        if label.get("index") != index or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in numeric):
            return False, False, False, []
        text_matches = text_matches and str(label.get("text", "")).strip() == str(expected_values[index - 1])
        boxes.append(tuple(float(value) for value in numeric))
    in_bounds = all(
        left >= -0.75 and top >= -0.75 and width > 0 and height > 0
        and left + width <= width_points + 0.75 and top + height <= height_points + 0.75
        for left, top, width, height in boxes
    )
    no_overlap = all(not overlaps(a, b, tolerance=0.5) for index, a in enumerate(boxes) for b in boxes[index + 1:])
    return in_bounds, no_overlap, text_matches, boxes


def segment_intersects_rect(start: tuple[float, float], end: tuple[float, float], box: tuple[float, float, float, float]) -> bool:
    x, y, width, height = box
    left, right, top, bottom = x, x + width, y, y + height
    if left < start[0] < right and top < start[1] < bottom:
        return True
    if left < end[0] < right and top < end[1] < bottom:
        return True
    dx, dy = end[0] - start[0], end[1] - start[1]
    for edge, origin, delta, low, high in ((left, start[0], dx, top, bottom), (right, start[0], dx, top, bottom)):
        if abs(delta) > 1e-9:
            t = (edge - origin) / delta
            hit = start[1] + t * dy
            if 0 < t < 1 and low < hit < high:
                return True
    for edge, origin, delta, low, high in ((top, start[1], dy, left, right), (bottom, start[1], dy, left, right)):
        if abs(delta) > 1e-9:
            t = (edge - origin) / delta
            hit = start[0] + t * dx
            if 0 < t < 1 and low < hit < high:
                return True
    return False


def connector_segment(item: dict[str, Any]) -> tuple[tuple[float, float], tuple[float, float]]:
    x, y, width, height = rect(item)
    return (x, y), (x + width, y + height)


def component_boxes(image: Image.Image, box: tuple[int, int, int, int], color: str) -> list[tuple[int, int, int, int]]:
    pixels = image.convert("RGB")
    target = rgb_tuple(color)
    left, top, right, bottom = box
    width, height = right - left, bottom - top
    mask = bytearray(width * height)
    for yy in range(height):
        for xx in range(width):
            value = pixels.getpixel((left + xx, top + yy))
            if sum((value[index] - target[index]) ** 2 for index in range(3)) <= 30 ** 2:
                mask[yy * width + xx] = 1
    found: list[tuple[int, int, int, int]] = []
    for yy in range(height):
        for xx in range(width):
            start = yy * width + xx
            if not mask[start]:
                continue
            stack = [(xx, yy)]
            mask[start] = 0
            min_x = max_x = xx
            min_y = max_y = yy
            count = 0
            while stack:
                cx, cy = stack.pop()
                count += 1
                min_x, max_x = min(min_x, cx), max(max_x, cx)
                min_y, max_y = min(min_y, cy), max(max_y, cy)
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height and mask[ny * width + nx]:
                        mask[ny * width + nx] = 0
                        stack.append((nx, ny))
            if count >= 25:
                found.append((left + min_x, top + min_y, left + max_x + 1, top + max_y + 1))
    return sorted(found, key=lambda item: (item[1], item[0]))


def _measure_render(variant: Path, render_png: Path, case_id: str) -> dict[str, Any]:
    inventory, _, failures = package_inventory(variant)
    image = Image.open(render_png).convert("RGB")
    parts, package_failures = surface.load_package_parts(variant)
    failures.extend(package_failures)
    if failures:
        raise ValueError(f"PowerPoint package failed structural loading: {failures}")
    if "ppt/presentation.xml" not in parts:
        raise ValueError("PowerPoint package has no ppt/presentation.xml part.")
    presentation = ET.fromstring(parts["ppt/presentation.xml"])
    size = presentation.find("p:sldSz", NS)
    if size is None:
        raise ValueError("PowerPoint presentation has no p:sldSz canvas declaration.")
    slide_width = int(size.get("cx", "0"))
    slide_height = int(size.get("cy", "0"))
    if slide_width <= 0 or slide_height <= 0 or image.width <= 0 or image.height <= 0:
        raise ValueError("PowerPoint or render dimensions are not positive.")
    charts: list[dict[str, Any]] = []
    for name in ("surface-02-bar-chart", "surface-02-column-chart"):
        item = inventory.get(name)
        if not item or item.get("type") != "chart":
            failures.append(fail("SM010", "Render measurement requires both native charts.", slide=2, object_name=name))
            continue
        geo = item["geometry"]
        frame = (
            round(geo["x"] * image.width / slide_width),
            round(geo["y"] * image.height / slide_height),
            round((geo["x"] + geo["cx"]) * image.width / slide_width),
            round((geo["y"] + geo["cy"]) * image.height / slide_height),
        )
        if not (0 <= frame[0] < frame[2] <= image.width and 0 <= frame[1] < frame[3] <= image.height):
            failures.append(fail("SM010", "Native chart frame is outside the rendered slide.", slide=2, object_name=name, actual=frame))
            continue
        chart = item["chart"]
        colors = chart.get("seriesColors", [])
        boxes = component_boxes(image, frame, colors[0]) if colors else []
        expected_count = len((chart.get("semantics") or {}).get("categories", []))
        boxes = sorted(boxes, key=lambda box: (box[2] - box[0]) * (box[3] - box[1]), reverse=True)[:expected_count]
        thicknesses = [min(box[2] - box[0], box[3] - box[1]) for box in boxes]
        direction = (chart.get("semantics") or {}).get("direction")
        label_regions: list[tuple[int, int, int, int]] = []
        for mark in boxes:
            if direction == "bar":
                label_regions.append((mark[2], max(frame[1], mark[1] - 8), min(frame[2], mark[2] + 70), min(frame[3], mark[3] + 8)))
            else:
                label_regions.append((max(frame[0], mark[0] - 8), max(frame[1], mark[1] - 36), min(frame[2], mark[2] + 8), mark[1]))
        dark_counts = []
        for region in label_regions:
            dark_counts.append(sum(1 for yy in range(region[1], region[3]) for xx in range(region[0], region[2]) if max(image.getpixel((xx, yy))) < 130))
        labels_detected = len(dark_counts) == expected_count and all(count >= 2 for count in dark_counts)
        charts.append({
            "name": name,
            "framePixels": {"left": frame[0], "top": frame[1], "right": frame[2], "bottom": frame[3]},
            "markColor": colors[0] if colors else None,
            "expectedMarkCount": expected_count,
            "detectedMarkCount": len(boxes),
            "minimumMarkThicknessPixels": min(thicknesses) if thicknesses else 0,
            "labelsDetected": labels_detected,
            "labelPresenceProbeRegions": [{"left": box[0], "top": box[1], "right": box[2], "bottom": box[3]} for box in label_regions],
            "labelDarkPixelCounts": dark_counts,
        })
    valid = not failures and len(charts) == 2 and all(item["detectedMarkCount"] == item["expectedMarkCount"] and item["minimumMarkThicknessPixels"] >= 8 and item["labelsDetected"] for item in charts)
    return {
        "schemaVersion": RENDER_SCHEMA,
        "valid": valid,
        "caseId": case_id,
        "inputPptxSha256": sha256_file(variant),
        "renderPngSha256": sha256_file(render_png),
        "slide": 2,
        "width": image.width,
        "height": image.height,
        "charts": charts,
        "warnings": [],
        "failures": failures,
    }


def measure_render(variant: Path, render_png: Path, case_id: str) -> dict[str, Any]:
    try:
        return _measure_render(variant, render_png, case_id)
    except (OSError, KeyError, ET.ParseError, UnicodeDecodeError, ValueError, ZeroDivisionError, IndexError) as error:
        input_hash = sha256_file(variant) if variant.is_file() else None
        render_hash = sha256_file(render_png) if render_png.is_file() else None
        return {
            "schemaVersion": RENDER_SCHEMA,
            "valid": False,
            "caseId": case_id,
            "inputPptxSha256": input_hash,
            "renderPngSha256": render_hash,
            "slide": 2,
            "width": None,
            "height": None,
            "charts": [],
            "warnings": [],
            "failures": [fail("SM010", f"Render measurement failed closed: {error}")],
        }


def case_by_id(contract: dict[str, Any], case_id: str) -> dict[str, Any]:
    matches = [item for item in contract.get("cases", []) if isinstance(item, dict) and item.get("id") == case_id]
    if len(matches) != 1:
        raise ValueError(f"Mutation case {case_id!r} is missing or duplicated.")
    return matches[0]


def values_close(actual: Any, expected: Any, tolerance: float = 0.05) -> bool:
    if isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        return math.isfinite(float(actual)) and math.isclose(float(actual), float(expected), abs_tol=tolerance)
    if isinstance(actual, dict) and isinstance(expected, dict):
        return set(actual) >= set(expected) and all(values_close(actual[key], value, tolerance) for key, value in expected.items())
    if isinstance(actual, list) and isinstance(expected, list):
        return len(actual) == len(expected) and all(values_close(left, right, tolerance) for left, right in zip(actual, expected))
    return actual == expected


def baseline_chart_contract(baseline_contract: dict[str, Any], name: str) -> dict[str, Any] | None:
    matches = [
        chart
        for slide in baseline_contract.get("slides", [])
        for chart in slide.get("charts", [])
        if isinstance(chart, dict) and chart.get("name") == name
    ]
    return matches[0] if len(matches) == 1 else None


def validate_powerpoint_case_state(
    result: dict[str, Any],
    mutation_case: dict[str, Any],
    baseline_contract: dict[str, Any],
    baseline_inventory: dict[str, dict[str, Any]],
    failures: list[dict[str, Any]],
) -> None:
    case_id = str(mutation_case.get("id"))
    operation = mutation_case.get("operation")
    before = result.get("before")
    after = result.get("afterMutation")
    reopened = result.get("afterSaveReopen")
    state_valid = True
    expected: Any = None
    if operation == "replace-chart-data":
        source = baseline_chart_contract(baseline_contract, str(mutation_case.get("target")))
        desired = mutation_case["expected"]
        expected_before = {
            "name": ((source or {}).get("series") or [{}])[0].get("name"),
            "categories": (source or {}).get("categories"),
            "values": (((source or {}).get("series") or [{}])[0]).get("values"),
        }
        expected = {
            "name": desired["series"][0]["name"],
            "categories": desired["categories"],
            "values": desired["series"][0]["values"],
        }
        state_valid = source is not None and values_close(before, expected_before) and values_close(after, expected) and values_close(reopened, expected)
    elif operation == "replace-table-cell":
        cell = mutation_case["cell"]
        expected = cell["after"]
        state_valid = before == cell["before"] and after == expected and reopened == expected
    elif operation == "move-diagram-node":
        baseline_geo = (baseline_inventory.get(str(mutation_case.get("target"))) or {}).get("geometry", {})
        expected_before = {"left": baseline_geo.get("x", 0) / EMU_PER_POINT, "top": baseline_geo.get("y", 0) / EMU_PER_POINT}
        expected = {
            "left": expected_before["left"] + float(mutation_case["deltaPoints"]["x"]),
            "top": expected_before["top"] + float(mutation_case["deltaPoints"]["y"]),
        }
        state_valid = values_close(before, expected_before) and values_close(after, expected) and values_close(reopened, expected)
    elif operation == "edit-connector-style":
        desired = mutation_case["expected"]
        endpoints = mutation_case["attachedEndpoints"]
        expected = {
            "weightPoints": desired["weightPoints"],
            "dashStyle": desired["dashStyle"],
            "from": endpoints["from"],
            "to": endpoints["to"],
        }
        state_valid = (
            isinstance(before, dict)
            and not values_close(before, {"weightPoints": desired["weightPoints"], "dashStyle": desired["dashStyle"]})
            and values_close(after, expected)
            and values_close(reopened, expected)
        )
    else:
        state_valid = False
    if not state_valid:
        failures.append(fail("SM011", "PowerPoint before/mutation/save-reopen state does not match the case contract.", object_name=case_id, expected=expected, actual={"before": before, "afterMutation": after, "afterSaveReopen": reopened}))


def validate_powerpoint_report(
    report: dict[str, Any], baseline: Path, variant: Path, contract: dict[str, Any], baseline_contract: dict[str, Any],
    baseline_inventory: dict[str, dict[str, Any]], case_id: str, failures: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if report.get("schemaVersion") != "slidewright-semantic-mutation-powerpoint/v1" or report.get("valid") is not True or report.get("application") != "Microsoft PowerPoint":
        failures.append(fail("SM011", "Real PowerPoint mutation report is missing or invalid."))
        return None
    if report.get("baselineSha256") != sha256_file(baseline):
        failures.append(fail("SM011", "PowerPoint report is not bound to the baseline bytes."))
    cases = report.get("cases", [])
    expected_ids = [item.get("id") for item in contract.get("cases", []) if isinstance(item, dict)]
    actual_ids = [item.get("id") for item in cases if isinstance(item, dict)] if isinstance(cases, list) else []
    if actual_ids != expected_ids:
        failures.append(fail("SM011", "PowerPoint report case inventory/order does not match the mutation contract.", expected=expected_ids, actual=actual_ids))
    by_id = {item.get("id"): item for item in cases if isinstance(item, dict)} if isinstance(cases, list) else {}
    for mutation_case in contract.get("cases", []):
        result_for_case = by_id.get(mutation_case.get("id"))
        if not isinstance(result_for_case, dict):
            continue
        if not isinstance(result_for_case.get("readability"), dict) or "afterSaveReopen" not in result_for_case:
            failures.append(fail("SM011", "PowerPoint report lacks save/reopen or native readability metrics.", object_name=str(mutation_case.get("id"))))
        validate_powerpoint_case_state(result_for_case, mutation_case, baseline_contract, baseline_inventory, failures)
    matches = [item for item in cases if isinstance(item, dict) and item.get("id") == case_id] if isinstance(cases, list) else []
    if len(matches) != 1:
        failures.append(fail("SM011", "PowerPoint report does not contain exactly one requested save/reopen case."))
        return None
    result = matches[0]
    if result.get("sha256") != sha256_file(variant):
        failures.append(fail("SM011", "PowerPoint report is not bound to the variant bytes."))
    return result


def validate_readability(inventory: dict[str, dict[str, Any]], case_result: dict[str, Any] | None,
                         evidence: dict[str, Any], rules: dict[str, Any], failures: list[dict[str, Any]],
                         baseline_inventory: dict[str, dict[str, Any]], baseline_contract: dict[str, Any]) -> dict[str, Any]:
    chart_rule = rules["charts"]
    table_rule = rules["tables"]
    diagram_rule = rules["diagrams"]
    chart_summary: list[dict[str, Any]] = []
    evidence_by_name = {item.get("name"): item for item in evidence.get("charts", []) if isinstance(item, dict)}
    com_chart_by_name = {item.get("name"): item for item in ((case_result or {}).get("readability") or {}).get("charts", []) if isinstance(item, dict)}
    for name in ("surface-02-bar-chart", "surface-02-column-chart"):
        item = inventory.get(name)
        chart = (item or {}).get("chart", {})
        geo = (item or {}).get("geometry", {})
        semantics = chart.get("semantics") or {}
        com = com_chart_by_name.get(name, {})
        render = evidence_by_name.get(name, {})
        width_points = geo.get("cx", 0) / EMU_PER_POINT
        height_points = geo.get("cy", 0) / EMU_PER_POINT
        fonts = chart.get("fontPoints", [])
        com_fonts = [com.get(key) for key in ("categoryAxisFontPoints", "valueAxisFontPoints", "dataLabelFontPoints") if isinstance(com.get(key), (int, float))]
        colors = chart.get("seriesColors", [])
        mark_contrast = min((contrast(color, "FFFFFF") for color in colors), default=0.0)
        text_contrast = min((contrast(color, "FFFFFF") for color in chart.get("textColors", [])), default=0.0)
        labels = com.get("dataLabels", []) if isinstance(com.get("dataLabels"), list) else []
        expected_values = ((semantics.get("series") or [{}])[0].get("values") or []) if semantics.get("series") else []
        labels_in_bounds, labels_no_overlap, label_text_matches, label_boxes = powerpoint_label_checks(labels, expected_values, width_points, height_points)
        checks = {
            "native": chart.get("native") is True,
            "frame": width_points >= chart_rule["minimumFramePoints"]["width"] and height_points >= chart_rule["minimumFramePoints"]["height"],
            "font": bool(fonts) and min(fonts) >= chart_rule["minimumLabelFontPoints"] and bool(com_fonts) and min(com_fonts) >= chart_rule["minimumLabelFontPoints"],
            "categoryCount": len(semantics.get("categories", [])) <= chart_rule["maximumCategories"],
            "seriesCount": len(semantics.get("series", [])) <= chart_rule["maximumSeries"],
            "markThickness": render.get("minimumMarkThicknessPixels", 0) >= chart_rule["minimumMarkThicknessPixels"],
            "labelsInBounds": labels_in_bounds,
            "labelsNoOverlap": labels_no_overlap,
            "labelTextMatches": label_text_matches,
            "labelsDetectedInRender": render.get("labelsDetected") is True,
            "markContrast": mark_contrast >= chart_rule["minimumMarkContrast"],
            "textContrast": text_contrast >= chart_rule["minimumTextContrast"],
        }
        if not all(checks.values()):
            failures.append(fail("SM007", "Native chart readability checks failed.", slide=2, object_name=name, actual=checks))
        chart_summary.append({"name": name, "widthPoints": width_points, "heightPoints": height_points, "minimumXmlFontPoints": min(fonts) if fonts else None, "minimumPowerPointFontPoints": min(com_fonts) if com_fonts else None, "markContrast": mark_contrast, "textContrast": text_contrast, "powerPointDataLabels": labels, "checks": checks})

    table = (inventory.get("surface-03-table") or {}).get("table", {})
    table_cells = table.get("cells", [])
    com_cells = (((case_result or {}).get("readability") or {}).get("table") or {}).get("cells", [])
    com_by_position = {(item.get("row"), item.get("column")): item for item in com_cells if isinstance(item, dict)}
    table_checks = {
        "native": table.get("native") is True,
        "font": bool(table_cells) and all(isinstance(cell.get("fontPoints"), (int, float)) and cell["fontPoints"] >= table_rule["minimumCellFontPoints"] for cell in table_cells),
        "symmetricMargins": bool(table_cells) and all(cell["margins"]["left"] == cell["margins"]["right"] and cell["margins"]["top"] == cell["margins"]["bottom"] for cell in table_cells),
        "staticFit": bool(table_cells) and all(cell.get("staticFits") is True for cell in table_cells),
        "powerPointFit": len(com_by_position) == len(table_cells) and all(com_by_position.get((cell["row"], cell["column"]), {}).get("fits") is True and com_by_position.get((cell["row"], cell["column"]), {}).get("fontPoints", 0) >= table_rule["minimumCellFontPoints"] for cell in table_cells),
        "contrast": bool(table_cells) and all(cell.get("fill") and cell.get("textColors") and min(contrast(color, cell["fill"]) for color in cell["textColors"]) >= table_rule["minimumTextContrast"] for cell in table_cells),
    }
    if not all(table_checks.values()):
        failures.append(fail("SM008", "Native table readability checks failed.", slide=3, object_name="surface-03-table", actual=table_checks))

    node_names = ["surface-04-source", "surface-04-structure", "surface-04-delivery"]
    label_names = [f"{name}-text" for name in node_names]
    contained = all(name in inventory and label in inventory and inside(rect(inventory[label]), rect(inventory[name])) for name, label in zip(node_names, label_names))
    no_text_overlap = all(not overlaps(rect(inventory[a]), rect(inventory[b])) for index, a in enumerate(label_names) for b in label_names[index + 1:] if a in inventory and b in inventory)
    connector_contracts = {
        item.get("name"): item
        for slide in baseline_contract.get("slides", [])
        for item in slide.get("connectors", [])
        if isinstance(item, dict) and item.get("name")
    }
    connector_names = ["surface-04-connector-a", "surface-04-connector-b"]
    connectors = [inventory.get(name) for name in connector_names]
    attached = all(
        item
        and connector_contracts.get(name)
        and item.get("from") == connector_contracts[name].get("from")
        and item.get("to") == connector_contracts[name].get("to")
        and item.get("fromSite") == (baseline_inventory.get(name) or {}).get("fromSite")
        and item.get("toSite") == (baseline_inventory.get(name) or {}).get("toSite")
        for name, item in zip(connector_names, connectors)
    )
    connector_weight = all(item and item.get("line", {}).get("weightPoints", 0) >= diagram_rule["minimumLineWeightPoints"] for item in connectors)
    connector_contrast = all(item and item.get("line", {}).get("color") and contrast(item["line"]["color"], "FFFFFF") >= diagram_rule["minimumLineContrast"] for item in connectors)
    crossings: list[dict[str, str]] = []
    for connector in (item for item in connectors if item):
        endpoints = {connector.get("from"), connector.get("to")}
        ignored = endpoints | {f"{name}-text" for name in endpoints if name}
        start, end = connector_segment(connector)
        for candidate in node_names + label_names:
            if candidate in ignored or candidate not in inventory:
                continue
            if segment_intersects_rect(start, end, rect(inventory[candidate])):
                crossings.append({"connector": connector["name"], "object": candidate})
    diagram_checks = {
        "labelsInsideNodes": contained,
        "textOverlapForbidden": no_text_overlap,
        "connectorsAttached": attached,
        "connectorWeight": connector_weight,
        "connectorContrast": connector_contrast,
        "noNonEndpointCrossings": not crossings,
    }
    if not all(diagram_checks.values()):
        failures.append(fail("SM009", "Native diagram readability checks failed.", slide=4, actual={"checks": diagram_checks, "crossings": crossings}))
    return {"charts": chart_summary, "table": table_checks, "diagram": {"checks": diagram_checks, "crossings": crossings}}


def audit(baseline: Path, variant: Path, contract_path: Path, baseline_contract_path: Path,
          powerpoint_report_path: Path, render_evidence_path: Path, case_id: str) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    try:
        contract = read_json(contract_path)
        baseline_contract = read_json(baseline_contract_path)
        powerpoint_report = read_json(powerpoint_report_path)
        evidence = read_json(render_evidence_path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return {"schemaVersion": REPORT_SCHEMA, "valid": False, "caseId": case_id, "warnings": [], "failures": [fail("SM001", f"Required input could not be read: {error}")]}
    if contract.get("schemaVersion") != EXPECTED_SCHEMA:
        failures.append(fail("SM001", "Unsupported mutation contract schema."))
    if baseline_contract.get("schemaVersion") != "slidewright-semantic-surface/v1":
        failures.append(fail("SM001", "Unsupported baseline semantic contract schema."))
    expected_contract_hash = (contract.get("baselineContract") or {}).get("sha256")
    if expected_contract_hash != sha256_file(baseline_contract_path):
        failures.append(fail("SM001", "Baseline semantic contract hash is stale.", expected=expected_contract_hash, actual=sha256_file(baseline_contract_path)))
    mutation_case = case_by_id(contract, case_id)
    baseline_inventory, baseline_notes, baseline_failures = package_inventory(baseline)
    variant_inventory, variant_notes, variant_failures = package_inventory(variant)
    failures.extend(baseline_failures)
    failures.extend(variant_failures)
    if powerpoint_report.get("mutationContractSha256") != sha256_file(contract_path):
        failures.append(fail("SM011", "PowerPoint report is not bound to the mutation contract bytes.", expected=sha256_file(contract_path), actual=powerpoint_report.get("mutationContractSha256")))
    case_result = validate_powerpoint_report(powerpoint_report, baseline, variant, contract, baseline_contract, baseline_inventory, case_id, failures)
    if evidence.get("schemaVersion") != RENDER_SCHEMA or evidence.get("valid") is not True or evidence.get("caseId") != case_id or evidence.get("inputPptxSha256") != sha256_file(variant):
        failures.append(fail("SM010", "Render evidence is missing, invalid, or not bound to the variant bytes."))
    if evidence.get("warnings") != []:
        failures.append(fail("SM010", "Render evidence contains warnings.", actual=evidence.get("warnings")))

    if set(baseline_inventory) != set(variant_inventory) or baseline_notes != variant_notes:
        failures.append(fail("SM002", "Slide/object inventory or speaker notes changed."))
    baseline_parts, baseline_part_failures = surface.load_package_parts(baseline)
    variant_parts, variant_part_failures = surface.load_package_parts(variant)
    failures.extend(baseline_part_failures)
    failures.extend(variant_part_failures)
    package_closure = compare_operation_closure(baseline_parts, variant_parts, baseline_inventory, variant_inventory, mutation_case)
    if not package_closure["valid"]:
        failures.append(fail("SM002", "Package changed outside the exact operation-specific XML mask.", actual=package_closure["differences"]))
    allowed = set(mutation_case.get("allowedChangedObjects", []))
    unauthorized = []
    for name in sorted(set(baseline_inventory) & set(variant_inventory)):
        if name not in allowed and semantic_signature(baseline_inventory[name]) != semantic_signature(variant_inventory[name]):
            unauthorized.append(name)
    if unauthorized:
        failures.append(fail("SM002", "Objects outside the authorized closure changed.", actual=unauthorized))

    operation = mutation_case.get("operation")
    target = mutation_case.get("target")
    before = baseline_inventory.get(target, {})
    after = variant_inventory.get(target, {})
    if operation == "replace-chart-data":
        expected = mutation_case["expected"]
        actual = (after.get("chart") or {}).get("semantics")
        expected_semantics = {"type": "bar", "direction": expected["direction"], "categories": expected["categories"], "series": expected["series"]}
        if after.get("type") != "chart" or actual != expected_semantics:
            failures.append(fail("SM004", "Native chart data mutation does not match the exact contract.", slide=mutation_case["slide"], object_name=target, expected=expected_semantics, actual=actual))
    elif operation == "replace-table-cell":
        if after.get("type") != "table":
            failures.append(fail("SM005", "Table mutation flattened or removed the native table.", slide=mutation_case["slide"], object_name=target))
        else:
            comparison_keys = ("row", "column", "text", "fontPoints", "margins", "fill", "textColors", "widthPoints", "heightPoints", "wrap")
            before_cells = [{key: cell.get(key) for key in comparison_keys} for cell in (before.get("table") or {}).get("cells", [])]
            after_cells = [{key: cell.get(key) for key in comparison_keys} for cell in (after.get("table") or {}).get("cells", [])]
            expected_cells = json.loads(json.dumps(before_cells))
            cell = mutation_case["cell"]
            for item in expected_cells:
                if item["row"] == cell["row"] and item["column"] == cell["column"]:
                    if item["text"] != cell["before"]:
                        failures.append(fail("SM003", "Baseline table cell does not match the contracted before value."))
                    item["text"] = cell["after"]
            if after_cells != expected_cells:
                failures.append(fail("SM003", "Table edit changed more or less than the declared cell.", expected=expected_cells, actual=after_cells))
    elif operation == "move-diagram-node":
        delta_x = mutation_case["deltaPoints"]["x"] * EMU_PER_POINT
        delta_y = mutation_case["deltaPoints"]["y"] * EMU_PER_POINT
        for name in [target, *mutation_case.get("moveWithTarget", [])]:
            baseline_geo = baseline_inventory.get(name, {}).get("geometry", {})
            variant_geo = variant_inventory.get(name, {}).get("geometry", {})
            if variant_geo.get("x") != round(baseline_geo.get("x", 0) + delta_x) or variant_geo.get("y") != round(baseline_geo.get("y", 0) + delta_y) or variant_geo.get("cx") != baseline_geo.get("cx") or variant_geo.get("cy") != baseline_geo.get("cy"):
                failures.append(fail("SM003", "Diagram node/label did not move by the exact declared delta.", slide=4, object_name=name, expected={"dx": delta_x, "dy": delta_y}, actual=variant_geo))
        for name in mutation_case.get("attachedConnectors", []):
            connector = variant_inventory.get(name, {})
            baseline_connector = baseline_inventory.get(name, {})
            if (
                connector.get("from") != baseline_connector.get("from")
                or connector.get("to") != baseline_connector.get("to")
                or connector.get("fromSite") != baseline_connector.get("fromSite")
                or connector.get("toSite") != baseline_connector.get("toSite")
            ):
                failures.append(fail("SM006", "Moved diagram connector endpoints or connection-site indices changed.", slide=4, object_name=name, expected={key: baseline_connector.get(key) for key in ("from", "to", "fromSite", "toSite")}, actual={key: connector.get(key) for key in ("from", "to", "fromSite", "toSite")}))
    elif operation == "edit-connector-style":
        expected = mutation_case["expected"]
        expected_dash = DASH_STYLE_TO_OOXML.get(expected["dashStyle"])
        endpoints = mutation_case["attachedEndpoints"]
        if after.get("type") != "connector" or not math.isclose(after.get("line", {}).get("weightPoints", 0), expected["weightPoints"], abs_tol=0.05) or after.get("line", {}).get("dash") != expected_dash or after.get("from") != endpoints["from"] or after.get("to") != endpoints["to"]:
            failures.append(fail("SM006", "Connector style/endpoints do not match the exact contract.", slide=4, object_name=target, actual=after))
    else:
        failures.append(fail("SM003", f"Unsupported mutation operation {operation!r}."))

    readability = validate_readability(variant_inventory, case_result, evidence, contract["readability"], failures, baseline_inventory, baseline_contract)
    failures.sort(key=lambda item: (item.get("slide", 0), item.get("object", ""), item["code"], item["message"]))
    checks = {
        "sourceBound": not any(item["code"] in {"SM001", "SM010", "SM011"} for item in failures),
        "exactInventory": not any(item["code"] == "SM002" for item in failures),
        "exactAuthorizedMutation": not any(item["code"] in {"SM002", "SM003"} for item in failures),
        "nativeCharts": not any(item["code"] in {"SM004", "SM007"} for item in failures),
        "nativeTable": not any(item["code"] in {"SM005", "SM008"} for item in failures),
        "nativeDiagram": not any(item["code"] in {"SM006", "SM009"} for item in failures),
    }
    return {
        "schemaVersion": REPORT_SCHEMA,
        "valid": not failures and not warnings and all(checks.values()),
        "caseId": case_id,
        "sourceBinding": {
            "baselineSha256": sha256_file(baseline),
            "variantSha256": sha256_file(variant),
            "mutationContractSha256": sha256_file(contract_path),
            "baselineContractSha256": sha256_file(baseline_contract_path),
            "powerPointReportSha256": sha256_file(powerpoint_report_path),
            "renderEvidenceSha256": sha256_file(render_evidence_path),
        },
        "checks": checks,
        "summary": {"objects": len(variant_inventory), "allowedChangedObjects": sorted(allowed), "failures": len(failures)},
        "packageClosure": package_closure,
        "readability": readability,
        "warnings": warnings,
        "failures": failures,
    }


def write_report(path: Path | None, report: dict[str, Any]) -> None:
    payload = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline_pptx", type=Path)
    parser.add_argument("variant_pptx", type=Path)
    parser.add_argument("mutation_contract", type=Path)
    parser.add_argument("--case", required=True)
    parser.add_argument("--baseline-contract", required=True, type=Path)
    parser.add_argument("--powerpoint-report", required=True, type=Path)
    parser.add_argument("--render-evidence", type=Path)
    parser.add_argument("--measure-render", type=Path, help="Measure a full-size slide-2 PNG and emit render evidence instead of auditing.")
    parser.add_argument("--json", dest="json_path", type=Path)
    args = parser.parse_args()
    if args.measure_render:
        report = measure_render(args.variant_pptx, args.measure_render, args.case)
    elif not args.render_evidence:
        report = {"schemaVersion": REPORT_SCHEMA, "valid": False, "caseId": args.case, "warnings": [], "failures": [fail("SM010", "--render-evidence is required for a valid audit.")]}
    else:
        report = audit(args.baseline_pptx, args.variant_pptx, args.mutation_contract, args.baseline_contract, args.powerpoint_report, args.render_evidence, args.case)
    write_report(args.json_path, report)
    return 0 if report.get("valid") is True else 2


if __name__ == "__main__":
    raise SystemExit(main())
