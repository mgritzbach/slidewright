#!/usr/bin/env python3
"""Audit PowerPoint SaveAs semantics for a g22-v2 profile composition.

The shared C10 auditor remains frozen to its published evidence closure.  This
bounded adapter accepts only three additional PowerPoint normalizations observed
on the licensed profile fixture: relationship-ID rebasing, whitespace-only XML
text, and rebinding the same named asymmetry declaration to derivative bytes.
Relationship targets, slide order, theme values, and profile semantics remain
strictly compared.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
import tempfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

SCRIPT_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = SCRIPT_DIR.parent / "template"
sys.path.insert(0, str(TEMPLATE_DIR))
sys.path.insert(0, str(SCRIPT_DIR))

import audit_powerpoint_roundtrip_semantics as base  # noqa: E402
from design_profile_core import ProfileError, extract_profile, read_package  # noqa: E402

R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"


def rels_part(owner: str) -> str:
    directory, name = posixpath.split(owner)
    return posixpath.join(directory, "_rels", name + ".rels")


def relationship_targets(parts: dict[str, bytes], owner: str) -> dict[str, str]:
    part = rels_part(owner)
    if part not in parts:
        return {}
    result: dict[str, str] = {}
    for item in ET.fromstring(parts[part]):
        rel_id = item.get("Id", "")
        target = item.get("Target", "")
        mode = item.get("TargetMode", "")
        resolved = target if mode == "External" else posixpath.normpath(
            posixpath.join(posixpath.dirname(owner), target)
        ).lstrip("/")
        result[rel_id] = "|".join((item.get("Type", ""), mode, resolved))
    return result


def project_xml(node: ET.Element) -> Any:
    return {
        "tag": node.tag,
        "attributes": sorted(node.attrib.items()),
        "text": node.text or "",
        "children": [project_xml(item) for item in node],
    }


def normalized_relationship_part(payload: bytes) -> Any:
    root = ET.fromstring(payload)
    for node in root.iter():
        if node.tag == f"{{{PR}}}Relationship":
            node.attrib.pop("Id", None)
        if node.text is not None and not node.text.strip():
            node.text = ""
        if node.tail is not None and not node.tail.strip():
            node.tail = ""
    root[:] = sorted(root, key=lambda item: (
        item.get("Type", ""), item.get("TargetMode", ""), item.get("Target", "")
    ))
    return project_xml(root)


def replace_relationship_references(value: Any, rel_targets: dict[str, str]) -> Any:
    if isinstance(value, list):
        return [replace_relationship_references(item, rel_targets) for item in value]
    if not isinstance(value, dict):
        return value
    attributes = []
    for key, item in value.get("attributes", []):
        if key.startswith(f"{{{R}}}") and item in rel_targets:
            item = "__SLIDEWRIGHT_RELATIONSHIP__" + rel_targets[item]
        attributes.append((key, item))
    return {
        **value,
        "attributes": sorted(attributes),
        "children": [replace_relationship_references(item, rel_targets) for item in value.get("children", [])],
    }


def normalized_owner_part(part: str, payload: bytes, rel_targets: dict[str, str]) -> Any:
    semantic, _ = base.normalize_xml(part, payload)
    return replace_relationship_references(semantic, rel_targets)


def scrub_whitespace_only_text(value: Any) -> Any:
    if isinstance(value, list):
        return [scrub_whitespace_only_text(item) for item in value]
    if not isinstance(value, dict):
        return value
    result = dict(value)
    if isinstance(result.get("text"), str) and not result["text"].strip():
        result["text"] = ""
    result["children"] = [scrub_whitespace_only_text(item) for item in result.get("children", [])]
    return result


def compare_composition_part(part: str, source_parts: dict[str, bytes], roundtrip_parts: dict[str, bytes]) -> str | None:
    """Return the narrow accepted normalization label, or None on semantic drift."""
    if part not in source_parts or part not in roundtrip_parts:
        return None
    if part.endswith(".rels"):
        if normalized_relationship_part(source_parts[part]) == normalized_relationship_part(roundtrip_parts[part]):
            return "relationship-id-rebase"
        return None
    if part.endswith(".xml"):
        source_targets = relationship_targets(source_parts, part)
        roundtrip_targets = relationship_targets(roundtrip_parts, part)
        if source_targets or roundtrip_targets:
            left = normalized_owner_part(part, source_parts[part], source_targets)
            right = normalized_owner_part(part, roundtrip_parts[part], roundtrip_targets)
            if left == right:
                return "relationship-target-rebind"
        if part.startswith("ppt/theme/"):
            left, _ = base.normalize_xml(part, source_parts[part])
            right, _ = base.normalize_xml(part, roundtrip_parts[part])
            if scrub_whitespace_only_text(left) == scrub_whitespace_only_text(right):
                return "whitespace-only-theme-text"
    return None


def derivative_profile(deck: Path, manifest: Path) -> dict[str, Any]:
    declaration = json.loads(manifest.read_text(encoding="utf-8-sig"))
    declaration["sourceSha256"] = base.sha(deck.read_bytes())
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(declaration, handle, ensure_ascii=False)
    try:
        return base.profile_projection(extract_profile(deck, temporary))
    finally:
        temporary.unlink(missing_ok=True)


def audit(source: Path, roundtrip: Path, manifest: Path) -> dict[str, Any]:
    baseline = base.audit(source, roundtrip)
    source_parts, _ = read_package(source)
    roundtrip_parts, _ = read_package(roundtrip)
    checks: dict[str, bool] = {
        "designProfile.semanticProjection": derivative_profile(source, manifest) == derivative_profile(roundtrip, manifest)
    }

    remaining = []
    accepted = []
    for failure in baseline.get("failures", []):
        field = failure.get("field", "")
        if field == "designProfile.semanticProjection" and checks[field]:
            accepted.append({"field": field, "normalization": "declared-asymmetry-hash-rebind"})
        elif field.startswith("parts."):
            part = field.removeprefix("parts.")
            normalization = compare_composition_part(part, source_parts, roundtrip_parts)
            checks[part] = normalization is not None
            if normalization:
                accepted.append({"field": field, "normalization": normalization})
            else:
                remaining.append(failure)
        else:
            remaining.append(failure)

    report = {
        "schemaVersion": "slidewright-profile-composition-roundtrip-audit/v1",
        "valid": not remaining and all(checks.values()),
        "sourceSha256": base.sha(source.read_bytes()),
        "roundtripSha256": base.sha(roundtrip.read_bytes()),
        "sharedAuditorValidBeforeCompositionNormalizations": baseline.get("valid") is True,
        "acceptedCompositionNormalizations": accepted,
        "checks": checks,
        "failures": remaining + [
            {"field": key, "error": "Composition-specific semantic comparison failed."}
            for key, valid in checks.items() if not valid and not any(
                item.get("field") in {key, f"parts.{key}"} for item in remaining
            )
        ],
    }
    report["auditSha256"] = base.canonical_hash({key: value for key, value in report.items() if key != "auditSha256"})
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a g22-v2 PowerPoint round trip.")
    parser.add_argument("source", type=Path)
    parser.add_argument("roundtrip", type=Path)
    parser.add_argument("--asymmetry-manifest", type=Path, required=True)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args.source, args.roundtrip, args.asymmetry_manifest)
    except (OSError, ValueError, ET.ParseError, ProfileError, json.JSONDecodeError) as error:
        report = {
            "schemaVersion": "slidewright-profile-composition-roundtrip-audit/v1",
            "valid": False,
            "failures": [{"field": "audit", "error": str(error)}],
        }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report.get("valid") else 1


if __name__ == "__main__":
    raise SystemExit(main())
