#!/usr/bin/env python3
"""Deterministically audit the generic OPC integrity of a PowerPoint package."""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import sys
import urllib.parse
import zipfile
import zlib
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET


CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types"
PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REQUIRED_PARTS = {"[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml"}
RELATIONSHIP_CONTENT_TYPE = "application/vnd.openxmlformats-package.relationships+xml"


def failure(code: str, message: str, *, part: str | None = None, **details: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"code": code, "message": message}
    if part is not None:
        result["part"] = part
    result.update(details)
    return result


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def relationship_owner(part: str) -> str | None:
    if part == "_rels/.rels":
        return None
    match = re.fullmatch(r"(.+)/_rels/([^/]+)\.rels", part)
    if not match:
        raise ValueError("relationship part is not in an exact _rels owner directory")
    directory, owner_name = match.groups()
    return f"{directory}/{owner_name}"


def relationship_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    prefix = f"{directory}/" if directory else ""
    return f"{prefix}_rels/{filename}.rels"


def resolve_internal_target(owner: str | None, target: str) -> str:
    parsed = urllib.parse.urlsplit(target)
    raw_path = urllib.parse.unquote(parsed.path)
    if not raw_path or "\\" in raw_path:
        raise ValueError("internal relationship target has an empty or non-OPC path")
    if raw_path.startswith("/"):
        resolved = posixpath.normpath(raw_path).lstrip("/")
    else:
        base = posixpath.dirname(owner) if owner else ""
        resolved = posixpath.normpath(posixpath.join(base, raw_path))
    if resolved in {"", ".", ".."} or resolved.startswith("../"):
        raise ValueError("internal relationship target escapes the package root")
    return resolved


def safe_part_name(name: str) -> bool:
    if not name or "\\" in name or name.startswith("/"):
        return False
    normalized = posixpath.normpath(name)
    return normalized == name and normalized not in {".", ".."} and not normalized.startswith("../")


def parse_xml_parts(parts: dict[str, bytes], failures: list[dict[str, Any]]) -> dict[str, ET.Element]:
    roots: dict[str, ET.Element] = {}
    for name in sorted(part for part in parts if part.endswith((".xml", ".rels"))):
        try:
            roots[name] = ET.fromstring(parts[name])
        except ET.ParseError as error:
            failures.append(failure("RF004", f"XML is not well formed: {error}", part=name))
    return roots


def audit_relationships(
    parts: dict[str, bytes], roots: dict[str, ET.Element], failures: list[dict[str, Any]]
) -> tuple[int, int]:
    relationship_parts = sorted(part for part in parts if part.endswith(".rels"))
    ids_by_owner: dict[str | None, set[str]] = {}
    relationship_count = 0
    for part in relationship_parts:
        try:
            owner = relationship_owner(part)
        except ValueError as error:
            failures.append(failure("RF005", str(error), part=part))
            continue
        if owner is not None and owner not in parts:
            failures.append(failure("RF005", "relationship owner part is missing", part=part, owner=owner))
        root = roots.get(part)
        if root is None:
            continue
        if root.tag != f"{{{PACKAGE_RELATIONSHIPS}}}Relationships":
            failures.append(failure("RF004", "relationship part has the wrong root element", part=part))
            continue
        relationships = list(root)
        ids = [item.get("Id", "") for item in relationships]
        ids_by_owner[owner] = set(ids)
        if any(not item for item in ids):
            failures.append(failure("RF006", "relationship IDs must be nonempty", part=part))
        duplicates = sorted({item for item in ids if item and ids.count(item) > 1})
        if duplicates:
            failures.append(failure("RF006", "relationship IDs must be unique", part=part, duplicateIds=duplicates))
        for item in relationships:
            relationship_count += 1
            rel_type = item.get("Type", "")
            target = item.get("Target", "")
            mode = item.get("TargetMode", "")
            if not rel_type or not target:
                failures.append(failure("RF006", "relationship Type and Target must be nonempty", part=part, relationshipId=item.get("Id", "")))
                continue
            if mode == "External":
                continue
            if mode:
                failures.append(failure("RF006", "relationship TargetMode must be empty or External", part=part, relationshipId=item.get("Id", ""), targetMode=mode))
                continue
            try:
                resolved = resolve_internal_target(owner, target)
            except ValueError as error:
                failures.append(failure("RF007", str(error), part=part, relationshipId=item.get("Id", ""), target=target))
                continue
            if resolved not in parts:
                failures.append(failure("RF007", "internal relationship target is missing", part=part, relationshipId=item.get("Id", ""), target=target, resolvedTarget=resolved))

    for owner, root in sorted(
        ((name, root) for name, root in roots.items() if not name.endswith(".rels")),
        key=lambda item: item[0],
    ):
        references = sorted({
            value
            for element in root.iter()
            for attribute, value in element.attrib.items()
            if attribute.startswith(f"{{{OFFICE_RELATIONSHIPS}}}")
        })
        if not references:
            continue
        declared = ids_by_owner.get(owner, set())
        missing = sorted(set(references) - declared)
        if missing:
            failures.append(failure("RF008", "XML contains dangling office relationship references", part=owner, relationshipPart=relationship_part(owner), missingIds=missing))
    return len(relationship_parts), relationship_count


def audit_content_types(
    parts: dict[str, bytes], roots: dict[str, ET.Element], failures: list[dict[str, Any]]
) -> tuple[int, int, int]:
    root = roots.get("[Content_Types].xml")
    if root is None:
        failures.append(failure("RF009", "content-type coverage cannot be validated because [Content_Types].xml is missing or invalid", part="[Content_Types].xml"))
        return 0, 0, 0
    if root.tag != f"{{{CONTENT_TYPES}}}Types":
        failures.append(failure("RF009", "[Content_Types].xml has the wrong root element", part="[Content_Types].xml"))
        return 0, 0, 0
    defaults: dict[str, str] = {}
    overrides: dict[str, str] = {}
    for item in root:
        if item.tag == f"{{{CONTENT_TYPES}}}Default":
            extension = item.get("Extension", "").lower().lstrip(".")
            content_type = item.get("ContentType", "")
            if not extension or not content_type:
                failures.append(failure("RF009", "content-type defaults require Extension and ContentType", part="[Content_Types].xml"))
            elif extension in defaults:
                failures.append(failure("RF009", "content-type default extensions must be unique", part="[Content_Types].xml", extension=extension))
            else:
                defaults[extension] = content_type
        elif item.tag == f"{{{CONTENT_TYPES}}}Override":
            raw_name = item.get("PartName", "")
            content_type = item.get("ContentType", "")
            part_name = urllib.parse.unquote(raw_name).lstrip("/")
            if not raw_name.startswith("/") or not safe_part_name(part_name) or not content_type:
                failures.append(failure("RF009", "content-type overrides require an absolute safe PartName and ContentType", part="[Content_Types].xml", partName=raw_name))
            elif part_name in overrides:
                failures.append(failure("RF009", "content-type override part names must be unique", part="[Content_Types].xml", partName=raw_name))
            else:
                overrides[part_name] = content_type
        else:
            failures.append(failure("RF009", "[Content_Types].xml contains an unsupported child", part="[Content_Types].xml", child=item.tag))
    if defaults.get("rels") != RELATIONSHIP_CONTENT_TYPE:
        failures.append(failure("RF009", "the .rels default content type is missing or incorrect", part="[Content_Types].xml"))
    for part_name in sorted(overrides):
        if part_name not in parts:
            failures.append(failure("RF009", "content-type override targets a missing part", part="[Content_Types].xml", partName=f"/{part_name}"))
    covered = 0
    for part_name in sorted(parts):
        if part_name == "[Content_Types].xml" or part_name.endswith(".rels"):
            continue
        extension = posixpath.basename(part_name).rsplit(".", 1)[1].lower() if "." in posixpath.basename(part_name) else ""
        content_type = overrides.get(part_name) or defaults.get(extension)
        if not content_type:
            failures.append(failure("RF009", "package part has no content-type default or override", part=part_name))
        else:
            covered += 1
    return len(defaults), len(overrides), covered


def audit(path: Path) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    parts: dict[str, bytes] = {}
    zip_integrity = False
    duplicate_names: list[str] = []
    try:
        with zipfile.ZipFile(path) as archive:
            infos = [item for item in archive.infolist() if not item.is_dir()]
            names = [item.filename for item in infos]
            duplicate_names = sorted({name for name in names if names.count(name) > 1})
            if duplicate_names:
                failures.append(failure("RF002", "ZIP contains duplicate package part names", duplicateParts=duplicate_names))
            unsafe = sorted({name for name in names if not safe_part_name(name)})
            if unsafe:
                failures.append(failure("RF010", "ZIP contains unsafe package part names", unsafeParts=unsafe))
            bad_member = archive.testzip()
            if bad_member:
                failures.append(failure("RF001", "ZIP member failed CRC validation", part=bad_member))
            else:
                zip_integrity = True
            for item in infos:
                if item.filename not in parts:
                    parts[item.filename] = archive.read(item)
    except (OSError, RuntimeError, zipfile.BadZipFile, zlib.error) as error:
        failures.append(failure("RF001", f"package is not a readable ZIP archive: {error}"))

    missing_required = sorted(REQUIRED_PARTS - set(parts))
    if missing_required:
        failures.append(failure("RF003", "package is missing required OPC/PowerPoint parts", missingParts=missing_required))
    roots = parse_xml_parts(parts, failures)
    relationship_parts, relationships = audit_relationships(parts, roots, failures)
    defaults, overrides, covered_parts = audit_content_types(parts, roots, failures)
    xml_parts = sum(name.endswith((".xml", ".rels")) for name in parts)
    checks = {
        "zipIntegrity": zip_integrity,
        "uniquePartNames": not duplicate_names,
        "requiredParts": not missing_required,
        "xmlWellFormed": not any(item["code"] == "RF004" for item in failures),
        "relationshipOwnersAndIds": not any(item["code"] in {"RF005", "RF006"} for item in failures),
        "internalRelationshipTargets": not any(item["code"] == "RF007" for item in failures),
        "relationshipReferences": not any(item["code"] == "RF008" for item in failures),
        "contentTypeCoverage": not any(item["code"] == "RF009" for item in failures),
        "safePartNames": not any(item["code"] == "RF010" for item in failures),
    }
    payload = path.read_bytes() if path.is_file() else b""
    return {
        "schemaVersion": "slidewright-repair-free-opc-audit/v1",
        "valid": not failures and all(checks.values()),
        "file": {"name": path.name, "bytes": len(payload), "sha256": sha256(payload) if payload else None},
        "checks": checks,
        "summary": {
            "parts": len(parts),
            "xmlParts": xml_parts,
            "relationshipParts": relationship_parts,
            "relationships": relationships,
            "contentTypeDefaults": defaults,
            "contentTypeOverrides": overrides,
            "contentTypedNonRelationshipParts": covered_parts,
        },
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--json", dest="json_path", type=Path)
    args = parser.parse_args()
    report = audit(args.pptx)
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.json_path:
        args.json_path.parent.mkdir(parents=True, exist_ok=True)
        args.json_path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
