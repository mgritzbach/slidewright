#!/usr/bin/env python3
"""Fail-closed semantic audit for a native PowerPoint save/reopen round trip.

The audit deliberately does not compare ZIP bytes: PowerPoint refreshes document
properties, locale-dependent field displays, and revision metadata.  Everything
else is compared through a canonical OOXML projection plus the richer
Slidewright design profile.  The small normalization allowlist is explicit and
reported so a newly observed PowerPoint rewrite fails closed.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

SCRIPT_DIR = Path(__file__).resolve().parent
PROFILE_DIR = SCRIPT_DIR.parent / "design_profile"
sys.path.insert(0, str(PROFILE_DIR))

from design_profile_core import ProfileError, extract_profile, read_package  # noqa: E402

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"

VOLATILE_PARTS = {
    "ppt/changesInfos/changesInfo1.xml",
    "ppt/revisionInfo.xml",
}
VOLATILE_RELATIONSHIP_SUFFIXES = ("/changesInfo", "/revisionInfo")
XML_EXTENSIONS = (".xml", ".rels")
DYNAMIC_PLACEHOLDERS = {"date", "slide-number"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return sha(canonical(value))


def lname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def is_empty(node: ET.Element) -> bool:
    return not node.attrib and not list(node) and not (node.text or "").strip()


def normalize_xml(part: str, data: bytes) -> tuple[Any, list[str]]:
    """Return a namespace-stable semantic tree and applied normalization labels."""
    root = ET.fromstring(data)
    normalizations: set[str] = set()

    def visit(node: ET.Element) -> None:
        # Current PowerPoint materializes an explicit clean-cache marker on
        # table-cell runs during SaveAs. Absence and dirty="0" are equivalent;
        # dirty="1" remains semantic and must never be normalized.
        if node.tag in {f"{{{A}}}rPr", f"{{{A}}}endParaRPr"} and node.get("dirty") == "0":
            del node.attrib["dirty"]
            normalizations.add("explicit-clean-text-cache")

        # PowerPoint refreshes only the displayed value of dynamic fields.  The
        # field type, ID, formatting, and all surrounding text remain audited.
        if node.tag == f"{{{A}}}fld" and node.get("type", "").lower().startswith(("datetime", "slidenum")):
            for item in node.iter():
                if item.tag == f"{{{A}}}t":
                    item.text = "__SLIDEWRIGHT_DYNAMIC_FIELD__"
                    normalizations.add("dynamic-field-display")

        for item in list(node):
            visit(item)
            if item.tag == f"{{{C}}}layout" and is_empty(item):
                node.remove(item)
                normalizations.add("empty-chart-layout")
            elif lname(item.tag) == "extLst" and is_empty(item):
                node.remove(item)
                normalizations.add("empty-extension-list")

        # PowerPoint moves showDLblsOverMax across extLst while retaining the
        # same value. Canonicalize only that known sibling pair.
        children = list(node)
        show = next((item for item in children if item.tag == f"{{{C}}}showDLblsOverMax"), None)
        ext = next((item for item in children if item.tag == f"{{{C}}}extLst"), None)
        if show is not None and ext is not None and children.index(show) > children.index(ext):
            node.remove(show)
            node.insert(list(node).index(ext), show)
            normalizations.add("chart-show-label-order")

    visit(root)

    if part == "docProps/core.xml":
        for item in root.iter():
            if lname(item.tag) == "lastModifiedBy":
                item.text = "__SLIDEWRIGHT_LAST_MODIFIER__"
                normalizations.add("core-last-modified-by")
            elif lname(item.tag) == "modified":
                item.text = "__SLIDEWRIGHT_MODIFIED_TIME__"
                normalizations.add("core-modified-time")

    if part == "docProps/app.xml":
        recalculated = {"TotalTime", "Words", "Paragraphs", "Characters", "CharactersWithSpaces", "PresentationFormat", "Application"}
        for item in root.iter():
            if lname(item.tag) in recalculated:
                item.text = f"__SLIDEWRIGHT_RECALCULATED_{lname(item.tag).upper()}__"
                normalizations.add(f"app-recalculated-{lname(item.tag)}")
        for item in list(root):
            if lname(item.tag) in {"HeadingPairs", "TitlesOfParts"}:
                item.clear()
                item.text = f"__SLIDEWRIGHT_RECALCULATED_{lname(item.tag).upper()}__"
                normalizations.add(f"app-recalculated-{lname(item.tag)}")

    if part == "[Content_Types].xml":
        for item in list(root):
            name = item.get("PartName", "").lstrip("/")
            if name in VOLATILE_PARTS:
                root.remove(item)
                normalizations.add("revision-content-type")
        root[:] = sorted(root, key=lambda item: (item.tag, sorted(item.attrib.items())))
        normalizations.add("content-type-order")

    if part.endswith(".rels"):
        for item in list(root):
            if item.get("Type", "").endswith(VOLATILE_RELATIONSHIP_SUFFIXES):
                root.remove(item)
                normalizations.add("revision-relationship")
        root[:] = sorted(root, key=lambda item: (item.get("Type", ""), item.get("TargetMode", ""), item.get("Target", "")))
        normalizations.add("relationship-order")

    if part == "ppt/viewProps.xml" and "lastView" in root.attrib:
        del root.attrib["lastView"]
        normalizations.add("powerpoint-last-view")

    def project(node: ET.Element) -> Any:
        return {
            "tag": node.tag,
            "attributes": sorted(node.attrib.items()),
            "text": node.text or "",
            "children": [project(item) for item in node],
        }

    return project(root), sorted(normalizations)


def filtered_relationships(items: list[dict[str, str]]) -> tuple[list[dict[str, str]], list[str]]:
    result = []
    ignored = []
    for item in items:
        if item["type"].endswith(VOLATILE_RELATIONSHIP_SUFFIXES):
            ignored.append(f'{item["owner"]}:{item["type"]}')
        else:
            result.append(item)
    return result, sorted(ignored)


def scrub_hashes(value: Any) -> Any:
    if isinstance(value, list):
        return [scrub_hashes(item) for item in value]
    if isinstance(value, dict):
        return {
            key: scrub_hashes(item)
            for key, item in sorted(value.items())
            if not key.lower().endswith("sha256")
        }
    return value


def normalize_object(item: dict[str, Any]) -> dict[str, Any]:
    result = scrub_hashes(copy.deepcopy(item))
    placeholder = result.get("placeholder") or {}
    if placeholder.get("type") in DYNAMIC_PLACEHOLDERS and result.get("text"):
        text = result["text"]
        text["plainText"] = "__SLIDEWRIGHT_DYNAMIC_FIELD__"
        for paragraph in text.get("paragraphs", []):
            for run in paragraph.get("runs", []):
                run["text"] = "__SLIDEWRIGHT_DYNAMIC_FIELD__"
    return result


def profile_projection(profile: dict[str, Any]) -> dict[str, Any]:
    stable_sections = [
        "presentation", "slides", "themes", "fonts", "palette", "assets", "spacing",
        "symmetryContracts", "guides", "declaredAsymmetries",
    ]
    result = {key: scrub_hashes(profile.get(key)) for key in stable_sections}
    result["layouts"] = scrub_hashes(profile.get("layouts", []))
    result["masters"] = scrub_hashes(profile.get("masters", []))
    result["objects"] = [normalize_object(item) for item in profile.get("objects", [])]
    return result


def classify_part(part: str) -> str:
    if part.startswith("ppt/charts/") and part.endswith(".xml"):
        return "charts"
    if part.startswith("ppt/embeddings/"):
        return "embedded-workbooks"
    if part.startswith("ppt/media/"):
        return "media"
    if part.endswith(".rels"):
        return "relationships"
    return "package-xml" if part.endswith(XML_EXTENSIONS) or part == "[Content_Types].xml" else "package-binary"


def audit(source: Path, roundtrip: Path) -> dict[str, Any]:
    source_parts, source_rels = read_package(source)
    roundtrip_parts, roundtrip_rels = read_package(roundtrip)
    source_names = sorted(set(source_parts) - VOLATILE_PARTS)
    roundtrip_names = sorted(set(roundtrip_parts) - VOLATILE_PARTS)
    failures: list[dict[str, Any]] = []
    normalizations: dict[str, list[str]] = {}

    if source_names != roundtrip_names:
        failures.append({
            "field": "package.partInventory",
            "sourceOnly": sorted(set(source_names) - set(roundtrip_names)),
            "roundtripOnly": sorted(set(roundtrip_names) - set(source_names)),
        })

    category_counts: dict[str, int] = {}
    for part in sorted(set(source_names) & set(roundtrip_names)):
        category = classify_part(part)
        category_counts[category] = category_counts.get(category, 0) + 1
        left, right = source_parts[part], roundtrip_parts[part]
        if part.endswith(XML_EXTENSIONS) or part == "[Content_Types].xml":
            try:
                left_semantic, left_norm = normalize_xml(part, left)
                right_semantic, right_norm = normalize_xml(part, right)
            except ET.ParseError as error:
                failures.append({"field": f"parts.{part}", "error": f"XML parse failure: {error}"})
                continue
            applied = sorted(set(left_norm + right_norm))
            if applied:
                normalizations[part] = applied
            if left_semantic != right_semantic:
                failures.append({
                    "field": f"parts.{part}", "category": category,
                    "sourceSemanticSha256": canonical_hash(left_semantic),
                    "roundtripSemanticSha256": canonical_hash(right_semantic),
                })
        elif left != right:
            failures.append({
                "field": f"parts.{part}", "category": category,
                "sourceSha256": sha(left), "roundtripSha256": sha(right),
            })

    source_relationships, source_ignored = filtered_relationships(source_rels)
    roundtrip_relationships, roundtrip_ignored = filtered_relationships(roundtrip_rels)
    if source_relationships != roundtrip_relationships:
        failures.append({
            "field": "package.relationshipTuples",
            "sourceSha256": canonical_hash(source_relationships),
            "roundtripSha256": canonical_hash(roundtrip_relationships),
        })

    try:
        source_profile = profile_projection(extract_profile(source))
        roundtrip_profile = profile_projection(extract_profile(roundtrip))
        if source_profile != roundtrip_profile:
            failures.append({
                "field": "designProfile.semanticProjection",
                "sourceSha256": canonical_hash(source_profile),
                "roundtripSha256": canonical_hash(roundtrip_profile),
            })
    except ProfileError as error:
        failures.append({"field": "designProfile.semanticProjection", "error": str(error)})

    hyperlink_count = sum(1 for item in source_relationships if item["targetMode"] == "External")
    report = {
        "schemaVersion": "slidewright-powerpoint-roundtrip-semantic-audit/v1",
        "valid": not failures,
        "source": str(source.resolve()),
        "roundtrip": str(roundtrip.resolve()),
        "sourceSha256": sha(source.read_bytes()),
        "roundtripSha256": sha(roundtrip.read_bytes()),
        "counts": {
            "parts": len(source_names),
            "relationshipTuples": len(source_relationships),
            "externalRelationships": hyperlink_count,
            "nativeCharts": sum(1 for item in source_profile.get("objects", []) if item.get("semanticKind") == "chart") if "source_profile" in locals() else 0,
            "nativeTables": sum(1 for item in source_profile.get("objects", []) if item.get("semanticKind") == "table") if "source_profile" in locals() else 0,
            **category_counts,
        },
        "allowedNormalizations": normalizations,
        "ignoredVolatileRelationships": sorted(set(source_ignored + roundtrip_ignored)),
        "failures": failures,
    }
    report["semanticAuditSha256"] = canonical_hash({key: value for key, value in report.items() if key != "semanticAuditSha256"})
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("roundtrip", type=Path)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args.source, args.roundtrip)
    except (OSError, ProfileError, ValueError) as error:
        report = {
            "schemaVersion": "slidewright-powerpoint-roundtrip-semantic-audit/v1",
            "valid": False,
            "failures": [{"field": "audit", "error": str(error)}],
        }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if report.get("valid"):
        print(f'PowerPoint semantic round-trip passed: {report["semanticAuditSha256"]}')
        return 0
    print(json.dumps(report, indent=2, ensure_ascii=False), file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
