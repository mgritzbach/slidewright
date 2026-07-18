#!/usr/bin/env python3
"""Lossless PPTX package importer used by the C17 structural-ingestion benchmark.

The importer parses the OOXML graph into a semantic manifest and writes a new,
deterministic OPC container from the imported part map.  It never rasterizes or
reconstructs user content, so editable XML parts and relationship bindings stay
native.  The independent audit lives in structural-ingestion-audit.py.
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
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"

NS = {"p": P, "a": A, "r": R, "c": C}
SUPPORTED = {f"{{{P}}}sp", f"{{{P}}}grpSp", f"{{{P}}}pic", f"{{{P}}}graphicFrame", f"{{{P}}}cxnSp"}
FIXED_TIME = (1980, 1, 1, 0, 0, 0)

for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def read_parts(source: Path) -> dict[str, bytes]:
    parts: dict[str, bytes] = {}
    with zipfile.ZipFile(source) as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue
            name = item.filename.replace("\\", "/")
            if name.startswith("/") or ".." in name.split("/") or name in parts:
                raise ValueError(f"Unsafe or duplicate OPC part: {name}")
            parts[name] = archive.read(item)
    for required in ("[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"):
        if required not in parts:
            raise ValueError(f"Missing required OPC part: {required}")
    return parts


def write_parts(parts: dict[str, bytes], destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    # ZIP_STORED keeps the container byte-stable across zlib and Python builds;
    # semantic payloads are exact imported part bytes either way.
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(parts):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 0
            info.external_attr = 0
            archive.writestr(info, parts[name])


def rel_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    return posixpath.join(directory, "_rels", filename + ".rels")


def resolve(owner: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)).lstrip("/")


def relations(parts: dict[str, bytes], owner: str) -> dict[str, dict[str, object]]:
    relation_name = rel_part(owner)
    if relation_name not in parts:
        return {}
    result: dict[str, dict[str, object]] = {}
    for relation in ET.fromstring(parts[relation_name]):
        target = relation.get("Target", "")
        external = relation.get("TargetMode") == "External"
        result[relation.get("Id", "")] = {
            "type": relation.get("Type", ""),
            "target": target if external else resolve(owner, target),
            "external": external,
        }
    return result


def relation_target(parts: dict[str, bytes], owner: str, suffix: str) -> str | None:
    matches = [str(item["target"]) for item in relations(parts, owner).values() if not item["external"] and str(item["type"]).endswith(suffix)]
    return matches[0] if len(matches) == 1 else None


def object_identity(node: ET.Element) -> tuple[str, str]:
    props = node.find(".//p:cNvPr", NS)
    return (props.get("id", "") if props is not None else "", props.get("name", "") if props is not None else "")


def run_records(node: ET.Element) -> list[dict[str, object]]:
    records = []
    for paragraph_index, paragraph in enumerate(node.findall(".//a:p", NS)):
        for run_index, run in enumerate(child for child in list(paragraph) if local(child.tag) in {"r", "fld", "br"}):
            text = "" if local(run.tag) == "br" else "".join(item.text or "" for item in run.findall(".//a:t", NS))
            properties = run.find("a:rPr", NS)
            records.append({
                "paragraph": paragraph_index,
                "run": run_index,
                "kind": local(run.tag),
                "text": text,
                "propertiesSha256": digest(ET.tostring(properties, encoding="utf-8")) if properties is not None else None,
            })
    return records


def table_records(node: ET.Element) -> list[dict[str, object]]:
    result = []
    for table in node.findall(".//a:tbl", NS):
        rows = []
        for row in table.findall("a:tr", NS):
            rows.append(["".join(text.text or "" for text in cell.findall(".//a:t", NS)) for cell in row.findall("a:tc", NS)])
        result.append({"matrix": rows, "xmlSha256": digest(ET.tostring(table, encoding="utf-8"))})
    return result


def chart_records(parts: dict[str, bytes], owner: str, node: ET.Element) -> list[dict[str, object]]:
    rels = relations(parts, owner)
    result = []
    for chart in node.findall(".//c:chart", NS):
        relation = rels.get(chart.get(f"{{{R}}}id", ""))
        if not relation or relation["external"] or relation["target"] not in parts:
            continue
        target = str(relation["target"])
        chart_root = ET.fromstring(parts[target])
        result.append({
            "part": target,
            "partSha256": digest(parts[target]),
            "values": [item.text or "" for item in chart_root.findall(".//c:v", NS)],
            "formulas": [item.text or "" for item in chart_root.findall(".//c:f", NS)],
        })
    return result


def shape_record(parts: dict[str, bytes], owner: str, node: ET.Element, order_path: list[int]) -> dict[str, object]:
    shape_id, name = object_identity(node)
    record: dict[str, object] = {
        "orderPath": order_path,
        "type": local(node.tag),
        "id": shape_id,
        "name": name,
        "xmlSha256": digest(ET.tostring(node, encoding="utf-8")),
        "runs": [] if node.tag == f"{{{P}}}grpSp" else run_records(node),
        "tables": table_records(node) if node.tag == f"{{{P}}}graphicFrame" else [],
        "charts": chart_records(parts, owner, node) if node.tag == f"{{{P}}}graphicFrame" else [],
    }
    if node.tag == f"{{{P}}}grpSp":
        children = [child for child in list(node) if child.tag in SUPPORTED]
        record["diagramKind"] = "native-shape-group"
        record["children"] = [shape_record(parts, owner, child, order_path + [index]) for index, child in enumerate(children)]
    if node.tag == f"{{{P}}}graphicFrame":
        diagram_parts = []
        rels = relations(parts, owner)
        for descendant in node.iter():
            relation_id = descendant.get(f"{{{R}}}id")
            relation = rels.get(relation_id or "")
            if relation and not relation["external"] and str(relation["target"]).startswith("ppt/diagrams/") and relation["target"] in parts:
                target = str(relation["target"])
                diagram_parts.append({"part": target, "partSha256": digest(parts[target]), "relationshipType": relation["type"]})
        if diagram_parts:
            record["diagramKind"] = "smartart"
            record["diagramParts"] = diagram_parts
    return record


def slide_sequence(parts: dict[str, bytes]) -> list[tuple[str, str, str]]:
    root = ET.fromstring(parts["ppt/presentation.xml"])
    rels = relations(parts, "ppt/presentation.xml")
    result = []
    for slide in root.findall(".//p:sldId", NS):
        relation_id = slide.get(f"{{{R}}}id", "")
        relation = rels.get(relation_id)
        if relation and not relation["external"]:
            result.append((slide.get("id", ""), relation_id, str(relation["target"])))
    return result


def semantic_manifest(parts: dict[str, bytes]) -> dict[str, object]:
    slide_records = []
    total_runs = total_tables = total_charts = total_diagrams = total_notes = 0
    masters = sorted(name for name in parts if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name))
    layouts = sorted(name for name in parts if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", name))
    for index, (slide_id, relation_id, slide_part) in enumerate(slide_sequence(parts), 1):
        layout_part = relation_target(parts, slide_part, "/slideLayout")
        master_part = relation_target(parts, layout_part, "/slideMaster") if layout_part else None
        theme_part = relation_target(parts, master_part, "/theme") if master_part else None
        root = ET.fromstring(parts[slide_part])
        tree = root.find(".//p:spTree", NS)
        shapes = [child for child in list(tree) if child.tag in SUPPORTED] if tree is not None else []
        objects = [shape_record(parts, slide_part, child, [order]) for order, child in enumerate(shapes)]
        flat = []
        def visit(item: dict[str, object]) -> None:
            flat.append(item)
            for child in item.get("children", []):
                visit(child)
        for item in objects:
            visit(item)
        notes_part = relation_target(parts, slide_part, "/notesSlide")
        notes_text = ""
        if notes_part and notes_part in parts:
            notes_text = "\n".join(item.text or "" for item in ET.fromstring(parts[notes_part]).findall(".//a:t", NS))
            total_notes += 1
        total_runs += sum(len(item["runs"]) for item in flat)
        total_tables += sum(len(item["tables"]) for item in flat)
        total_charts += sum(len(item["charts"]) for item in flat)
        total_diagrams += sum(1 for item in flat if "diagramKind" in item)
        slide_records.append({
            "index": index,
            "slideId": slide_id,
            "relationshipId": relation_id,
            "part": slide_part,
            "layoutPart": layout_part,
            "masterPart": master_part,
            "themePart": theme_part,
            "readingOrder": [{"path": item["orderPath"], "id": item["id"], "name": item["name"], "type": item["type"]} for item in flat],
            "objects": objects,
            "notesPart": notes_part,
            "notesText": notes_text,
            "notesSha256": digest(parts[notes_part]) if notes_part and notes_part in parts else None,
        })
    manifest: dict[str, object] = {
        "schemaVersion": "slidewright-structural-import/v1",
        "package": {"partCount": len(parts), "parts": [{"part": name, "sha256": digest(parts[name]), "bytes": len(parts[name])} for name in sorted(parts)]},
        "hierarchy": {"slides": slide_records, "masters": masters, "layouts": layouts},
        "summary": {
            "slides": len(slide_records), "masters": len(masters), "layouts": len(layouts),
            "textRuns": total_runs, "tables": total_tables, "charts": total_charts,
            "diagrams": total_diagrams, "notes": total_notes,
        },
    }
    manifest["semanticSha256"] = digest(canonical(manifest))
    return manifest


def derive_native_diagram(parts: dict[str, bytes]) -> dict[str, bytes]:
    result = dict(parts)
    slide_part = slide_sequence(result)[0][2]
    root = ET.fromstring(result[slide_part])
    tree = root.find(".//p:spTree", NS)
    if tree is None:
        raise ValueError("Source has no shape tree.")
    ids = [int(item.get("id")) for item in root.findall(".//p:cNvPr", NS) if (item.get("id") or "").isdigit()]
    group_id = max(ids, default=1) + 1
    group = ET.Element(f"{{{P}}}grpSp")
    nv = ET.SubElement(group, f"{{{P}}}nvGrpSpPr")
    ET.SubElement(nv, f"{{{P}}}cNvPr", {"id": str(group_id), "name": "C17 Native Diagram"})
    ET.SubElement(nv, f"{{{P}}}cNvGrpSpPr")
    ET.SubElement(nv, f"{{{P}}}nvPr")
    group_props = ET.SubElement(group, f"{{{P}}}grpSpPr")
    transform = ET.SubElement(group_props, f"{{{A}}}xfrm")
    ET.SubElement(transform, f"{{{A}}}off", {"x": "1828800", "y": "2286000"})
    ET.SubElement(transform, f"{{{A}}}ext", {"cx": "8230000", "cy": "1828800"})
    ET.SubElement(transform, f"{{{A}}}chOff", {"x": "0", "y": "0"})
    ET.SubElement(transform, f"{{{A}}}chExt", {"cx": "8230000", "cy": "1828800"})

    def add_node(shape_id: int, name: str, x: int, text: str, fill: str) -> None:
        shape = ET.SubElement(group, f"{{{P}}}sp")
        non_visual = ET.SubElement(shape, f"{{{P}}}nvSpPr")
        ET.SubElement(non_visual, f"{{{P}}}cNvPr", {"id": str(shape_id), "name": name})
        ET.SubElement(non_visual, f"{{{P}}}cNvSpPr")
        ET.SubElement(non_visual, f"{{{P}}}nvPr")
        props = ET.SubElement(shape, f"{{{P}}}spPr")
        location = ET.SubElement(props, f"{{{A}}}xfrm")
        ET.SubElement(location, f"{{{A}}}off", {"x": str(x), "y": "228600"})
        ET.SubElement(location, f"{{{A}}}ext", {"cx": "2743200", "cy": "1371600"})
        geometry = ET.SubElement(props, f"{{{A}}}prstGeom", {"prst": "roundRect"})
        ET.SubElement(geometry, f"{{{A}}}avLst")
        solid = ET.SubElement(props, f"{{{A}}}solidFill")
        ET.SubElement(solid, f"{{{A}}}srgbClr", {"val": fill})
        body = ET.SubElement(shape, f"{{{P}}}txBody")
        ET.SubElement(body, f"{{{A}}}bodyPr", {"anchor": "ctr", "lIns": "152400", "rIns": "152400", "tIns": "76200", "bIns": "76200"})
        ET.SubElement(body, f"{{{A}}}lstStyle")
        paragraph = ET.SubElement(body, f"{{{A}}}p")
        paragraph_props = ET.SubElement(paragraph, f"{{{A}}}pPr", {"algn": "ctr"})
        ET.SubElement(paragraph_props, f"{{{A}}}buNone")
        run = ET.SubElement(paragraph, f"{{{A}}}r")
        run_props = ET.SubElement(run, f"{{{A}}}rPr", {"sz": "2000", "b": "1"})
        color = ET.SubElement(run_props, f"{{{A}}}solidFill")
        ET.SubElement(color, f"{{{A}}}srgbClr", {"val": "FFFFFF"})
        ET.SubElement(run_props, f"{{{A}}}latin", {"typeface": "Arial"})
        ET.SubElement(run, f"{{{A}}}t").text = text

    left_id, right_id, connector_id = group_id + 1, group_id + 2, group_id + 3
    add_node(left_id, "C17 Diagram Source", 228600, "SOURCE", "1F4E79")
    connector = ET.SubElement(group, f"{{{P}}}cxnSp")
    non_visual = ET.SubElement(connector, f"{{{P}}}nvCxnSpPr")
    ET.SubElement(non_visual, f"{{{P}}}cNvPr", {"id": str(connector_id), "name": "C17 Diagram Connector"})
    connection_props = ET.SubElement(non_visual, f"{{{P}}}cNvCxnSpPr")
    ET.SubElement(connection_props, f"{{{A}}}stCxn", {"id": str(left_id), "idx": "3"})
    ET.SubElement(connection_props, f"{{{A}}}endCxn", {"id": str(right_id), "idx": "1"})
    ET.SubElement(non_visual, f"{{{P}}}nvPr")
    connector_props = ET.SubElement(connector, f"{{{P}}}spPr")
    connector_xfrm = ET.SubElement(connector_props, f"{{{A}}}xfrm")
    ET.SubElement(connector_xfrm, f"{{{A}}}off", {"x": "2971800", "y": "914400"})
    ET.SubElement(connector_xfrm, f"{{{A}}}ext", {"cx": "2286000", "cy": "0"})
    connector_geometry = ET.SubElement(connector_props, f"{{{A}}}prstGeom", {"prst": "straightConnector1"})
    ET.SubElement(connector_geometry, f"{{{A}}}avLst")
    add_node(right_id, "C17 Diagram Output", 5257800, "EDITABLE OUTPUT", "2F6BFF")
    tree.append(group)
    result[slide_part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    return result


def mutate(parts: dict[str, bytes], control: str) -> dict[str, bytes]:
    result = dict(parts)
    slides = slide_sequence(result)
    if not slides:
        raise ValueError("No slides available for mutation.")
    slide_part = slides[0][2]
    if control in {"slide-layout-binding", "layout-master-binding"}:
        owner = slide_part if control == "slide-layout-binding" else relation_target(result, slide_part, "/slideLayout")
        if not owner:
            raise ValueError(f"No owner for {control}.")
        relation_name = rel_part(owner)
        root = ET.fromstring(result[relation_name])
        suffix = "/slideLayout" if control == "slide-layout-binding" else "/slideMaster"
        target = next((item for item in list(root) if (item.get("Type") or "").endswith(suffix)), None)
        if target is None:
            raise ValueError(f"No relationship for {control}.")
        root.remove(target)
        result[relation_name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    elif control == "text-run-formatting":
        root = ET.fromstring(result[slide_part])
        run = root.find(".//a:r", NS)
        if run is None:
            raise ValueError("No text run available.")
        props = run.find("a:rPr", NS)
        if props is None:
            props = ET.Element(f"{{{A}}}rPr")
            run.insert(0, props)
        props.set("b", "0" if props.get("b") == "1" else "1")
        result[slide_part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    elif control == "table-cell":
        owner = next((name for name in (part for _, _, part in slides) if b"<a:tbl" in result[name]), None)
        if not owner:
            raise ValueError("No table available.")
        root = ET.fromstring(result[owner])
        text = root.find(".//a:tbl//a:t", NS)
        if text is None:
            raise ValueError("No table cell text available.")
        text.text = (text.text or "") + " CONTROL"
        result[owner] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    elif control == "chart-cache":
        chart_part = next((name for name in sorted(result) if re.fullmatch(r"ppt/charts/chart\d+\.xml", name)), None)
        if not chart_part:
            raise ValueError("No chart available.")
        root = ET.fromstring(result[chart_part])
        value = root.find(".//c:v", NS)
        if value is None:
            raise ValueError("No chart cache value available.")
        value.text = (value.text or "") + "9"
        result[chart_part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    elif control == "speaker-notes":
        notes_part = next((name for name in sorted(result) if re.fullmatch(r"ppt/notesSlides/notesSlide\d+\.xml", name)), None)
        if not notes_part:
            raise ValueError("No notes available.")
        root = ET.fromstring(result[notes_part])
        text = next((item for item in root.findall(".//a:t", NS) if (item.text or "").strip()), None)
        if text is None:
            raise ValueError("No meaningful notes text available.")
        text.text = ""
        result[notes_part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    elif control == "reading-order":
        root = ET.fromstring(result[slide_part])
        tree = root.find(".//p:spTree", NS)
        candidates = [item for item in list(tree) if item.tag in SUPPORTED] if tree is not None else []
        if len(candidates) < 2:
            raise ValueError("No reading-order pair available.")
        children = list(tree)
        left, right = children.index(candidates[0]), children.index(candidates[1])
        children[left], children[right] = children[right], children[left]
        tree[:] = children
        result[slide_part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    elif control == "native-diagram":
        owner = next((name for _, _, name in slides if b"grpSp" in result[name]), None)
        if not owner:
            raise ValueError("No native diagram group available.")
        root = ET.fromstring(result[owner])
        tree = root.find(".//p:spTree", NS)
        group = tree.find("p:grpSp", NS) if tree is not None else None
        if tree is None or group is None:
            raise ValueError("No top-level native diagram group available.")
        index = list(tree).index(group)
        children = [child for child in list(group) if child.tag in SUPPORTED]
        tree.remove(group)
        for offset, child in enumerate(children):
            tree.insert(index + offset, child)
        result[owner] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    else:
        raise ValueError(f"Unsupported control: {control}")
    return result


def write_manifest(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    import_parser = sub.add_parser("import")
    import_parser.add_argument("source", type=Path)
    import_parser.add_argument("output", type=Path)
    import_parser.add_argument("--manifest", required=True, type=Path)
    derive_parser = sub.add_parser("derive-diagram")
    derive_parser.add_argument("source", type=Path)
    derive_parser.add_argument("output", type=Path)
    mutate_parser = sub.add_parser("mutate")
    mutate_parser.add_argument("source", type=Path)
    mutate_parser.add_argument("output", type=Path)
    mutate_parser.add_argument("--control", required=True)
    args = parser.parse_args()
    source_parts = read_parts(args.source)
    if args.command == "import":
        manifest = semantic_manifest(source_parts)
        write_parts(source_parts, args.output)
        manifest["sourceSha256"] = digest(args.source.read_bytes())
        manifest["outputSha256"] = digest(args.output.read_bytes())
        manifest["containerBytesDiffer"] = args.source.read_bytes() != args.output.read_bytes()
        write_manifest(args.manifest, manifest)
    elif args.command == "derive-diagram":
        write_parts(derive_native_diagram(source_parts), args.output)
    else:
        write_parts(mutate(source_parts, args.control), args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
