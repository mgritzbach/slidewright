#!/usr/bin/env python3
"""Independent structural comparator for C17 evidence.

This auditor deliberately does not import or call the producer implementation.
It re-derives seven semantic surfaces directly from both OPC packages.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS = {"p": P, "a": A, "r": R, "c": C}
SHAPES = {"sp", "grpSp", "pic", "graphicFrame", "cxnSp"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable(value: object) -> str:
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))


def lname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def package(path: Path) -> dict[str, bytes]:
    result: dict[str, bytes] = {}
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            name = entry.filename.replace("\\", "/")
            if name in result or name.startswith("/") or ".." in name.split("/"):
                raise ValueError(f"Unsafe or duplicate part: {name}")
            result[name] = archive.read(entry)
    return result


def rels_name(owner: str) -> str:
    folder, name = posixpath.split(owner)
    return posixpath.join(folder, "_rels", name + ".rels")


def link_map(parts: dict[str, bytes], owner: str) -> dict[str, tuple[str, str, bool]]:
    name = rels_name(owner)
    if name not in parts:
        return {}
    found = {}
    for item in ET.fromstring(parts[name]):
        external = item.get("TargetMode") == "External"
        target = item.get("Target", "")
        if not external:
            target = posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)).lstrip("/")
        found[item.get("Id", "")] = (item.get("Type", ""), target, external)
    return found


def one_link(parts: dict[str, bytes], owner: str | None, suffix: str) -> str | None:
    if owner is None:
        return None
    matches = [target for relation_type, target, external in link_map(parts, owner).values() if not external and relation_type.endswith(suffix)]
    return matches[0] if len(matches) == 1 else None


def slide_list(parts: dict[str, bytes]) -> list[tuple[str, str]]:
    root = ET.fromstring(parts["ppt/presentation.xml"])
    links = link_map(parts, "ppt/presentation.xml")
    result = []
    for item in root.findall(".//p:sldId", NS):
        relation_id = item.get(f"{{{R}}}id", "")
        relation = links.get(relation_id)
        if relation and not relation[2]:
            result.append((item.get("id", ""), relation[1]))
    return result


def identity(node: ET.Element) -> tuple[str, str]:
    props = node.find(".//p:cNvPr", NS)
    return (props.get("id", "") if props is not None else "", props.get("name", "") if props is not None else "")


def walk(node: ET.Element, path: list[int]):
    yield node, path
    if lname(node.tag) == "grpSp":
        children = [item for item in list(node) if lname(item.tag) in SHAPES]
        for index, child in enumerate(children):
            yield from walk(child, path + [index])


def scan(parts: dict[str, bytes]) -> dict[str, object]:
    hierarchy = []
    text_runs = []
    tables = []
    diagrams = []
    charts = []
    notes = []
    reading_order = []
    chart_bindings: dict[str, list[dict[str, object]]] = {}
    slide_items = slide_list(parts)
    for slide_index, (slide_id, slide_part) in enumerate(slide_items, 1):
        layout = one_link(parts, slide_part, "/slideLayout")
        master = one_link(parts, layout, "/slideMaster")
        theme = one_link(parts, master, "/theme")
        hierarchy.append({"slide": slide_index, "slideId": slide_id, "part": slide_part, "layout": layout, "master": master, "theme": theme})
        root = ET.fromstring(parts[slide_part])
        tree = root.find(".//p:spTree", NS)
        top = [item for item in list(tree) if lname(item.tag) in SHAPES] if tree is not None else []
        for top_index, item in enumerate(top):
            for node, order_path in walk(item, [top_index]):
                object_id, name = identity(node)
                reading_order.append({"slide": slide_index, "path": order_path, "type": lname(node.tag), "id": object_id, "name": name})
                if lname(node.tag) != "grpSp":
                    for paragraph_index, paragraph in enumerate(node.findall(".//a:p", NS)):
                        for run_index, run in enumerate(child for child in list(paragraph) if lname(child.tag) in {"r", "fld", "br"}):
                            props = run.find("a:rPr", NS)
                            text_runs.append({
                                "slide": slide_index, "objectId": object_id, "paragraph": paragraph_index, "run": run_index,
                                "kind": lname(run.tag), "text": "".join(value.text or "" for value in run.findall(".//a:t", NS)),
                                "properties": sha(ET.tostring(props, encoding="utf-8")) if props is not None else None,
                            })
                if lname(node.tag) == "graphicFrame":
                    for table_index, table in enumerate(node.findall(".//a:tbl", NS)):
                        matrix = [["".join(value.text or "" for value in cell.findall(".//a:t", NS)) for cell in row.findall("a:tc", NS)] for row in table.findall("a:tr", NS)]
                        tables.append({"slide": slide_index, "objectId": object_id, "table": table_index, "matrix": matrix, "xml": sha(ET.tostring(table, encoding="utf-8"))})
                    owner_links = link_map(parts, slide_part)
                    for chart in node.findall(".//c:chart", NS):
                        relation_id = chart.get(f"{{{R}}}id", "")
                        relation = owner_links.get(relation_id)
                        if relation and not relation[2]:
                            chart_bindings.setdefault(relation[1], []).append({"slide": slide_index, "objectId": object_id, "relationshipId": relation_id})
                if lname(node.tag) == "grpSp":
                    diagrams.append({"slide": slide_index, "objectId": object_id, "kind": "native-shape-group", "xml": sha(ET.tostring(node, encoding="utf-8"))})
                if lname(node.tag) == "graphicFrame":
                    owner_links = link_map(parts, slide_part)
                    diagram_targets = []
                    for descendant in node.iter():
                        relation_id = descendant.get(f"{{{R}}}id")
                        relation = owner_links.get(relation_id or "")
                        if relation and not relation[2] and relation[1].startswith("ppt/diagrams/") and relation[1] in parts:
                            diagram_targets.append({"part": relation[1], "sha256": sha(parts[relation[1]])})
                    if diagram_targets:
                        diagrams.append({"slide": slide_index, "objectId": object_id, "kind": "smartart", "parts": diagram_targets})
        notes_part = one_link(parts, slide_part, "/notesSlide")
        if notes_part and notes_part in parts:
            note_root = ET.fromstring(parts[notes_part])
            notes.append({"slide": slide_index, "part": notes_part, "text": "\n".join(item.text or "" for item in note_root.findall(".//a:t", NS)), "xml": sha(parts[notes_part])})
    for chart_part in sorted(name for name in parts if re.fullmatch(r"ppt/charts/chart\d+\.xml", name)):
        root = ET.fromstring(parts[chart_part])
        charts.append({"part": chart_part, "xml": sha(parts[chart_part]), "values": [item.text or "" for item in root.findall(".//c:v", NS)], "formulas": [item.text or "" for item in root.findall(".//c:f", NS)], "bindings": chart_bindings.get(chart_part, [])})
    masters = sorted(name for name in parts if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name))
    layouts = sorted(name for name in parts if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", name))
    return {
        "hierarchy": {"bindings": hierarchy, "masters": masters, "layouts": layouts},
        "textRuns": sorted(text_runs, key=lambda item: (item["slide"], item["objectId"], item["paragraph"], item["run"])),
        "tables": tables, "diagrams": diagrams, "charts": charts, "notes": notes, "readingOrder": reading_order,
        "summary": {"slides": len(slide_items), "masters": len(masters), "layouts": len(layouts), "textRuns": len(text_runs), "tables": len(tables), "diagrams": len(diagrams), "charts": len(charts), "notes": len(notes)},
        "parts": {name: sha(parts[name]) for name in sorted(parts)},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--json", required=True, type=Path)
    args = parser.parse_args()
    source_parts = package(args.source)
    candidate_parts = package(args.candidate)
    left = scan(source_parts)
    right = scan(candidate_parts)
    checks = [
        ("SI_HIERARCHY", "hierarchy"), ("SI_TEXT_RUNS", "textRuns"), ("SI_TABLES", "tables"),
        ("SI_DIAGRAMS", "diagrams"), ("SI_CHARTS", "charts"), ("SI_NOTES", "notes"),
        ("SI_READING_ORDER", "readingOrder"),
    ]
    failures = []
    surface_hashes = {}
    for code, key in checks:
        source_hash, candidate_hash = stable(left[key]), stable(right[key])
        surface_hashes[key] = {"source": source_hash, "candidate": candidate_hash, "equal": source_hash == candidate_hash}
        if source_hash != candidate_hash:
            failures.append({"code": code, "surface": key})
    package_equal = left["parts"] == right["parts"]
    if not package_equal:
        failures.append({"code": "SI_PACKAGE_PARTS", "surface": "parts"})
    report = {
        "schemaVersion": "slidewright-structural-ingestion-audit/v1",
        "valid": not failures,
        "sourceSha256": sha(args.source.read_bytes()),
        "candidateSha256": sha(args.candidate.read_bytes()),
        "sourceSummary": left["summary"],
        "candidateSummary": right["summary"],
        "surfaceHashes": surface_hashes,
        "exactPartInventoryAndBytes": package_equal,
        "sourcePartTreeSha256": stable(left["parts"]),
        "candidatePartTreeSha256": stable(right["parts"]),
        "failures": failures,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"valid": report["valid"], "failures": failures, "summary": left["summary"]}, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
