#!/usr/bin/env python3
"""Audit the exact semantic object surface of a controlled PowerPoint deck.

The ``semantic-surface-v1`` manifest is intentionally strict.  Every drawable
object must be declared by its local z-order and recursive group path.  Complex
objects add the following required fields:

* group: ``childCount``
* chart: ``relationshipTarget`` (and optionally ``partSha256``)
* table: ``rows``, ``columns``, and ``cellsSha256``
* connector: ``from`` and ``to`` objects with ``name`` and ``idx``
* image: ``mediaTarget``, ``mediaSha256``, and ``alt``

Each slide also declares exact ``notesText``.  The controlled suite must cover
shapes, groups, charts, tables, connectors, images, meaningful speaker notes,
and at least one nested group.  Unknown or undeclared objects are failures.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import posixpath
from pathlib import Path
import re
import sys
from typing import Any
import zipfile
import xml.etree.ElementTree as ET


P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"

NS = {"p": P, "a": A, "c": C, "r": R}
Q = lambda namespace, local: f"{{{namespace}}}{local}"

OBJECT_TAGS = {
    Q(P, "sp"): "shape",
    Q(P, "grpSp"): "group",
    Q(P, "graphicFrame"): "graphicFrame",
    Q(P, "cxnSp"): "connector",
    Q(P, "pic"): "image",
}
REQUIRED_TYPES = {"shape", "group", "chart", "table", "connector", "image"}
REQUIRED_NEGATIVE_CONTROLS = [
    "chart-relation-break",
    "chart-flatten",
    "table-flatten",
    "connector-detach",
    "notes-strip",
    "nested-group-flatten",
    "hierarchy-drift",
    "image-relation-drift",
    "undeclared-object",
]
CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"
TABLE_URI = "http://schemas.openxmlformats.org/drawingml/2006/table"
CHART_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart"
IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
NOTES_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
IGNORED_NOTES_PLACEHOLDERS = {"sldImg", "sldNum", "hdr", "ftr", "dt"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return sha256_bytes(payload.encode("utf-8"))


def relationship_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    return posixpath.join(directory, "_rels", f"{filename}.rels")


def resolve_target(owner: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)).lstrip("/")


def parse_relationships(parts: dict[str, bytes], owner: str) -> dict[str, dict[str, Any]]:
    rel_name = relationship_part(owner)
    if rel_name not in parts:
        return {}
    root = ET.fromstring(parts[rel_name])
    result: dict[str, dict[str, Any]] = {}
    for item in root:
        rel_id = item.get("Id")
        if not rel_id:
            continue
        target = item.get("Target", "")
        external = item.get("TargetMode") == "External"
        result[rel_id] = {
            "id": rel_id,
            "type": item.get("Type"),
            "target": target if external else resolve_target(owner, target),
            "external": external,
        }
    return result


def presentation_slide_order(parts: dict[str, bytes]) -> tuple[list[str], str | None]:
    owner = "ppt/presentation.xml"
    if owner not in parts:
        return [], "missing ppt/presentation.xml"
    try:
        root = ET.fromstring(parts[owner])
    except ET.ParseError as error:
        return [], f"invalid ppt/presentation.xml: {error}"
    relationships = parse_relationships(parts, owner)
    order: list[str] = []
    for slide_id in root.findall("p:sldIdLst/p:sldId", NS):
        rel_id = slide_id.get(Q(R, "id"))
        relationship = relationships.get(rel_id) if rel_id else None
        if not relationship or relationship["external"] or not isinstance(relationship["type"], str) or not relationship["type"].endswith("/slide"):
            return order, f"presentation slide relationship {rel_id!r} is missing or invalid"
        order.append(relationship["target"])
    return order, None


def object_nonvisual_properties(element: ET.Element) -> ET.Element | None:
    paths = {
        Q(P, "sp"): "p:nvSpPr/p:cNvPr",
        Q(P, "grpSp"): "p:nvGrpSpPr/p:cNvPr",
        Q(P, "graphicFrame"): "p:nvGraphicFramePr/p:cNvPr",
        Q(P, "cxnSp"): "p:nvCxnSpPr/p:cNvPr",
        Q(P, "pic"): "p:nvPicPr/p:cNvPr",
    }
    path = paths.get(element.tag)
    return element.find(path, NS) if path else None


def object_name(element: ET.Element) -> str:
    props = object_nonvisual_properties(element)
    return props.get("name", "") if props is not None else ""


def object_id(element: ET.Element) -> int | None:
    props = object_nonvisual_properties(element)
    raw = props.get("id") if props is not None else None
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


def paragraph_text(paragraph: ET.Element) -> str:
    return "".join(node.text or "" for node in paragraph.findall(".//a:t", NS)).rstrip()


def shape_text(element: ET.Element) -> str:
    return "\n".join(paragraph_text(item) for item in element.findall("p:txBody/a:p", NS)).rstrip()


def table_signature(element: ET.Element) -> tuple[int, int, str, list[list[str]]]:
    table = element.find("a:graphic/a:graphicData/a:tbl", NS)
    if table is None:
        return 0, 0, stable_hash([]), []
    rows = table.findall("a:tr", NS)
    cells = [["\n".join(paragraph_text(p) for p in cell.findall("a:txBody/a:p", NS)).rstrip() for cell in row.findall("a:tc", NS)] for row in rows]
    columns = max((len(row) for row in cells), default=0)
    return len(rows), columns, stable_hash(cells), cells


def content_notes_text(notes_root: ET.Element) -> str:
    paragraphs: list[str] = []
    for shape in notes_root.findall(".//p:sp", NS):
        placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
        placeholder_type = placeholder.get("type") if placeholder is not None else None
        if placeholder_type in IGNORED_NOTES_PLACEHOLDERS:
            continue
        for paragraph in shape.findall("p:txBody/a:p", NS):
            text = paragraph_text(paragraph)
            if text:
                paragraphs.append(text)
    return "\n".join(paragraphs)


def slide_notes(parts: dict[str, bytes], slide_part: str) -> tuple[str, str | None]:
    relationships = parse_relationships(parts, slide_part)
    candidates = [item for item in relationships.values() if item["type"] == NOTES_REL and not item["external"]]
    if not candidates:
        return "", None
    if len(candidates) != 1:
        return "", "multiple notes-slide relationships"
    target = candidates[0]["target"]
    if target not in parts:
        return "", f"missing notes part {target}"
    try:
        return content_notes_text(ET.fromstring(parts[target])), None
    except ET.ParseError as error:
        return "", f"invalid notes XML in {target}: {error}"


def classify_graphic_frame(element: ET.Element) -> tuple[str, str | None]:
    graphic_data = element.find("a:graphic/a:graphicData", NS)
    uri = graphic_data.get("uri") if graphic_data is not None else None
    if uri == CHART_URI and graphic_data.find("c:chart", NS) is not None:
        return "chart", uri
    if uri == TABLE_URI and graphic_data.find("a:tbl", NS) is not None:
        return "table", uri
    return "graphicFrame", uri


def enumerate_objects(root: ET.Element) -> tuple[list[dict[str, Any]], dict[int, str]]:
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        return [], {}
    records: list[dict[str, Any]] = []
    names_by_id: dict[int, str] = {}

    def visit(container: ET.Element, group_path: tuple[str, ...]) -> None:
        z_order = 0
        for child in list(container):
            base_type = OBJECT_TAGS.get(child.tag)
            if base_type is None:
                continue
            name = object_name(child)
            numeric_id = object_id(child)
            if numeric_id is not None:
                names_by_id[numeric_id] = name
            actual_type = base_type
            graphic_uri = None
            if base_type == "graphicFrame":
                actual_type, graphic_uri = classify_graphic_frame(child)
            record: dict[str, Any] = {
                "type": actual_type,
                "name": name,
                "objectId": numeric_id,
                "groupPath": list(group_path),
                "zOrder": z_order,
                "_element": child,
            }
            if graphic_uri is not None:
                record["graphicDataUri"] = graphic_uri
            if actual_type == "group":
                record["childCount"] = sum(1 for item in list(child) if item.tag in OBJECT_TAGS)
            if actual_type == "shape":
                text = shape_text(child)
                record["hasText"] = bool(text)
                if text:
                    record["textSha256"] = stable_hash(text)
            records.append(record)
            z_order += 1
            if actual_type == "group":
                visit(child, (*group_path, name))

    visit(tree, ())
    return records, names_by_id


def enrich_objects(parts: dict[str, bytes], slide_part: str, records: list[dict[str, Any]], names_by_id: dict[int, str]) -> None:
    relationships = parse_relationships(parts, slide_part)
    for record in records:
        element = record.pop("_element")
        if record["type"] == "chart":
            chart = element.find("a:graphic/a:graphicData/c:chart", NS)
            rel_id = chart.get(Q(R, "id")) if chart is not None else None
            relationship = relationships.get(rel_id) if rel_id else None
            record["relationshipId"] = rel_id
            record["relationshipType"] = relationship["type"] if relationship else None
            record["relationshipTarget"] = relationship["target"] if relationship else None
            record["relationshipExternal"] = relationship["external"] if relationship else None
            target = relationship["target"] if relationship and not relationship["external"] else None
            record["partExists"] = bool(target and target in parts)
            record["partSha256"] = sha256_bytes(parts[target]) if target and target in parts else None
        elif record["type"] == "table":
            rows, columns, digest, cells = table_signature(element)
            record.update({"rows": rows, "columns": columns, "cellsSha256": digest, "cells": cells})
        elif record["type"] == "connector":
            props = element.find("p:nvCxnSpPr/p:cNvCxnSpPr", NS)
            for field, tag in (("from", "stCxn"), ("to", "endCxn")):
                endpoint = props.find(f"a:{tag}", NS) if props is not None else None
                if endpoint is None:
                    record[field] = None
                    continue
                raw_id = endpoint.get("id")
                try:
                    numeric_id = int(raw_id) if raw_id is not None else None
                except ValueError:
                    numeric_id = None
                record[field] = {
                    "name": names_by_id.get(numeric_id),
                    "idx": int(endpoint.get("idx", "0")),
                }
        elif record["type"] == "image":
            props = object_nonvisual_properties(element)
            blip = element.find("p:blipFill/a:blip", NS)
            rel_id = blip.get(Q(R, "embed")) if blip is not None else None
            relationship = relationships.get(rel_id) if rel_id else None
            record["alt"] = props.get("descr", "") if props is not None else ""
            record["title"] = props.get("title", "") if props is not None else ""
            record["relationshipId"] = rel_id
            record["relationshipType"] = relationship["type"] if relationship else None
            record["mediaTarget"] = relationship["target"] if relationship else None
            record["relationshipExternal"] = relationship["external"] if relationship else None
            target = relationship["target"] if relationship and not relationship["external"] else None
            record["mediaExists"] = bool(target and target in parts)
            record["mediaSha256"] = sha256_bytes(parts[target]) if target and target in parts else None


def failure(code: str, message: str, *, slide: int | None = None, object_name_value: str | None = None, expected: Any = None, actual: Any = None) -> dict[str, Any]:
    result: dict[str, Any] = {"code": code, "message": message}
    if slide is not None:
        result["slide"] = slide
    if object_name_value is not None:
        result["object"] = object_name_value
    if expected is not None:
        result["expected"] = expected
    if actual is not None:
        result["actual"] = actual
    return result


def public_record(record: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in record.items() if not key.startswith("_")}


def object_key(record: dict[str, Any]) -> tuple[tuple[str, ...], str]:
    return tuple(record.get("groupPath", [])), record.get("name", "")


def load_package_parts(pptx_path: Path) -> tuple[dict[str, bytes], list[dict[str, Any]]]:
    failures: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(pptx_path) as archive:
            corrupt = archive.testzip()
            if corrupt:
                failures.append(failure("SS002", f"ZIP member failed CRC validation: {corrupt}"))
            return {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}, failures
    except (OSError, zipfile.BadZipFile, KeyError) as error:
        return {}, [failure("SS002", f"PowerPoint package could not be read: {error}")]


def actual_slide_records(parts: dict[str, bytes], number: int) -> tuple[list[dict[str, Any]], str, str | None]:
    part = f"ppt/slides/slide{number}.xml"
    if part not in parts:
        return [], "", f"missing {part}"
    try:
        root = ET.fromstring(parts[part])
    except ET.ParseError as error:
        return [], "", f"invalid slide XML: {error}"
    records, names_by_id = enumerate_objects(root)
    enrich_objects(parts, part, records, names_by_id)
    notes, notes_error = slide_notes(parts, part)
    return [public_record(item) for item in records], notes, notes_error


def chart_semantics(parts: dict[str, bytes], record: dict[str, Any]) -> dict[str, Any] | None:
    target = record.get("relationshipTarget")
    if not isinstance(target, str) or target not in parts:
        return None
    try:
        root = ET.fromstring(parts[target])
    except ET.ParseError:
        return None
    bar = root.find(".//c:barChart", NS)
    if bar is None:
        return {"type": "unsupported", "direction": None, "categories": [], "series": []}
    direction_node = bar.find("c:barDir", NS)
    raw_direction = direction_node.get("val") if direction_node is not None else None
    direction = "column" if raw_direction == "col" else raw_direction
    series: list[dict[str, Any]] = []
    categories: list[str] = []
    for series_node in bar.findall("c:ser", NS):
        name_node = series_node.find("c:tx/c:v", NS)
        if name_node is None:
            name_node = series_node.find("c:tx/c:strRef/c:strCache/c:pt/c:v", NS)
        category_points = series_node.findall("c:cat//c:pt", NS)
        value_points = series_node.findall("c:val//c:pt", NS)
        ordered_categories = [next((child.text or "" for child in point.findall("c:v", NS)), "") for point in sorted(category_points, key=lambda item: int(item.get("idx", "0")))]
        ordered_values: list[int | float] = []
        for point in sorted(value_points, key=lambda item: int(item.get("idx", "0"))):
            value_node = point.find("c:v", NS)
            raw = value_node.text if value_node is not None else ""
            try:
                numeric = float(raw)
                ordered_values.append(int(numeric) if numeric.is_integer() else numeric)
            except (TypeError, ValueError):
                ordered_values.append(raw)
        if not categories:
            categories = ordered_categories
        series.append({"name": name_node.text if name_node is not None else "", "values": ordered_values})
    return {"type": "bar", "direction": direction, "categories": categories, "series": series}


def resolve_contract_asset(contract_path: Path, source: str) -> Path | None:
    candidate = Path(source)
    if candidate.is_absolute() and candidate.is_file():
        return candidate
    direct = Path.cwd() / candidate
    if direct.is_file():
        return direct.resolve()
    for parent in (contract_path.parent, *contract_path.parents):
        resolved = parent / candidate
        if resolved.is_file():
            return resolved.resolve()
    return None


def validate_authored_contract(pptx_path: Path, contract: Any, contract_path: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    failures: list[dict[str, Any]] = []
    parts, package_failures = load_package_parts(pptx_path)
    failures.extend(package_failures)
    if failures:
        return failures, []
    if not isinstance(contract, dict) or contract.get("schemaVersion") != "slidewright-semantic-surface/v1":
        return [failure("SS010", "Authored contract schemaVersion must be slidewright-semantic-surface/v1.")], []
    if contract.get("deterministicExports") != 3:
        failures.append(failure("SS010", "Authored contract must require exactly three deterministic exports.", expected=3, actual=contract.get("deterministicExports")))
    contract_slides = contract.get("slides")
    if not isinstance(contract_slides, list) or len(contract_slides) != 4:
        failures.append(failure("SS010", "Authored semantic contract must contain exactly four slides.", expected=4, actual=len(contract_slides) if isinstance(contract_slides, list) else None))
        return failures, []
    if contract.get("negativeControls") != REQUIRED_NEGATIVE_CONTROLS:
        failures.append(failure("SS010", "Authored contract negative-control inventory does not exactly match semantic-surface-v1.", expected=REQUIRED_NEGATIVE_CONTROLS, actual=contract.get("negativeControls")))
    presentation = parts.get("ppt/presentation.xml")
    if presentation is None:
        failures.append(failure("SS010", "Presentation part is missing while checking canvas size."))
    else:
        try:
            root = ET.fromstring(presentation)
            size = root.find("p:sldSz", NS)
            actual_canvas = None if size is None else {"width": round(int(size.get("cx", "0")) / 9525), "height": round(int(size.get("cy", "0")) / 9525)}
            if actual_canvas != contract.get("canvas"):
                failures.append(failure("SS010", "Canvas size does not match the authored semantic contract.", expected=contract.get("canvas"), actual=actual_canvas))
        except (ET.ParseError, ValueError) as error:
            failures.append(failure("SS010", f"Canvas size could not be read: {error}"))

    all_slide_records: list[dict[str, Any]] = []
    for expected_index, slide_contract in enumerate(contract_slides, start=1):
        if not isinstance(slide_contract, dict) or slide_contract.get("index") != expected_index:
            failures.append(failure("SS010", "Authored slide indexes must be consecutive and start at 1.", slide=expected_index))
            continue
        records, notes, notes_error = actual_slide_records(parts, expected_index)
        all_slide_records.append({"slide": expected_index, "objects": records, "notesText": notes})
        if notes_error:
            failures.append(failure("SS017", notes_error, slide=expected_index))
        expected_notes = slide_contract.get("speakerNotes")
        if not isinstance(expected_notes, str) or not expected_notes.strip() or notes != expected_notes:
            failures.append(failure("SS017", "Speaker notes do not exactly match the authored contract.", slide=expected_index, expected=expected_notes, actual=notes))

        top_level = [item for item in records if not item["groupPath"]]
        actual_reading_order = [item["name"] for item in sorted(top_level, key=lambda item: item["zOrder"])]
        if actual_reading_order != slide_contract.get("readingOrder"):
            failures.append(failure("SS011", "Top-level reading order does not exactly match the authored contract.", slide=expected_index, expected=slide_contract.get("readingOrder"), actual=actual_reading_order))

        expected_groups = slide_contract.get("groups", [])
        actual_groups: list[dict[str, Any]] = []
        for group in (item for item in records if item["type"] == "group"):
            child_path = [*group["groupPath"], group["name"]]
            children = [item for item in records if item["groupPath"] == child_path]
            actual_groups.append({
                "name": group["name"],
                **({"parent": group["groupPath"][-1]} if group["groupPath"] else {}),
                "children": [item["name"] for item in sorted(children, key=lambda item: item["zOrder"])],
            })
        if actual_groups != expected_groups:
            failures.append(failure("SS012", "Recursive group membership does not exactly match the authored contract.", slide=expected_index, expected=expected_groups, actual=actual_groups))

        expected_charts = slide_contract.get("charts", [])
        actual_charts = []
        for chart in (item for item in records if item["type"] == "chart"):
            semantics = chart_semantics(parts, chart)
            actual_charts.append({"name": chart["name"], **(semantics or {"type": None, "direction": None, "categories": [], "series": []})})
        if actual_charts != expected_charts:
            failures.append(failure("SS013", "Native chart names, direction, categories, or series do not match the authored contract.", slide=expected_index, expected=expected_charts, actual=actual_charts))

        expected_table = slide_contract.get("table")
        actual_tables = [item for item in records if item["type"] == "table"]
        actual_table = None if not actual_tables else {
            "name": actual_tables[0]["name"],
            "rows": actual_tables[0]["rows"],
            "columns": actual_tables[0]["columns"],
            "values": actual_tables[0]["cells"],
        }
        if (expected_table is None and actual_tables) or (expected_table is not None and (len(actual_tables) != 1 or actual_table != expected_table)):
            failures.append(failure("SS014", "Native table identity, dimensions, or cell values do not match the authored contract.", slide=expected_index, expected=expected_table, actual=actual_table if len(actual_tables) <= 1 else actual_tables))

        expected_connectors = slide_contract.get("connectors", [])
        actual_connectors = [{"name": item["name"], "from": (item.get("from") or {}).get("name"), "to": (item.get("to") or {}).get("name")} for item in records if item["type"] == "connector"]
        if actual_connectors != expected_connectors:
            failures.append(failure("SS015", "Connector identity or attached endpoints do not match the authored contract.", slide=expected_index, expected=expected_connectors, actual=actual_connectors))

        expected_image = slide_contract.get("image")
        actual_images = [item for item in records if item["type"] == "image"]
        if expected_image is None:
            if actual_images:
                failures.append(failure("SS016", "Authored contract did not declare the exported image.", slide=expected_index, actual=[item["name"] for item in actual_images]))
        else:
            asset = resolve_contract_asset(contract_path, expected_image.get("source", "")) if isinstance(expected_image, dict) else None
            expected_hash = sha256_bytes(asset.read_bytes()) if asset else None
            actual_image = None if len(actual_images) != 1 else actual_images[0]
            image_projection = None if actual_image is None else {"name": actual_image["name"], "mediaSha256": actual_image["mediaSha256"], "alt": actual_image["alt"]}
            expected_projection = {"name": expected_image.get("name"), "mediaSha256": expected_hash, "alt": expected_image.get("alt")}
            if asset is None or image_projection != expected_projection:
                failures.append(failure("SS016", "Declared image name, source hash, or alt text does not match the authored contract.", slide=expected_index, expected=expected_projection, actual=image_projection))

    return failures, all_slide_records


def freeze_manifest_from_contract(pptx_path: Path, contract: dict[str, Any], contract_path: Path) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    failures, slide_records = validate_authored_contract(pptx_path, contract, contract_path)
    if failures:
        return None, failures
    frozen_slides: list[dict[str, Any]] = []
    for slide in slide_records:
        objects: list[dict[str, Any]] = []
        for actual in slide["objects"]:
            declaration = {key: actual[key] for key in ("type", "name", "groupPath", "zOrder")}
            if actual["type"] == "shape":
                declaration["hasText"] = actual["hasText"]
                if actual["hasText"]:
                    declaration["textSha256"] = actual["textSha256"]
            elif actual["type"] == "group":
                declaration["childCount"] = actual["childCount"]
            elif actual["type"] == "chart":
                declaration["relationshipTarget"] = actual["relationshipTarget"]
                declaration["partSha256"] = actual["partSha256"]
            elif actual["type"] == "table":
                declaration.update({key: actual[key] for key in ("rows", "columns", "cellsSha256")})
            elif actual["type"] == "connector":
                declaration.update({"from": actual["from"], "to": actual["to"]})
            elif actual["type"] == "image":
                declaration.update({key: actual[key] for key in ("mediaTarget", "mediaSha256", "alt")})
            objects.append(declaration)
        frozen_slides.append({"slide": slide["slide"], "notesText": slide["notesText"], "objects": objects})
    manifest = {"version": "semantic-surface-v1", "slides": frozen_slides}
    return manifest, validate_manifest(manifest)


def validate_manifest(manifest: Any) -> list[dict[str, Any]]:
    failures: list[dict[str, Any]] = []
    if not isinstance(manifest, dict) or manifest.get("version") != "semantic-surface-v1":
        return [failure("SS001", "Manifest version must be semantic-surface-v1.")]
    slides = manifest.get("slides")
    if not isinstance(slides, list) or not slides:
        return [failure("SS001", "Manifest slides must be a non-empty array.")]
    slide_numbers = [item.get("slide") for item in slides if isinstance(item, dict)]
    if slide_numbers != list(range(1, len(slides) + 1)):
        failures.append(failure("SS001", "Manifest slide numbers must be consecutive and start at 1.", expected=list(range(1, len(slides) + 1)), actual=slide_numbers))
    expected_types: set[str] = set()
    has_notes = False
    has_nested_group = False
    for slide in slides:
        if not isinstance(slide, dict):
            failures.append(failure("SS001", "Every slide manifest entry must be an object."))
            continue
        number = slide.get("slide")
        if not isinstance(slide.get("notesText"), str):
            failures.append(failure("SS001", "Every slide must declare exact notesText.", slide=number))
        has_notes = has_notes or bool(slide.get("notesText", "").strip())
        objects = slide.get("objects")
        if not isinstance(objects, list):
            failures.append(failure("SS001", "Every slide must declare an objects array.", slide=number))
            continue
        seen: set[tuple[tuple[str, ...], str]] = set()
        seen_names: set[str] = set()
        for item in objects:
            if not isinstance(item, dict):
                failures.append(failure("SS001", "Object declarations must be objects.", slide=number))
                continue
            kind = item.get("type")
            name = item.get("name")
            path = item.get("groupPath")
            z_order = item.get("zOrder")
            if kind not in REQUIRED_TYPES:
                failures.append(failure("SS001", f"Unsupported manifest object type {kind!r}.", slide=number, object_name_value=name))
            else:
                expected_types.add(kind)
            if not isinstance(name, str) or not name:
                failures.append(failure("SS001", "Every object needs a non-empty stable name.", slide=number))
            if not isinstance(path, list) or not all(isinstance(value, str) and value for value in path):
                failures.append(failure("SS001", "groupPath must be an array of non-empty group names.", slide=number, object_name_value=name))
                path = []
            if not isinstance(z_order, int) or z_order < 0:
                failures.append(failure("SS001", "zOrder must be a non-negative integer.", slide=number, object_name_value=name))
            key = (tuple(path), name)
            if key in seen:
                failures.append(failure("SS001", "Object identity is duplicated within its group path.", slide=number, object_name_value=name))
            seen.add(key)
            if isinstance(name, str) and name in seen_names:
                failures.append(failure("SS001", "Stable object names must be unique across the complete slide.", slide=number, object_name_value=name))
            if isinstance(name, str):
                seen_names.add(name)
            if kind == "shape":
                if not isinstance(item.get("hasText"), bool):
                    failures.append(failure("SS001", "Shapes must declare hasText.", slide=number, object_name_value=name))
                if item.get("hasText") and (not isinstance(item.get("textSha256"), str) or not SHA256_RE.fullmatch(item.get("textSha256", ""))):
                    failures.append(failure("SS001", "Text-bearing shapes must declare textSha256.", slide=number, object_name_value=name))
                if not item.get("hasText") and item.get("textSha256") is not None:
                    failures.append(failure("SS001", "Text-free shapes cannot declare textSha256.", slide=number, object_name_value=name))
            elif kind == "group":
                if not isinstance(item.get("childCount"), int) or item.get("childCount") < 0:
                    failures.append(failure("SS001", "Groups must declare childCount.", slide=number, object_name_value=name))
                has_nested_group = has_nested_group or bool(path)
            elif kind == "chart":
                if not isinstance(item.get("relationshipTarget"), str) or not item.get("relationshipTarget"):
                    failures.append(failure("SS001", "Charts must declare relationshipTarget.", slide=number, object_name_value=name))
                digest = item.get("partSha256")
                if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
                    failures.append(failure("SS001", "Charts must declare partSha256.", slide=number, object_name_value=name))
            elif kind == "table":
                if not isinstance(item.get("rows"), int) or item.get("rows") < 1 or not isinstance(item.get("columns"), int) or item.get("columns") < 1:
                    failures.append(failure("SS001", "Tables must declare positive rows and columns.", slide=number, object_name_value=name))
                if not isinstance(item.get("cellsSha256"), str) or not SHA256_RE.fullmatch(item.get("cellsSha256", "")):
                    failures.append(failure("SS001", "Tables must declare cellsSha256.", slide=number, object_name_value=name))
            elif kind == "connector":
                for endpoint in ("from", "to"):
                    value = item.get(endpoint)
                    if not isinstance(value, dict) or not isinstance(value.get("name"), str) or not value.get("name") or not isinstance(value.get("idx"), int):
                        failures.append(failure("SS001", f"Connectors must declare {endpoint}.name and {endpoint}.idx.", slide=number, object_name_value=name))
            elif kind == "image":
                if not isinstance(item.get("mediaTarget"), str) or not item.get("mediaTarget"):
                    failures.append(failure("SS001", "Images must declare mediaTarget.", slide=number, object_name_value=name))
                if not isinstance(item.get("mediaSha256"), str) or not SHA256_RE.fullmatch(item.get("mediaSha256", "")):
                    failures.append(failure("SS001", "Images must declare mediaSha256.", slide=number, object_name_value=name))
                if not isinstance(item.get("alt"), str) or not item.get("alt").strip():
                    failures.append(failure("SS001", "Images must declare non-empty alt text.", slide=number, object_name_value=name))
    missing_types = sorted(REQUIRED_TYPES - expected_types)
    if missing_types:
        failures.append(failure("SS001", "The semantic surface manifest does not cover every required object type.", expected=sorted(REQUIRED_TYPES), actual=sorted(expected_types)))
    if not has_notes:
        failures.append(failure("SS001", "The semantic surface manifest must contain meaningful speaker notes."))
    if not has_nested_group:
        failures.append(failure("SS001", "The semantic surface manifest must contain a nested group."))
    return failures


def compare_object(expected: dict[str, Any], actual: dict[str, Any], slide: int, failures: list[dict[str, Any]], *, allow_relationship_rebase: bool = False) -> None:
    name = expected["name"]
    fields = ["type", "groupPath", "zOrder"]
    if expected["type"] == "shape":
        fields.append("hasText")
        if expected.get("hasText"):
            fields.append("textSha256")
    elif expected["type"] == "group":
        fields.append("childCount")
    elif expected["type"] == "chart":
        if not allow_relationship_rebase:
            fields.extend(["relationshipTarget", "partSha256"])
    elif expected["type"] == "table":
        fields.extend(["rows", "columns", "cellsSha256"])
    elif expected["type"] == "connector":
        fields.extend(["from", "to"])
    elif expected["type"] == "image":
        if not allow_relationship_rebase:
            fields.append("mediaTarget")
        fields.extend(["mediaSha256", "alt"])
    for field in fields:
        if expected.get(field) != actual.get(field):
            failures.append(failure("SS004", f"Semantic field {field} does not match.", slide=slide, object_name_value=name, expected=expected.get(field), actual=actual.get(field)))
    if actual["type"] == "chart":
        if actual.get("graphicDataUri") != CHART_URI or actual.get("relationshipType") != CHART_REL or actual.get("relationshipExternal") or not actual.get("partExists"):
            failures.append(failure("SS005", "Chart is not backed by one valid internal native-chart relationship.", slide=slide, object_name_value=name, actual={key: actual.get(key) for key in ("graphicDataUri", "relationshipType", "relationshipTarget", "relationshipExternal", "partExists")}))
    elif actual["type"] == "table":
        if actual.get("graphicDataUri") != TABLE_URI:
            failures.append(failure("SS006", "Table is not an inline native DrawingML table graphic frame.", slide=slide, object_name_value=name, actual=actual.get("graphicDataUri")))
    elif actual["type"] == "connector":
        if actual.get("from") is None or actual.get("to") is None or actual.get("from", {}).get("name") is None or actual.get("to", {}).get("name") is None:
            failures.append(failure("SS007", "Connector endpoints are detached or resolve outside the declared object inventory.", slide=slide, object_name_value=name, actual={"from": actual.get("from"), "to": actual.get("to")}))
    elif actual["type"] == "image":
        if actual.get("relationshipType") != IMAGE_REL or actual.get("relationshipExternal") or not actual.get("mediaExists"):
            failures.append(failure("SS008", "Image is not backed by one valid internal media relationship.", slide=slide, object_name_value=name, actual={key: actual.get(key) for key in ("relationshipType", "mediaTarget", "relationshipExternal", "mediaExists")}))


def audit_semantic_surface(pptx_path: Path, manifest: dict[str, Any], *, allow_relationship_rebase: bool = False) -> dict[str, Any]:
    failures = validate_manifest(manifest)
    report: dict[str, Any] = {
        "version": "semantic-surface-audit-v1",
        "valid": False,
        "checks": {},
        "summary": {},
        "slides": [],
        "failures": failures,
    }
    if failures:
        report["summary"] = {"slides": 0, "objects": 0, "countsByType": {}}
        return report
    try:
        with zipfile.ZipFile(pptx_path) as archive:
            corrupt = archive.testzip()
            if corrupt:
                report["failures"].append(failure("SS002", f"ZIP member failed CRC validation: {corrupt}"))
            parts = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    except (OSError, zipfile.BadZipFile, KeyError) as error:
        report["failures"].append(failure("SS002", f"PowerPoint package could not be read: {error}"))
        report["summary"] = {"slides": 0, "objects": 0, "countsByType": {}}
        return report

    slide_parts = sorted(
        (name for name in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
        key=lambda name: int(re.search(r"(\d+)", posixpath.basename(name)).group(1)),
    )
    expected_slides = manifest["slides"]
    expected_order = [f"ppt/slides/slide{item['slide']}.xml" for item in expected_slides]
    actual_order, order_error = presentation_slide_order(parts)
    if order_error:
        report["failures"].append(failure("SS003", f"Presentation slide order is invalid: {order_error}"))
    elif actual_order != expected_order:
        report["failures"].append(failure("SS003", "Presentation slide order does not match the manifest.", expected=expected_order, actual=actual_order))
    if len(slide_parts) != len(expected_slides):
        report["failures"].append(failure("SS003", "Slide count does not match the manifest.", expected=len(expected_slides), actual=len(slide_parts)))
    total_counts: Counter[str] = Counter()
    total_objects = 0
    for expected_slide in expected_slides:
        number = expected_slide["slide"]
        slide_part = f"ppt/slides/slide{number}.xml"
        if slide_part not in parts:
            report["failures"].append(failure("SS003", "Expected slide part is missing.", slide=number, expected=slide_part))
            continue
        try:
            root = ET.fromstring(parts[slide_part])
        except ET.ParseError as error:
            report["failures"].append(failure("SS003", f"Slide XML is invalid: {error}", slide=number))
            continue
        records, names_by_id = enumerate_objects(root)
        enrich_objects(parts, slide_part, records, names_by_id)
        actual_objects = [public_record(record) for record in records]
        total_objects += len(actual_objects)
        total_counts.update(item["type"] for item in actual_objects)
        notes_text, notes_error = slide_notes(parts, slide_part)
        if notes_error:
            report["failures"].append(failure("SS009", notes_error, slide=number))
        if notes_text != expected_slide["notesText"]:
            report["failures"].append(failure("SS009", "Speaker notes text does not match.", slide=number, expected=expected_slide["notesText"], actual=notes_text))
        expected_objects = expected_slide["objects"]
        expected_index = {object_key(item): item for item in expected_objects}
        actual_index = {object_key(item): item for item in actual_objects}
        expected_keys = set(expected_index)
        actual_keys = set(actual_index)
        for key in sorted(expected_keys - actual_keys):
            report["failures"].append(failure("SS004", "Declared semantic object is missing.", slide=number, object_name_value=key[1], expected={"groupPath": list(key[0]), "name": key[1]}))
        for key in sorted(actual_keys - expected_keys):
            report["failures"].append(failure("SS004", "Undeclared semantic object is present.", slide=number, object_name_value=key[1], actual={"groupPath": list(key[0]), "name": key[1], "type": actual_index[key]["type"]}))
        if len(actual_objects) != len(actual_index):
            report["failures"].append(failure("SS004", "Actual object identities are duplicated within one group path.", slide=number, expected=len(actual_objects), actual=len(actual_index)))
        for key in sorted(expected_keys & actual_keys):
            compare_object(expected_index[key], actual_index[key], number, report["failures"], allow_relationship_rebase=allow_relationship_rebase)
        slide_relationships = parse_relationships(parts, slide_part)
        actual_semantic_relationships = sorted(
            (item["type"], item["target"])
            for item in slide_relationships.values()
            if not item["external"] and item["type"] in {CHART_REL, IMAGE_REL}
        )
        expected_semantic_relationships = sorted(
            (CHART_REL, item["relationshipTarget"]) if item["type"] == "chart" else (IMAGE_REL, item["mediaTarget"])
            for item in expected_objects
            if item["type"] in {"chart", "image"}
        )
        relationship_inventory_matches = (
            Counter(item[0] for item in actual_semantic_relationships) == Counter(item[0] for item in expected_semantic_relationships)
            if allow_relationship_rebase
            else actual_semantic_relationships == expected_semantic_relationships
        )
        if not relationship_inventory_matches:
            report["failures"].append(failure("SS004", "Native chart/image relationship inventory does not exactly match declared semantic objects.", slide=number, expected=expected_semantic_relationships, actual=actual_semantic_relationships))
        report["slides"].append({
            "slide": number,
            "notesText": notes_text,
            "objectCount": len(actual_objects),
            "countsByType": dict(sorted(Counter(item["type"] for item in actual_objects).items())),
            "semanticRelationships": actual_semantic_relationships,
            "objects": actual_objects,
        })

    report["failures"].sort(key=lambda item: (item.get("slide", 0), item.get("object", ""), item["code"], item["message"]))
    checks = {
        "packageReadable": not any(item["code"] == "SS002" for item in report["failures"]),
        "exactSlides": not any(item["code"] == "SS003" for item in report["failures"]),
        "exactRecursiveInventory": not any(item["code"] == "SS004" for item in report["failures"]),
        "nativeChartRelationships": not any(item["code"] == "SS005" for item in report["failures"]),
        "nativeTables": not any(item["code"] == "SS006" for item in report["failures"]),
        "attachedConnectors": not any(item["code"] == "SS007" for item in report["failures"]),
        "declaredImages": not any(item["code"] == "SS008" for item in report["failures"]),
        "exactSpeakerNotes": not any(item["code"] == "SS009" for item in report["failures"]),
    }
    report["checks"] = checks
    report["summary"] = {
        "slides": len(report["slides"]),
        "objects": total_objects,
        "countsByType": dict(sorted(total_counts.items())),
        "meaningfulNotesSlides": sum(1 for item in report["slides"] if item["notesText"].strip()),
        "nestedObjects": sum(1 for item in report["slides"] for obj in item["objects"] if obj["groupPath"]),
        "failures": len(report["failures"]),
        "relationshipRebaseAllowed": allow_relationship_rebase,
    }
    report["valid"] = not report["failures"] and all(checks.values())
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", type=Path)
    parser.add_argument("manifest_positional", nargs="?", type=Path, help="Backward-compatible frozen manifest path.")
    parser.add_argument("--manifest", dest="manifest_path", type=Path, help="Frozen semantic-surface-v1 manifest to verify.")
    parser.add_argument("--contract", dest="contract_path", type=Path, help="Authored slidewright-semantic-surface/v1 contract to verify separately.")
    parser.add_argument("--freeze-manifest", dest="freeze_path", type=Path, help="Freeze exact exported structure after the authored contract passes.")
    parser.add_argument("--allow-relationship-rebase", action="store_true", help="For a real PowerPoint SaveAs round trip only: allow valid internal chart/image targets to be renamed while retaining exact objects, data, media hashes, and alt text.")
    parser.add_argument("--json", dest="json_path", type=Path)
    args = parser.parse_args()
    if not args.pptx.is_file():
        parser.error(f"PPTX not found: {args.pptx}")
    manifest_path = args.manifest_path or args.manifest_positional
    if args.manifest_path and args.manifest_positional:
        parser.error("Pass the frozen manifest either positionally or with --manifest, not both.")
    contract = None
    if args.contract_path:
        if not args.contract_path.is_file():
            parser.error(f"Authored contract not found: {args.contract_path}")
        try:
            contract = json.loads(args.contract_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            parser.error(f"Authored contract could not be read: {error}")

    if args.freeze_path:
        if args.allow_relationship_rebase:
            parser.error("--allow-relationship-rebase is only valid for strict round-trip verification, not manifest freezing.")
        if manifest_path:
            parser.error("--freeze-manifest cannot be combined with an input frozen manifest.")
        if contract is None or args.contract_path is None:
            parser.error("--freeze-manifest requires --contract.")
        manifest, contract_failures = freeze_manifest_from_contract(args.pptx, contract, args.contract_path)
        if manifest is None:
            report = {
                "version": "semantic-surface-freeze-v1",
                "valid": False,
                "mode": "freeze",
                "contractValid": False,
                "manifestWritten": False,
                "failures": sorted(contract_failures, key=lambda item: (item.get("slide", 0), item.get("object", ""), item["code"])),
            }
        else:
            strict_report = audit_semantic_surface(args.pptx, manifest)
            if strict_report["valid"]:
                args.freeze_path.parent.mkdir(parents=True, exist_ok=True)
                args.freeze_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            report = {
                "version": "semantic-surface-freeze-v1",
                "valid": strict_report["valid"],
                "mode": "freeze",
                "contractValid": True,
                "manifestWritten": strict_report["valid"],
                "manifest": str(args.freeze_path.resolve()) if strict_report["valid"] else None,
                "summary": strict_report["summary"],
                "checks": strict_report["checks"],
                "failures": strict_report["failures"],
            }
    else:
        if manifest_path is None or not manifest_path.is_file():
            parser.error("Strict verification requires --manifest <frozen.json>.")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            parser.error(f"Frozen manifest could not be read: {error}")
        report = audit_semantic_surface(args.pptx, manifest, allow_relationship_rebase=args.allow_relationship_rebase)
        report["relationshipRebaseAllowed"] = args.allow_relationship_rebase
        if contract is not None and args.contract_path is not None:
            contract_failures, _ = validate_authored_contract(args.pptx, contract, args.contract_path)
            report["contractValid"] = not contract_failures
            report["contractFailures"] = sorted(contract_failures, key=lambda item: (item.get("slide", 0), item.get("object", ""), item["code"]))
            report["checks"]["authoredContract"] = not contract_failures
            if contract_failures:
                report["failures"].extend(report["contractFailures"])
                report["failures"].sort(key=lambda item: (item.get("slide", 0), item.get("object", ""), item["code"], item["message"]))
                report["summary"]["failures"] = len(report["failures"])
                report["valid"] = False
    payload = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.json_path:
        args.json_path.parent.mkdir(parents=True, exist_ok=True)
        args.json_path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
