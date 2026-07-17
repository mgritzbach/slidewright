#!/usr/bin/env python3
"""Create a stable, content-loss-sensitive inventory for a PowerPoint package."""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"

SUPPORTED = {
    f"{{{P}}}sp": f"{{{P}}}nvSpPr",
    f"{{{P}}}grpSp": f"{{{P}}}nvGrpSpPr",
    f"{{{P}}}pic": f"{{{P}}}nvPicPr",
    f"{{{P}}}graphicFrame": f"{{{P}}}nvGraphicFramePr",
    f"{{{P}}}cxnSp": f"{{{P}}}nvCxnSpPr",
}


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relationship_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    return posixpath.join(directory, "_rels", filename + ".rels")


def resolve(owner: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)).lstrip("/")


def relationships(parts: dict[str, bytes], owner: str) -> dict[str, dict[str, str | bool]]:
    name = relationship_part(owner)
    if name not in parts:
        return {}
    root = ET.fromstring(parts[name])
    result = {}
    for item in root:
        target = item.get("Target", "")
        external = item.get("TargetMode") == "External"
        result[item.get("Id", "")] = {
            "type": item.get("Type", ""),
            "target": target if external else resolve(owner, target),
            "external": external,
        }
    return result


def c_nv_pr(node: ET.Element) -> ET.Element | None:
    container = node.find(SUPPORTED.get(node.tag, ""))
    return container.find(f"{{{P}}}cNvPr") if container is not None else None


def xfrm(node: ET.Element) -> dict:
    transform = node.find(f".//{{{A}}}xfrm")
    if transform is None:
        return {}
    result = {
        key: transform.get(key)
        for key in ("rot", "flipH", "flipV")
        if transform.get(key) not in (None, "0", "false")
    }
    for name in ("off", "ext", "chOff", "chExt"):
        child = transform.find(f"{{{A}}}{name}")
        if child is not None:
            result[name] = {key: child.get(key) for key in sorted(child.attrib)}
    return result


def text_payload(node: ET.Element) -> dict:
    paragraphs = []
    for paragraph in node.findall(f".//{{{A}}}p"):
        runs = []
        for child in list(paragraph):
            if child.tag not in (f"{{{A}}}r", f"{{{A}}}fld"):
                continue
            value = "".join(item.text or "" for item in child.findall(f".//{{{A}}}t"))
            runs.append(value)
        paragraphs.append(runs)
    paragraph_text = ["".join(runs) for runs in paragraphs]
    return {
        "text": "\n".join(paragraph_text),
        "paragraphs": paragraph_text,
        "paragraphCount": len(paragraph_text),
    }


def element_payload(node: ET.Element) -> dict:
    """Stable semantic XML payload for relationship-backed user content."""
    return {
        "tag": local(node.tag),
        "attributes": {local(key): value for key, value in sorted(node.attrib.items())},
        "text": (node.text or "").strip(),
        "children": [element_payload(child) for child in list(node)],
    }


def hyperlink_payload(node: ET.Element, rels: dict[str, dict[str, str | bool]]) -> list[dict]:
    result = []
    for item in node.iter():
        if local(item.tag) not in {"hlinkClick", "hlinkHover"}:
            continue
        relation_id = item.get(f"{{{R}}}id", "")
        relation = rels.get(relation_id)
        result.append({
            "kind": local(item.tag),
            "action": item.get("action", ""),
            "tooltip": item.get("tooltip", ""),
            "target": relation.get("target", "") if relation else "",
            "external": relation.get("external", False) if relation else False,
            "relationshipType": relation.get("type", "") if relation else "",
        })
    return result


def chart_payload(parts: dict[str, bytes], target: str) -> dict:
    root = ET.fromstring(parts[target])
    values = [item.text or "" for item in root.findall(f".//{{{C}}}v")]
    formulas = [item.text or "" for item in root.findall(f".//{{{C}}}f")]
    chart_types = sorted({local(item.tag) for item in root.iter() if local(item.tag).endswith("Chart")})
    titles = ["".join(item.text or "" for item in title.findall(f".//{{{A}}}t")) for title in root.findall(f".//{{{C}}}title")]
    label_groups = root.findall(f".//{{{C}}}dLbls")
    data_label_text = ["".join(item.text or "" for item in label.findall(f".//{{{A}}}t")) for group in label_groups for label in group.findall(f"{{{C}}}dLbl")]
    return {
        "values": values,
        "formulas": formulas,
        "chartTypes": chart_types,
        "titles": titles,
        "dataLabelsPresent": len(label_groups) > 0,
        "dataLabelCount": sum(len(group.findall(f"{{{C}}}dLbl")) for group in label_groups),
        "dataLabelText": data_label_text,
    }


def shape_record(parts: dict[str, bytes], owner: str, node: ET.Element, order_path: list[int]) -> dict:
    props = c_nv_pr(node)
    record = {
        "path": order_path,
        "type": local(node.tag),
        "id": props.get("id", "") if props is not None else "",
        "name": props.get("name", "") if props is not None else "",
        "geometry": xfrm(node),
        "text": text_payload(node),
    }
    rels = relationships(parts, owner)
    hyperlinks = hyperlink_payload(node, rels)
    if hyperlinks:
        record["hyperlinks"] = hyperlinks
    if node.tag == f"{{{P}}}pic":
        blip = node.find(f".//{{{A}}}blip")
        rel_id = blip.get(f"{{{R}}}embed", "") if blip is not None else ""
        relation = rels.get(rel_id)
        record["media"] = None if not relation or relation["external"] else {
            "sha256": sha256(parts[relation["target"]]),
        }
    if node.tag == f"{{{P}}}graphicFrame":
        data = node.find(f".//{{{A}}}graphicData")
        record["graphicUri"] = data.get("uri", "") if data is not None else ""
        table = node.find(f".//{{{A}}}tbl")
        if table is not None:
            rows = []
            for row in table.findall(f"{{{A}}}tr"):
                rows.append([text_payload(cell)["text"] for cell in row.findall(f"{{{A}}}tc")])
            record["table"] = rows
        chart = node.find(f".//{{{C}}}chart")
        if chart is not None:
            relation = rels.get(chart.get(f"{{{R}}}id", ""))
            if relation and not relation["external"] and relation["target"] in parts:
                record["chart"] = chart_payload(parts, str(relation["target"]))
        diagram_parts = []
        for descendant in node.iter():
            for key, relation_id in descendant.attrib.items():
                if key != f"{{{R}}}id":
                    continue
                relation = rels.get(relation_id)
                if not relation or relation["external"] or not str(relation["target"]).startswith("ppt/diagrams/") or relation["target"] not in parts:
                    continue
                diagram_parts.append({
                    "relationshipType": relation["type"],
                    "payload": element_payload(ET.fromstring(parts[str(relation["target"])])),
                })
        if diagram_parts:
            record["diagramParts"] = diagram_parts
    if node.tag == f"{{{P}}}cxnSp":
        start = node.find(f".//{{{A}}}stCxn")
        end = node.find(f".//{{{A}}}endCxn")
        record["connections"] = {
            "start": dict(sorted(start.attrib.items())) if start is not None else None,
            "end": dict(sorted(end.attrib.items())) if end is not None else None,
        }
    if node.tag == f"{{{P}}}grpSp":
        children = [item for item in list(node) if item.tag in SUPPORTED]
        record["children"] = [shape_record(parts, owner, child, order_path + [index]) for index, child in enumerate(children)]
    return record


def slide_order(parts: dict[str, bytes]) -> list[str]:
    owner = "ppt/presentation.xml"
    root = ET.fromstring(parts[owner])
    rels = relationships(parts, owner)
    order = []
    for slide in root.findall(f".//{{{P}}}sldId"):
        relation = rels.get(slide.get(f"{{{R}}}id", ""))
        if relation and not relation["external"]:
            order.append(str(relation["target"]))
    return order


def slide_record(parts: dict[str, bytes], name: str, index: int) -> dict:
    root = ET.fromstring(parts[name])
    tree = root.find(f".//{{{P}}}spTree")
    nodes = [item for item in list(tree if tree is not None else []) if item.tag in SUPPORTED]
    rels = relationships(parts, name)
    notes_rel = next((item for item in rels.values() if str(item["type"]).endswith("/notesSlide") and not item["external"]), None)
    notes = ""
    if notes_rel and notes_rel["target"] in parts:
        notes_root = ET.fromstring(parts[str(notes_rel["target"])])
        notes = "\n".join(item.text or "" for item in notes_root.findall(f".//{{{A}}}t"))
    return {
        "index": index,
        "part": name,
        "shapes": [shape_record(parts, name, node, [order]) for order, node in enumerate(nodes)],
        "notes": notes,
    }


def inventory(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        parts = {item.filename: archive.read(item.filename) for item in archive.infolist() if not item.is_dir()}
    order = slide_order(parts)
    categories = {
        "slideMasters": sorted(name for name in parts if name.startswith("ppt/slideMasters/") and name.endswith(".xml")),
        "slideLayouts": sorted(name for name in parts if name.startswith("ppt/slideLayouts/") and name.endswith(".xml")),
        "themes": sorted(name for name in parts if name.startswith("ppt/theme/") and name.endswith(".xml")),
        "charts": sorted(name for name in parts if name.startswith("ppt/charts/") and name.endswith(".xml")),
        "media": sorted(name for name in parts if name.startswith("ppt/media/")),
        "notes": sorted(name for name in parts if name.startswith("ppt/notesSlides/") and name.endswith(".xml")),
    }
    return {
        "schemaVersion": "slidewright-semantic-inventory/v1",
        "slides": [slide_record(parts, name, index + 1) for index, name in enumerate(order)],
        # Masters/layouts/themes have their own stricter C10 preservation gate.
        # Part names and run boundaries are serialization details that PowerPoint
        # legitimately normalizes; user-content payloads remain exact here.
        "media": sorted(sha256(parts[name]) for name in categories["media"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    source = Path(args.pptx)
    value = inventory(source)
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    report = {
        "valid": True,
        "input": str(source.resolve()),
        "inputSha256": sha256(source.read_bytes()),
        "inventorySha256": sha256(payload),
        "inventory": value,
    }
    destination = Path(args.json)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("valid", "inputSha256", "inventorySha256")}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
