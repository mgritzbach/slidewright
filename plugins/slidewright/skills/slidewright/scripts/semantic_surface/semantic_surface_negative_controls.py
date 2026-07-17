#!/usr/bin/env python3
"""Generate and verify destructive controls for semantic-surface-v1.

Every control is made independently from a baseline that must already pass the
semantic-surface audit.  The command fails if a mutation is not rejected.
"""

from __future__ import annotations

import argparse
import copy
import json
import posixpath
from pathlib import Path
import re
import sys
from typing import Any, Callable
import zipfile
import xml.etree.ElementTree as ET

from audit_semantic_surface import (
    A,
    CHART_REL,
    IMAGE_REL,
    NS,
    P,
    Q,
    R,
    REL,
    REQUIRED_TYPES,
    audit_semantic_surface,
    object_id,
    object_name,
    relationship_part,
    resolve_target,
)


for prefix, uri in (("a", A), ("p", P), ("r", R)):
    ET.register_namespace(prefix, uri)
ET.register_namespace("", REL)


def read_package(path: Path) -> tuple[list[zipfile.ZipInfo], dict[str, bytes]]:
    with zipfile.ZipFile(path) as archive:
        infos = [copy.copy(item) for item in archive.infolist() if not item.is_dir()]
        parts = {item.filename: archive.read(item.filename) for item in infos}
    return infos, parts


def write_package(path: Path, infos: list[zipfile.ZipInfo], parts: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    with zipfile.ZipFile(path, "w") as archive:
        for info in infos:
            if info.filename not in parts:
                continue
            archive.writestr(info, parts[info.filename])
            seen.add(info.filename)
        for name in sorted(set(parts) - seen):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, parts[name])


def serialize(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def slide_part(slide: int) -> str:
    return f"ppt/slides/slide{slide}.xml"


def drawable_children(container: ET.Element) -> list[ET.Element]:
    tags = {Q(P, "sp"), Q(P, "grpSp"), Q(P, "graphicFrame"), Q(P, "cxnSp"), Q(P, "pic")}
    return [child for child in list(container) if child.tag in tags]


def iter_objects(container: ET.Element, path: tuple[str, ...] = ()):
    for child in drawable_children(container):
        yield path, child, container
        if child.tag == Q(P, "grpSp"):
            yield from iter_objects(child, (*path, object_name(child)))


def locate(parts: dict[str, bytes], declaration: dict[str, Any], slide: int) -> tuple[str, ET.Element, ET.Element, ET.Element]:
    part = slide_part(slide)
    root = ET.fromstring(parts[part])
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError(f"Slide {slide} has no shape tree.")
    expected_path = tuple(declaration["groupPath"])
    for path, element, parent in iter_objects(tree):
        if path == expected_path and object_name(element) == declaration["name"]:
            return part, root, element, parent
    raise ValueError(f"Could not locate {declaration['name']!r} on slide {slide} at {list(expected_path)!r}.")


def first_declaration(manifest: dict[str, Any], kind: str, *, nested: bool | None = None) -> tuple[int, dict[str, Any]]:
    for slide in manifest["slides"]:
        for item in slide["objects"]:
            if item["type"] != kind:
                continue
            if nested is not None and bool(item["groupPath"]) != nested:
                continue
            return slide["slide"], item
    raise ValueError(f"Manifest has no suitable {kind} declaration.")


def all_numeric_ids(root: ET.Element) -> list[int]:
    result: list[int] = []
    for element in root.iter():
        if element.tag != Q(P, "cNvPr"):
            continue
        raw = element.get("id")
        if raw and raw.isdigit():
            result.append(int(raw))
    return result


def find_relationship(root: ET.Element, rel_id: str) -> ET.Element:
    item = next((node for node in root if node.get("Id") == rel_id), None)
    if item is None:
        raise ValueError(f"Relationship {rel_id!r} was not found.")
    return item


def next_relationship_id(root: ET.Element, stem: str) -> str:
    used = {item.get("Id") for item in root}
    candidate = stem
    index = 1
    while candidate in used:
        index += 1
        candidate = f"{stem}{index}"
    return candidate


def relative_relationship_target(owner: str, target: str) -> str:
    return posixpath.relpath(target, posixpath.dirname(owner))


def picture_from_frame(frame: ET.Element, rel_id: str) -> ET.Element:
    props = frame.find("p:nvGraphicFramePr/p:cNvPr", NS)
    if props is None:
        raise ValueError("Chart frame is missing non-visual properties.")
    picture = ET.Element(Q(P, "pic"))
    nv = ET.SubElement(picture, Q(P, "nvPicPr"))
    ET.SubElement(nv, Q(P, "cNvPr"), {
        "id": props.get("id", "1"),
        "name": props.get("name", "flattened-chart"),
        "descr": "Deliberately flattened chart negative control",
    })
    cnv = ET.SubElement(nv, Q(P, "cNvPicPr"))
    ET.SubElement(cnv, Q(A, "picLocks"), {"noChangeAspect": "1"})
    ET.SubElement(nv, Q(P, "nvPr"))
    blip_fill = ET.SubElement(picture, Q(P, "blipFill"))
    ET.SubElement(blip_fill, Q(A, "blip"), {Q(R, "embed"): rel_id})
    stretch = ET.SubElement(blip_fill, Q(A, "stretch"))
    ET.SubElement(stretch, Q(A, "fillRect"))
    shape_props = ET.SubElement(picture, Q(P, "spPr"))
    source_xfrm = frame.find("p:xfrm", NS)
    xfrm = ET.SubElement(shape_props, Q(A, "xfrm"))
    if source_xfrm is not None:
        xfrm.attrib.update(source_xfrm.attrib)
        for child in list(source_xfrm):
            xfrm.append(copy.deepcopy(child))
    geometry = ET.SubElement(shape_props, Q(A, "prstGeom"), {"prst": "rect"})
    ET.SubElement(geometry, Q(A, "avLst"))
    return picture


def flattened_table_group(frame: ET.Element, child_id: int) -> ET.Element:
    props = frame.find("p:nvGraphicFramePr/p:cNvPr", NS)
    if props is None:
        raise ValueError("Table frame is missing non-visual properties.")
    source_xfrm = frame.find("p:xfrm", NS)
    off = source_xfrm.find("a:off", NS) if source_xfrm is not None else None
    ext = source_xfrm.find("a:ext", NS) if source_xfrm is not None else None
    values = {
        "x": off.get("x", "0") if off is not None else "0",
        "y": off.get("y", "0") if off is not None else "0",
        "cx": ext.get("cx", "1") if ext is not None else "1",
        "cy": ext.get("cy", "1") if ext is not None else "1",
    }
    group = ET.Element(Q(P, "grpSp"))
    nv = ET.SubElement(group, Q(P, "nvGrpSpPr"))
    ET.SubElement(nv, Q(P, "cNvPr"), {"id": props.get("id", "1"), "name": props.get("name", "flattened-table")})
    ET.SubElement(nv, Q(P, "cNvGrpSpPr"))
    ET.SubElement(nv, Q(P, "nvPr"))
    group_props = ET.SubElement(group, Q(P, "grpSpPr"))
    transform = ET.SubElement(group_props, Q(A, "xfrm"))
    ET.SubElement(transform, Q(A, "off"), {"x": values["x"], "y": values["y"]})
    ET.SubElement(transform, Q(A, "ext"), {"cx": values["cx"], "cy": values["cy"]})
    ET.SubElement(transform, Q(A, "chOff"), {"x": values["x"], "y": values["y"]})
    ET.SubElement(transform, Q(A, "chExt"), {"cx": values["cx"], "cy": values["cy"]})

    shape = ET.SubElement(group, Q(P, "sp"))
    shape_nv = ET.SubElement(shape, Q(P, "nvSpPr"))
    ET.SubElement(shape_nv, Q(P, "cNvPr"), {"id": str(child_id), "name": f"{props.get('name', 'table')}-flattened-cell"})
    ET.SubElement(shape_nv, Q(P, "cNvSpPr"))
    ET.SubElement(shape_nv, Q(P, "nvPr"))
    shape_props = ET.SubElement(shape, Q(P, "spPr"))
    shape_transform = ET.SubElement(shape_props, Q(A, "xfrm"))
    ET.SubElement(shape_transform, Q(A, "off"), {"x": values["x"], "y": values["y"]})
    ET.SubElement(shape_transform, Q(A, "ext"), {"cx": values["cx"], "cy": values["cy"]})
    geometry = ET.SubElement(shape_props, Q(A, "prstGeom"), {"prst": "rect"})
    ET.SubElement(geometry, Q(A, "avLst"))
    return group


def mutate_chart_flatten(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    chart_slide, chart = first_declaration(manifest, "chart")
    image_slide, image = first_declaration(manifest, "image")
    part, root, element, parent = locate(parts, chart, chart_slide)
    media_target = image["mediaTarget"]
    if media_target not in parts:
        raise ValueError(f"Declared media target is missing: {media_target}")
    rel_part = relationship_part(part)
    rel_root = ET.fromstring(parts[rel_part])
    rel_id = next_relationship_id(rel_root, "rIdSemanticSurfaceFlatten")
    ET.SubElement(rel_root, Q(REL, "Relationship"), {
        "Id": rel_id,
        "Type": IMAGE_REL,
        "Target": relative_relationship_target(part, media_target),
    })
    index = list(parent).index(element)
    parent.remove(element)
    parent.insert(index, picture_from_frame(element, rel_id))
    parts[part] = serialize(root)
    parts[rel_part] = serialize(rel_root)


def mutate_chart_relation(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide, declaration = first_declaration(manifest, "chart")
    part, root, element, _ = locate(parts, declaration, slide)
    chart = element.find("a:graphic/a:graphicData/c:chart", NS)
    rel_id = chart.get(Q(R, "id")) if chart is not None else None
    if not rel_id:
        raise ValueError("Native chart has no relationship id.")
    rel_part = relationship_part(part)
    rel_root = ET.fromstring(parts[rel_part])
    relationship = find_relationship(rel_root, rel_id)
    relationship.set("Type", CHART_REL)
    relationship.set("Target", "../charts/missing-semantic-surface-chart.xml")
    parts[rel_part] = serialize(rel_root)


def mutate_table_flatten(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide, declaration = first_declaration(manifest, "table")
    part, root, element, parent = locate(parts, declaration, slide)
    child_id = max(all_numeric_ids(root), default=1) + 1
    index = list(parent).index(element)
    parent.remove(element)
    parent.insert(index, flattened_table_group(element, child_id))
    parts[part] = serialize(root)


def mutate_connector_detach(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide, declaration = first_declaration(manifest, "connector")
    part, root, element, _ = locate(parts, declaration, slide)
    props = element.find("p:nvCxnSpPr/p:cNvCxnSpPr", NS)
    if props is None:
        raise ValueError("Connector has no non-visual connector properties.")
    endpoints = [child for child in list(props) if child.tag in {Q(A, "stCxn"), Q(A, "endCxn")}]
    if not endpoints:
        raise ValueError("Connector is already detached.")
    props.remove(endpoints[0])
    parts[part] = serialize(root)


def mutate_notes_strip(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide_entry = next(item for item in manifest["slides"] if item["notesText"].strip())
    part = slide_part(slide_entry["slide"])
    rel_part = relationship_part(part)
    rel_root = ET.fromstring(parts[rel_part])
    notes_rel = next((item for item in rel_root if item.get("Type", "").endswith("/notesSlide")), None)
    if notes_rel is None:
        raise ValueError("Meaningful notes slide has no notes relationship.")
    notes_part = resolve_target(part, notes_rel.get("Target", ""))
    root = ET.fromstring(parts[notes_part])
    changed = 0
    for shape in root.findall(".//p:sp", NS):
        placeholder = shape.find("p:nvSpPr/p:nvPr/p:ph", NS)
        placeholder_type = placeholder.get("type") if placeholder is not None else None
        if placeholder_type in {"sldImg", "sldNum", "hdr", "ftr", "dt"}:
            continue
        for text in shape.findall("p:txBody/a:p//a:t", NS):
            if text.text:
                text.text = ""
                changed += 1
    if not changed:
        raise ValueError("No meaningful notes text was available to strip.")
    parts[notes_part] = serialize(root)


def mutate_nested_group_flatten(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide, declaration = first_declaration(manifest, "group", nested=True)
    part, root, element, parent = locate(parts, declaration, slide)
    index = list(parent).index(element)
    children = [copy.deepcopy(child) for child in drawable_children(element)]
    parent.remove(element)
    for offset, child in enumerate(children):
        parent.insert(index + offset, child)
    parts[part] = serialize(root)


def mutate_hierarchy_drift(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    target: tuple[int, dict[str, Any]] | None = None
    for slide in manifest["slides"]:
        for item in slide["objects"]:
            if item["groupPath"] and item["type"] != "group":
                target = slide["slide"], item
                break
        if target:
            break
    if target is None:
        raise ValueError("No nested non-group object is available for hierarchy drift.")
    slide, declaration = target
    part, root, element, parent_group = locate(parts, declaration, slide)
    grandparent = next((candidate for candidate in root.iter() if parent_group in list(candidate)), None)
    if grandparent is None:
        raise ValueError("Nested object's parent group has no parent container.")
    insert_at = list(grandparent).index(parent_group) + 1
    parent_group.remove(element)
    grandparent.insert(insert_at, element)
    parts[part] = serialize(root)


def mutate_image_relation(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide, declaration = first_declaration(manifest, "image")
    part, _, element, _ = locate(parts, declaration, slide)
    blip = element.find("p:blipFill/a:blip", NS)
    rel_id = blip.get(Q(R, "embed")) if blip is not None else None
    if not rel_id:
        raise ValueError("Image has no embedded relationship id.")
    rel_part = relationship_part(part)
    rel_root = ET.fromstring(parts[rel_part])
    relationship = find_relationship(rel_root, rel_id)
    relationship.set("Type", IMAGE_REL)
    relationship.set("Target", "../media/missing-semantic-surface-image.png")
    parts[rel_part] = serialize(rel_root)


def mutate_undeclared_object(parts: dict[str, bytes], manifest: dict[str, Any]) -> None:
    slide, declaration = first_declaration(manifest, "shape")
    part, root, element, _ = locate(parts, declaration, slide)
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError("Slide has no top-level shape tree.")
    duplicate = copy.deepcopy(element)
    props = duplicate.find("p:nvSpPr/p:cNvPr", NS)
    if props is None:
        raise ValueError("Shape has no non-visual properties.")
    props.set("id", str(max(all_numeric_ids(root), default=1) + 1))
    props.set("name", "semantic-surface-undeclared-control")
    tree.append(duplicate)
    parts[part] = serialize(root)


CONTROLS: list[tuple[str, Callable[[dict[str, bytes], dict[str, Any]], None]]] = [
    ("chart-relation-break", mutate_chart_relation),
    ("chart-flatten", mutate_chart_flatten),
    ("table-flatten", mutate_table_flatten),
    ("connector-detach", mutate_connector_detach),
    ("notes-strip", mutate_notes_strip),
    ("nested-group-flatten", mutate_nested_group_flatten),
    ("hierarchy-drift", mutate_hierarchy_drift),
    ("image-relation-drift", mutate_image_relation),
    ("undeclared-object", mutate_undeclared_object),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--json", dest="json_path", type=Path)
    args = parser.parse_args()
    if not args.baseline.is_file():
        parser.error(f"Baseline PPTX not found: {args.baseline}")
    if not args.manifest.is_file():
        parser.error(f"Manifest not found: {args.manifest}")
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    infos, baseline_parts = read_package(args.baseline)
    baseline_report = audit_semantic_surface(args.baseline, manifest)
    if not baseline_report["valid"]:
        raise SystemExit("Baseline must pass semantic-surface-v1 before negative controls are generated.")
    declared = {item["type"] for slide in manifest["slides"] for item in slide["objects"]}
    if not REQUIRED_TYPES.issubset(declared):
        raise SystemExit("Baseline manifest does not cover the complete semantic surface.")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []
    for control_id, mutate in CONTROLS:
        parts = dict(baseline_parts)
        mutate(parts, manifest)
        output = args.output_dir / f"{control_id}.pptx"
        write_package(output, infos, parts)
        report = audit_semantic_surface(output, manifest)
        results.append({
            "id": control_id,
            "output": str(output.resolve()),
            "rejected": not report["valid"],
            "failureCodes": sorted({item["code"] for item in report["failures"]}),
            "failureCount": len(report["failures"]),
        })
    valid = all(item["rejected"] and item["failureCount"] > 0 for item in results)
    summary = {
        "version": "semantic-surface-negative-controls-v1",
        "valid": valid,
        "baselineValid": baseline_report["valid"],
        "controls": results,
        "rejected": sum(1 for item in results if item["rejected"]),
        "total": len(results),
    }
    payload = json.dumps(summary, indent=2) + "\n"
    report_path = args.json_path or args.output_dir / "negative-controls.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0 if valid else 2


if __name__ == "__main__":
    raise SystemExit(main())
