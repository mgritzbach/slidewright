#!/usr/bin/env python3
"""Forensic package and placeholder audit for the MIT template edit fixture."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"p": P, "a": A}
CORE_NS = {
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def inventory(archive: zipfile.ZipFile) -> dict[str, str]:
    return {name: hash_bytes(archive.read(name)) for name in archive.namelist() if not name.endswith("/")}


def shape_xml(xml: str, name: str) -> str:
    marker = f'name="{html.escape(name, quote=True)}"'
    if xml.count(marker) != 1:
        raise ValueError(f"Expected one shape named {name!r}; found {xml.count(marker)}.")
    pos = xml.index(marker)
    start = xml.rfind("<p:sp>", 0, pos)
    end = xml.index("</p:sp>", pos) + len("</p:sp>")
    return xml[start:end]


def text_values(shape: str) -> list[str]:
    return [html.unescape(value) for value in re.findall(r"<a:t>(.*?)</a:t>", shape, re.DOTALL)]


def normalized_shape(shape: str) -> str:
    return re.sub(r"<a:t>.*?</a:t>", "<a:t>__EDITED_TEXT__</a:t>", shape, flags=re.DOTALL)


def normalized_authorized_slide(xml: str, edits: list[dict]) -> str:
    normalized = xml
    for edit in edits:
        original_shape = shape_xml(normalized, edit["shapeName"])
        replacement = normalized_shape(original_shape)
        normalized = normalized.replace(original_shape, replacement, 1)
    return normalized


def relationship_tuples(archive: zipfile.ZipFile) -> list[tuple[str, str, str, str, str]]:
    rels = []
    ns = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
    for name in sorted(item for item in archive.namelist() if item.endswith(".rels")):
        root = ET.fromstring(archive.read(name))
        for rel in root.findall("r:Relationship", ns):
            rels.append((name, rel.get("Id", ""), rel.get("Type", ""), rel.get("Target", ""), rel.get("TargetMode", "")))
    return rels


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("edited")
    parser.add_argument("plan")
    parser.add_argument("--json", required=True)
    parser.add_argument("--source-manifest", required=True)
    parser.add_argument("--edited-manifest", required=True)
    args = parser.parse_args()
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    failures = []
    authorized_slide_only = False
    relationships_equal = False

    def check(condition: bool, field: str, expected, actual) -> None:
        if not condition:
            failures.append({"field": field, "expected": expected, "actual": actual})

    with zipfile.ZipFile(args.source) as source_archive, zipfile.ZipFile(args.edited) as edited_archive:
        source_inventory = inventory(source_archive)
        edited_inventory = inventory(edited_archive)
        Path(args.source_manifest).write_text(json.dumps(source_inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        Path(args.edited_manifest).write_text(json.dumps(edited_inventory, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        target_part = f"ppt/slides/slide{int(plan['targetSlide'])}.xml"
        check(set(source_inventory) == set(edited_inventory), "package-part-inventory", sorted(source_inventory), sorted(edited_inventory))
        source_core = ET.fromstring(source_archive.read("docProps/core.xml"))
        edited_core = ET.fromstring(edited_archive.read("docProps/core.xml"))
        expected_author = plan["expectedCoreAuthor"]
        for label, root in (("source", source_core), ("edited", edited_core)):
            creator = root.findtext("dc:creator", default="", namespaces=CORE_NS)
            last_author = root.findtext("cp:lastModifiedBy", default="", namespaces=CORE_NS)
            check(creator == expected_author, f"{label}-core-creator", expected_author, creator)
            check(last_author == expected_author, f"{label}-core-last-author", expected_author, last_author)
        changed_parts = sorted(name for name in source_inventory if source_inventory.get(name) != edited_inventory.get(name))
        check(changed_parts == [target_part], "changed-parts", [target_part], changed_parts)
        relationships_equal = relationship_tuples(source_archive) == relationship_tuples(edited_archive)
        check(relationships_equal, "relationship-tuples", "exactly preserved", "changed")
        source_slide = source_archive.read(target_part).decode("utf-8")
        edited_slide = edited_archive.read(target_part).decode("utf-8")
        for edit in plan["edits"]:
            source_shape = shape_xml(source_slide, edit["shapeName"])
            edited_shape = shape_xml(edited_slide, edit["shapeName"])
            check(text_values(source_shape) == edit["before"].split("\n"), f"{edit['shapeName']}-source-text", edit["before"].split("\n"), text_values(source_shape))
            check(text_values(edited_shape) == edit["after"].split("\n"), f"{edit['shapeName']}-edited-text", edit["after"].split("\n"), text_values(edited_shape))
            check(normalized_shape(source_shape) == normalized_shape(edited_shape), f"{edit['shapeName']}-nontext-subtree", "identical", "changed")
        authorized_slide_only = normalized_authorized_slide(source_slide, plan["edits"]) == normalized_authorized_slide(edited_slide, plan["edits"])
        check(authorized_slide_only, "target-slide-outside-authorized-text", "identical", "changed")
        for slide_number in plan["preserveOnlySlides"]:
            part = f"ppt/slides/slide{slide_number}.xml"
            check(source_inventory.get(part) == edited_inventory.get(part), f"preserve-slide-{slide_number}", source_inventory.get(part), edited_inventory.get(part))
        protected_prefixes = ("ppt/slideMasters/", "ppt/slideLayouts/", "ppt/theme/")
        for name in source_inventory:
            if name.startswith(protected_prefixes):
                check(source_inventory[name] == edited_inventory[name], f"protected:{name}", source_inventory[name], edited_inventory[name])
        root = ET.fromstring(edited_archive.read(target_part))
        pictures = root.findall(".//p:pic", NS)
        check(not pictures, "pictures", 0, len(pictures))
        check(len(root.findall(".//a:t", NS)) >= 4, "native-text-nodes", ">=4", len(root.findall(".//a:t", NS)))
        summary = {
            "packageParts": len(source_inventory),
            "changedParts": changed_parts,
            "relationshipTuples": len(relationship_tuples(source_archive)),
            "masters": len([name for name in source_inventory if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name)]),
            "layouts": len([name for name in source_inventory if re.fullmatch(r"ppt/slideLayouts/slideLayout\d+\.xml", name)]),
            "themes": len([name for name in source_inventory if re.fullmatch(r"ppt/theme/theme\d+\.xml", name)]),
            "pictures": len(pictures),
        }
    observed_deviations = [
        f"edited a:t values in the two named slide-{int(plan['targetSlide'])} placeholder shapes"
    ] if changed_parts == [target_part] else []
    if not authorized_slide_only:
        observed_deviations.append(f"undeclared change within {target_part} outside authorized a:t nodes")
    if set(source_inventory) != set(edited_inventory):
        observed_deviations.append("package part inventory changed")
    if not relationships_equal:
        observed_deviations.append("package relationship tuples changed")
    unauthorized_deviations = [
        deviation for deviation in observed_deviations if deviation not in plan["allowedDeviation"]
    ]
    check(not unauthorized_deviations, "unauthorized-deviations", [], unauthorized_deviations)
    report = {
        "valid": not failures,
        "summary": summary,
        "failures": failures,
        "deviationLog": {
            "authorized": plan["allowedDeviation"],
            "observed": observed_deviations,
            "unauthorized": unauthorized_deviations,
        },
    }
    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
