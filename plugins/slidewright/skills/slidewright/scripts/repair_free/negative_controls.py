#!/usr/bin/env python3
"""Create deterministic destructive controls for the C04 repair-free gate."""

from __future__ import annotations

import argparse
import struct
import warnings
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"


def read_parts(source: Path) -> tuple[list[str], dict[str, bytes]]:
    with zipfile.ZipFile(source) as archive:
        order = [item.filename for item in archive.infolist() if not item.is_dir()]
        return order, {name: archive.read(name) for name in order}


def write_parts(destination: Path, order: list[str], parts: dict[str, bytes], extra: list[tuple[str, bytes]] | None = None) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w") as archive:
        for name in order:
            info = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, parts[name])
        for name, data in extra or []:
            info = zipfile.ZipInfo(name, (2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                archive.writestr(info, data)


def first_slide(parts: dict[str, bytes]) -> str:
    return sorted(name for name in parts if name.startswith("ppt/slides/slide") and name.endswith(".xml"))[0]


def corrupt_crc(path: Path) -> None:
    with zipfile.ZipFile(path) as archive:
        item = next(item for item in archive.infolist() if item.compress_size > 1 and not item.filename.endswith(".xml"))
        offset = item.header_offset
    with path.open("r+b") as package:
        package.seek(offset)
        header = package.read(30)
        signature, *_, filename_length, extra_length = struct.unpack("<IHHHHHIIIHH", header)
        if signature != 0x04034B50:
            raise ValueError("unexpected ZIP local header signature")
        data_offset = offset + 30 + filename_length + extra_length
        package.seek(data_offset)
        value = package.read(1)
        package.seek(data_offset)
        package.write(bytes([value[0] ^ 0xFF]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--semantic-source", type=Path, required=True)
    args = parser.parse_args()
    order, original = read_parts(args.source)
    args.output.mkdir(parents=True, exist_ok=True)

    write_parts(args.output / "duplicate-part.pptx", order, original, [(order[-1], original[order[-1]])])
    write_parts(args.output / "traversal-part.pptx", order, original, [("../escape.xml", b"<escape/>")])

    malformed = dict(original)
    malformed[first_slide(malformed)] = b"<p:sld><broken></p:sld>"
    write_parts(args.output / "malformed-xml.pptx", order, malformed)

    missing_type = dict(original)
    types = ET.fromstring(missing_type["[Content_Types].xml"])
    slide_part = "/" + first_slide(missing_type)
    for item in list(types):
        if item.tag == f"{{{CONTENT_TYPES}}}Override" and item.get("PartName") == slide_part:
            types.remove(item)
        if item.tag == f"{{{CONTENT_TYPES}}}Default" and item.get("Extension", "").lower() == "xml":
            types.remove(item)
    missing_type["[Content_Types].xml"] = ET.tostring(types, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "missing-content-type.pptx", order, missing_type)

    dangling = dict(original)
    relation_name = sorted(name for name in dangling if name.endswith(".rels") and name != "_rels/.rels")[0]
    relations = ET.fromstring(dangling[relation_name])
    relation = next(item for item in relations if item.get("TargetMode") != "External")
    relation.set("Target", "missing-slidewright-part.xml")
    dangling[relation_name] = ET.tostring(relations, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "dangling-relationship.pptx", order, dangling)

    schema = dict(original)
    slide_name = first_slide(schema)
    slide = ET.fromstring(schema[slide_name])
    tree = slide.find(f".//{{{P}}}spTree")
    if tree is None:
        raise ValueError("source slide lacks p:spTree")
    tree.append(ET.Element(f"{{{P}}}definitelyInvalidRepairFreeControl"))
    schema[slide_name] = ET.tostring(slide, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "openxml-schema-invalid.pptx", order, schema)

    removed = dict(original)
    slide = ET.fromstring(removed[slide_name])
    tree = slide.find(f".//{{{P}}}spTree")
    removable = next((item for item in list(tree if tree is not None else []) if item.tag in {
        f"{{{P}}}sp", f"{{{P}}}grpSp", f"{{{P}}}pic", f"{{{P}}}graphicFrame", f"{{{P}}}cxnSp"
    }), None)
    if removable is None:
        raise ValueError("source slide lacks a removable semantic object")
    tree.remove(removable)
    removed[slide_name] = ET.tostring(slide, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "removed-content.pptx", order, removed)

    repair = dict(original)
    repair_relation_name = str(Path(slide_name).parent / "_rels" / (Path(slide_name).name + ".rels")).replace("\\", "/")
    repair_relations = ET.fromstring(repair[repair_relation_name])
    layout_relation = next((item for item in repair_relations if item.get("Type", "").endswith("/slideLayout")), None)
    if layout_relation is None:
        raise ValueError("source slide lacks a slide-layout relationship")
    layout_relation.set("Target", "../slideLayouts/slidewright-missing-repair-control.xml")
    repair[repair_relation_name] = ET.tostring(repair_relations, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "powerpoint-repair-missing-slide-layout-target.pptx", order, repair)

    semantic_order, semantic_original = read_parts(args.semantic_source)
    write_parts(args.output / "semantic-content-present.pptx", semantic_order, semantic_original)

    chart_removed = dict(semantic_original)
    chart_name = next((name for name in sorted(chart_removed) if name.startswith("ppt/charts/chart") and b"<c:dLbls" in chart_removed[name]), None)
    if chart_name is None:
        raise ValueError("semantic source lacks chart data labels")
    chart_root = ET.fromstring(chart_removed[chart_name])
    label_parents = [parent for parent in chart_root.iter() if any(child.tag == f"{{{C}}}dLbls" for child in list(parent))]
    if not label_parents:
        raise ValueError("semantic source chart label parent is missing")
    for label_parent in label_parents:
        for child in list(label_parent):
            if child.tag == f"{{{C}}}dLbls":
                label_parent.remove(child)
    chart_removed[chart_name] = ET.tostring(chart_root, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "removed-chart-label.pptx", semantic_order, chart_removed)

    diagram_removed = dict(semantic_original)
    diagram_slide = sorted(name for name in diagram_removed if name.startswith("ppt/slides/slide") and name.endswith(".xml"))[-1]
    diagram_root = ET.fromstring(diagram_removed[diagram_slide])
    diagram_text = next((item for item in diagram_root.findall(f".//{{{A}}}t") if (item.text or "").strip()), None)
    if diagram_text is None:
        raise ValueError("semantic source lacks a native diagram label")
    diagram_text.text = ""
    diagram_removed[diagram_slide] = ET.tostring(diagram_root, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "removed-diagram-label.pptx", semantic_order, diagram_removed)

    hyperlink_present = dict(original)
    hyperlink_slide_name = first_slide(hyperlink_present)
    hyperlink_slide = ET.fromstring(hyperlink_present[hyperlink_slide_name])
    run_properties = hyperlink_slide.find(f".//{{{A}}}rPr")
    if run_properties is None:
        raise ValueError("source slide lacks text run properties for the hyperlink control")
    hyperlink_rel_name = str(Path(hyperlink_slide_name).parent / "_rels" / (Path(hyperlink_slide_name).name + ".rels")).replace("\\", "/")
    hyperlink_rels = ET.fromstring(hyperlink_present[hyperlink_rel_name])
    relationship_id = "rIdSlidewrightRepairFreeHyperlink"
    if any(item.get("Id") == relationship_id for item in hyperlink_rels):
        raise ValueError("hyperlink control relationship ID already exists")
    ET.SubElement(hyperlink_rels, f"{{{REL}}}Relationship", {
        "Id": relationship_id,
        "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
        "Target": "https://example.com/slidewright-repair-free-control",
        "TargetMode": "External",
    })
    ET.SubElement(run_properties, f"{{{A}}}hlinkClick", {f"{{{R}}}id": relationship_id})
    hyperlink_present[hyperlink_slide_name] = ET.tostring(hyperlink_slide, encoding="utf-8", xml_declaration=True)
    hyperlink_present[hyperlink_rel_name] = ET.tostring(hyperlink_rels, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "hyperlink-present.pptx", order, hyperlink_present)

    hyperlink_removed = dict(hyperlink_present)
    removed_slide = ET.fromstring(hyperlink_removed[hyperlink_slide_name])
    removed_properties = removed_slide.find(f".//{{{A}}}rPr")
    hyperlink_node = removed_properties.find(f"{{{A}}}hlinkClick") if removed_properties is not None else None
    if removed_properties is None or hyperlink_node is None:
        raise ValueError("hyperlink control insertion failed")
    removed_properties.remove(hyperlink_node)
    removed_rels = ET.fromstring(hyperlink_removed[hyperlink_rel_name])
    removed_rels.remove(next(item for item in removed_rels if item.get("Id") == relationship_id))
    hyperlink_removed[hyperlink_slide_name] = ET.tostring(removed_slide, encoding="utf-8", xml_declaration=True)
    hyperlink_removed[hyperlink_rel_name] = ET.tostring(removed_rels, encoding="utf-8", xml_declaration=True)
    write_parts(args.output / "removed-hyperlink-target.pptx", order, hyperlink_removed)

    crc = args.output / "crc-corrupt.pptx"
    write_parts(crc, order, original)
    corrupt_crc(crc)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
