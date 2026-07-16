#!/usr/bin/env python3
"""Whole-package and exact named-object audit for Slidewright iteration decks."""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import posixpath
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
FIXED_ZIP_TIME = (2000, 1, 1, 0, 0, 0)
SUPPORTED = {
    f"{{{P}}}sp": f"{{{P}}}nvSpPr",
    f"{{{P}}}grpSp": f"{{{P}}}nvGrpSpPr",
    f"{{{P}}}pic": f"{{{P}}}nvPicPr",
    f"{{{P}}}graphicFrame": f"{{{P}}}nvGraphicFramePr",
    f"{{{P}}}cxnSp": f"{{{P}}}nvCxnSpPr",
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def csv_set(value: str) -> set[str]:
    return {item for item in value.split(",") if item}


def owner_for_relationship_part(name: str) -> str | None:
    if name == "_rels/.rels":
        return None
    directory, filename = name.split("/_rels/", 1)
    return f"{directory}/{filename[:-5]}"


def relationship_target(owner: str | None, target: str) -> str:
    base = posixpath.dirname(owner) if owner else ""
    return posixpath.normpath(posixpath.join(base, target)).lstrip("/")


def relationship_report(parts: dict[str, bytes]) -> tuple[list[tuple[str, str, str, str]], list[str]]:
    tuples: list[tuple[str, str, str, str]] = []
    failures: list[str] = []
    for name in sorted(part for part in parts if part.endswith(".rels")):
        root = ET.fromstring(parts[name])
        relationships = list(root)
        ids = [item.get("Id", "") for item in relationships]
        if len(ids) != len(set(ids)) or any(not value for value in ids):
            failures.append(f"{name} has missing or duplicate relationship IDs.")
        semantic = [
            (
                item.get("Type", ""),
                item.get("TargetMode", ""),
                item.get("Target", ""),
            )
            for item in relationships
        ]
        if len(semantic) != len(set(semantic)):
            failures.append(f"{name} has duplicate semantic relationship tuples.")
        for type_value, mode, target in semantic:
            tuples.append((name, type_value, mode, target))
            if mode != "External":
                resolved = relationship_target(owner_for_relationship_part(name), target)
                if resolved not in parts:
                    failures.append(f"{name} targets missing package part {resolved}.")
        owner = owner_for_relationship_part(name)
        if owner and owner in parts:
            owner_root = ET.fromstring(parts[owner])
            refs = [
                value
                for element in owner_root.iter()
                for attribute, value in element.attrib.items()
                if attribute.startswith("{" + OFFICE_REL + "}")
            ]
            missing = sorted(set(refs) - set(ids))
            if missing:
                failures.append(f"{owner} has dangling relationship references: {missing}.")
    return sorted(tuples), failures


def zip_metadata(archive: zipfile.ZipFile) -> tuple[list[dict], list[str]]:
    records = []
    failures = []
    names = []
    for item in archive.infolist():
        if item.is_dir():
            continue
        names.append(item.filename)
        record = {
            "name": item.filename,
            "dateTime": list(item.date_time),
            "compressType": item.compress_type,
            "createSystem": item.create_system,
            "externalAttr": item.external_attr,
            "flagBits": item.flag_bits,
        }
        records.append(record)
        if item.date_time != FIXED_ZIP_TIME:
            failures.append(f"{item.filename} has nondeterministic ZIP timestamp {item.date_time}.")
        if item.compress_type != zipfile.ZIP_DEFLATED:
            failures.append(f"{item.filename} is not deterministically deflated.")
        if item.create_system != 0:
            failures.append(f"{item.filename} has nondeterministic ZIP create-system {item.create_system}.")
        if item.external_attr != 25165824:
            failures.append(f"{item.filename} has nondeterministic ZIP external attributes {item.external_attr}.")
        if item.flag_bits != 0:
            failures.append(f"{item.filename} has nondeterministic ZIP flag bits {item.flag_bits}.")
    if names != sorted(names):
        failures.append("Package entries are not sorted.")
    if len(names) != len(set(names)):
        failures.append("Package contains duplicate part names.")
    return records, failures


def c_nv_pr(node: ET.Element) -> ET.Element | None:
    non_visual = node.find(SUPPORTED.get(node.tag, ""))
    if non_visual is None:
        return None
    for child in non_visual:
        if child.tag == f"{{{P}}}cNvPr":
            return child
    return None


def named_objects(parts: dict[str, bytes]) -> tuple[dict[str, dict], dict[str, tuple[str, int]]]:
    objects: dict[str, dict] = {}
    locations: dict[str, tuple[str, int]] = {}
    for part in sorted(name for name in parts if name.startswith("ppt/slides/slide") and name.endswith(".xml")):
        root = ET.fromstring(parts[part])
        tree = root.find(f".//{{{P}}}spTree")
        if tree is None:
            continue
        for order, node in enumerate(list(tree)):
            if node.tag not in SUPPORTED:
                continue
            props = c_nv_pr(node)
            name = props.get("name", "") if props is not None else ""
            if not name:
                continue
            if name in objects:
                raise ValueError(f"Named object is not unique: {name}")
            objects[name] = {
                "part": part,
                "order": order,
                "type": node.tag.rsplit("}", 1)[-1],
                "hash": sha256(ET.tostring(node, encoding="utf-8")),
                "description": props.get("descr", ""),
                "title": props.get("title", ""),
            }
            locations[name] = (part, order)
    return objects, locations


def validate_envelope(description: str) -> dict | None:
    prefix = "slidewright-chart:v1:"
    if not description.startswith(prefix):
        return None
    encoded, digest = description[len(prefix):].rsplit(":", 1)
    encoded += "=" * (-len(encoded) % 4)
    raw = base64.urlsafe_b64decode(encoded.encode("ascii"))
    if sha256(raw) != digest:
        raise ValueError("Chart metadata description has an invalid content hash.")
    value = json.loads(raw)
    if value.get("officeChart") is not False or not str(value.get("representation", "")).startswith("native-shape"):
        raise ValueError("Chart metadata must explicitly declare native shapes and officeChart false.")
    return value


def metadata_summary(objects: dict[str, dict]) -> tuple[dict[str, dict], list[str]]:
    payloads = {}
    failures = []
    for name, item in objects.items():
        description = item["description"]
        if not description.startswith("slidewright-chart:"):
            continue
        try:
            payloads[name] = validate_envelope(description)
        except Exception as error:
            failures.append(f"{name}: {error}")
    return payloads, failures


def normalized_slide(data: bytes, allowed: set[str]) -> bytes:
    root = ET.fromstring(data)
    tree = root.find(f".//{{{P}}}spTree")
    if tree is None:
        return ET.tostring(root, encoding="utf-8")
    for index, node in enumerate(list(tree)):
        if node.tag not in SUPPORTED:
            continue
        props = c_nv_pr(node)
        name = props.get("name", "") if props is not None else ""
        if name in allowed:
            replacement = ET.Element(node.tag, {"slidewrightAuthorizedObject": name})
            tree.remove(node)
            tree.insert(index, replacement)
    return ET.tostring(root, encoding="utf-8")


def read_package(path: Path):
    with zipfile.ZipFile(path) as archive:
        metadata, metadata_failures = zip_metadata(archive)
        parts = {item.filename: archive.read(item.filename) for item in archive.infolist() if not item.is_dir()}
    return parts, metadata, metadata_failures


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline")
    parser.add_argument("variant")
    parser.add_argument("--allowed-changed", default="")
    parser.add_argument("--required-changed", default="")
    parser.add_argument("--require-identical-package", action="store_true")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()

    baseline_path = Path(args.baseline)
    variant_path = Path(args.variant)
    allowed = csv_set(args.allowed_changed)
    required = csv_set(args.required_changed)
    failures: list[str] = []

    before_parts, before_zip, before_zip_failures = read_package(baseline_path)
    after_parts, after_zip, after_zip_failures = read_package(variant_path)
    failures.extend("baseline: " + item for item in before_zip_failures)
    failures.extend("variant: " + item for item in after_zip_failures)

    before_names = set(before_parts)
    after_names = set(after_parts)
    if before_names != after_names:
        failures.append("Package part inventory changed.")

    before_relationships, before_relationship_failures = relationship_report(before_parts)
    after_relationships, after_relationship_failures = relationship_report(after_parts)
    failures.extend("baseline: " + item for item in before_relationship_failures)
    failures.extend("variant: " + item for item in after_relationship_failures)
    if before_relationships != after_relationships:
        failures.append("Semantic relationship tuples changed.")

    before_objects, before_locations = named_objects(before_parts)
    after_objects, after_locations = named_objects(after_parts)
    if set(before_objects) != set(after_objects):
        failures.append("Named object inventory changed.")
    if before_locations != after_locations:
        failures.append("Named object slide/order locations changed.")

    actual = sorted(
        name for name in set(before_objects) & set(after_objects)
        if before_objects[name]["hash"] != after_objects[name]["hash"]
    )
    unauthorized = sorted(set(actual) - allowed)
    missing_required = sorted(required - set(actual))
    if unauthorized:
        failures.append("Unauthorized named objects changed: " + ", ".join(unauthorized))
    if missing_required:
        failures.append("Required named objects did not change: " + ", ".join(missing_required))

    changed_parts = []
    for name in sorted(before_names & after_names):
        if before_parts[name] == after_parts[name]:
            continue
        changed_parts.append(name)
        if name.startswith("ppt/slides/slide") and name.endswith(".xml"):
            if normalized_slide(before_parts[name], allowed) != normalized_slide(after_parts[name], allowed):
                failures.append(f"{name} changed outside authorized named-object subtrees.")
        else:
            failures.append(f"Unauthorized package part changed: {name}.")

    before_payloads, before_metadata_failures = metadata_summary(before_objects)
    after_payloads, after_metadata_failures = metadata_summary(after_objects)
    failures.extend("baseline metadata: " + item for item in before_metadata_failures)
    failures.extend("variant metadata: " + item for item in after_metadata_failures)
    if set(before_payloads) != set(after_payloads):
        failures.append("Semantic chart metadata inventory changed.")

    baseline_hash = sha256(baseline_path.read_bytes())
    variant_hash = sha256(variant_path.read_bytes())
    if args.require_identical_package and baseline_hash != variant_hash:
        failures.append("Normalized packages are not byte-identical.")

    report = {
        "valid": not failures,
        "baseline": str(baseline_path.resolve()),
        "variant": str(variant_path.resolve()),
        "partCount": len(before_parts),
        "namedObjectCount": len(before_objects),
        "relationshipTuples": len(before_relationships),
        "allowedChangedIds": sorted(allowed),
        "requiredChangedIds": sorted(required),
        "actualChangedIds": actual,
        "unauthorizedChangedIds": unauthorized,
        "missingRequiredIds": missing_required,
        "unchangedCount": len(before_objects) - len(actual),
        "changedParts": changed_parts,
        "baselineSha256": baseline_hash,
        "variantSha256": variant_hash,
        "rawPackageHashEqual": baseline_hash == variant_hash,
        "zipMetadataEqual": before_zip == after_zip,
        "chartMetadataObjects": sorted(before_payloads),
        "chartMetadataBefore": before_payloads,
        "chartMetadataAfter": after_payloads,
        "failures": failures,
    }
    output = Path(args.json)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
