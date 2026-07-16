#!/usr/bin/env python3
"""Compare canonical named OOXML objects between two Slidewright PPTX files."""

import argparse
import copy
import hashlib
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
SUPPORTED = {
    f"{{{NS['p']}}}sp": ("p:nvSpPr/p:cNvPr", "p:spPr/a:xfrm"),
    f"{{{NS['p']}}}grpSp": ("p:nvGrpSpPr/p:cNvPr", "p:grpSpPr/a:xfrm"),
    f"{{{NS['p']}}}pic": ("p:nvPicPr/p:cNvPr", "p:spPr/a:xfrm"),
    f"{{{NS['p']}}}graphicFrame": ("p:nvGraphicFramePr/p:cNvPr", "p:xfrm"),
    f"{{{NS['p']}}}cxnSp": ("p:nvCxnSpPr/p:cNvPr", "p:spPr/a:xfrm"),
}


def canonical_hash(node: ET.Element) -> str:
    canonical = copy.deepcopy(node)
    creation_id_tag = "{http://schemas.microsoft.com/office/drawing/2014/main}creationId"
    for creation_id in canonical.iter(creation_id_tag):
        if "id" in creation_id.attrib:
            creation_id.set("id", "{VOLATILE-CREATION-ID}")
    return hashlib.sha256(ET.tostring(canonical, encoding="utf-8")).hexdigest()


def bbox(node: ET.Element, xfrm_path: str):
    xfrm = node.find(xfrm_path, NS)
    if xfrm is None:
        return None
    off = xfrm.find("a:off", NS)
    ext = xfrm.find("a:ext", NS)
    if off is None or ext is None:
        off = xfrm.find("a:chOff", NS)
        ext = xfrm.find("a:chExt", NS)
    if off is None or ext is None:
        return None
    return {
        "x": int(off.attrib["x"]),
        "y": int(off.attrib["y"]),
        "cx": int(ext.attrib["cx"]),
        "cy": int(ext.attrib["cy"]),
    }


def inventory(pptx: Path):
    objects = {}
    ordering = []
    with zipfile.ZipFile(pptx) as archive:
        slide_names = sorted(
            (name for name in archive.namelist() if name.startswith("ppt/slides/slide") and name.endswith(".xml")),
            key=lambda name: int(Path(name).stem.removeprefix("slide")),
        )
        for slide_number, slide_name in enumerate(slide_names, 1):
            root = ET.fromstring(archive.read(slide_name))
            tree = root.find("p:cSld/p:spTree", NS)
            if tree is None:
                raise ValueError(f"{slide_name} has no shape tree")
            for node in list(tree):
                metadata = SUPPORTED.get(node.tag)
                if metadata is None:
                    continue
                name_node = node.find(metadata[0], NS)
                if name_node is None or not name_node.attrib.get("name"):
                    raise ValueError(f"Unnamed supported object on slide {slide_number}")
                name = name_node.attrib["name"]
                if name in objects:
                    raise ValueError(f"Duplicate named object {name!r}")
                record = {
                    "slide": slide_number,
                    "type": node.tag.rsplit("}", 1)[-1],
                    "hash": canonical_hash(node),
                    "bboxEmu": bbox(node, metadata[1]),
                }
                objects[name] = record
                ordering.append(name)
    return objects, ordering


def parse_ids(value: str):
    return sorted(identifier for identifier in value.split(",") if identifier)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("variant")
    parser.add_argument("--allowed-changed", required=True)
    parser.add_argument("--required-changed", required=True)
    parser.add_argument("--json", required=True)
    args = parser.parse_args()

    allowed = parse_ids(args.allowed_changed)
    required = parse_ids(args.required_changed)
    before, before_order = inventory(Path(args.baseline))
    after, after_order = inventory(Path(args.variant))
    failures = []
    if before_order != after_order:
        failures.append("Named object inventory or ordering changed.")
    changed = sorted(name for name in before if name in after and before[name]["hash"] != after[name]["hash"])
    unauthorized = sorted(set(changed) - set(allowed))
    missing_required = sorted(set(required) - set(changed))
    if unauthorized:
        failures.append(f"Unauthorized OOXML objects changed: {', '.join(unauthorized)}")
    if missing_required:
        failures.append(f"Required OOXML objects did not change: {', '.join(missing_required)}")
    report = {
        "valid": not failures,
        "baseline": str(Path(args.baseline).resolve()),
        "variant": str(Path(args.variant).resolve()),
        "objectCount": len(before),
        "orderingPreserved": before_order == after_order,
        "allowedChangedIds": allowed,
        "requiredChangedIds": required,
        "actualChangedIds": changed,
        "unauthorizedChangedIds": unauthorized,
        "missingRequiredIds": missing_required,
        "unchangedCount": len(before) - len(changed),
        "objectsBefore": before,
        "objectsAfter": after,
        "failures": failures,
    }
    output = Path(args.json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ["valid", "objectCount", "actualChangedIds", "unchangedCount", "failures"]}, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
