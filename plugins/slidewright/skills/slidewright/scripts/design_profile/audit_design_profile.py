#!/usr/bin/env python3
"""Audit a derived PPTX against a source-bound Slidewright design profile.

Usage:
  python audit_design_profile.py source.pptx derived.pptx --profile profile.json
  python audit_design_profile.py source.pptx derived.pptx --profile profile.json --json audit.json

Only slide-content subtrees may evolve in this bounded v1 slice. Masters,
layouts, themes, PowerPoint guides, named logos/groups/media, recurring chrome,
source archetypes, and exact rail/limiter contracts remain protected.
"""

from __future__ import annotations

import argparse
import html
import re
import json
import sys
from pathlib import Path
from typing import Any

from design_profile_core import (
    ProfileError,
    canonical_hash,
    extract_profile,
    json_payload,
    portable_integrity_hash,
    read_package,
)


def keyed(items: list[dict[str, Any]], field: str) -> dict[str, dict[str, Any]]:
    return {str(item[field]): item for item in items}


def normalize_authorized_text(
    payload: bytes,
    edits: list[dict[str, Any]],
    side: str,
) -> bytes:
    xml = payload.decode("utf-8")
    for edit_index, edit in enumerate(edits):
        shape_name = str(edit.get("shapeName", ""))
        marker = f'name="{html.escape(shape_name, quote=True)}"'
        if not shape_name or xml.count(marker) != 1:
            raise ProfileError(f"Edit plan shape {shape_name!r} is not unique in the target slide.")
        marker_position = xml.index(marker)
        start = xml.rfind("<p:sp>", 0, marker_position)
        end = xml.find("</p:sp>", marker_position)
        if start < 0 or end < 0:
            raise ProfileError(f"Edit plan shape {shape_name!r} is not a native p:sp.")
        end += len("</p:sp>")
        shape = xml[start:end]
        pattern = re.compile(r"(<a:t(?:\s[^>]*)?>)(.*?)(</a:t>)", re.DOTALL)
        matches = list(pattern.finditer(shape))
        expected = str(edit.get("before" if side == "source" else "after", "")).split("\n")
        actual = [html.unescape(match.group(2)) for match in matches]
        if actual != expected:
            raise ProfileError(
                f"Edit plan {side} text mismatch for {shape_name!r}: expected {expected!r}, found {actual!r}."
            )
        replacements = iter(
            f"{match.group(1)}__SLIDEWRIGHT_AUTHORIZED_TEXT_{edit_index}_{run_index}__{match.group(3)}"
            for run_index, match in enumerate(matches)
        )
        normalized_shape = pattern.sub(lambda _match: next(replacements), shape)
        xml = xml[:start] + normalized_shape + xml[end:]
    return xml.encode("utf-8")


def validate_edit_plan(
    plan: dict[str, Any],
    source_sha256: str,
    slide_count: int,
) -> tuple[str, list[dict[str, Any]]]:
    if plan.get("mode") != "clone-source-deck":
        raise ProfileError("Edit plan mode must be clone-source-deck.")
    if plan.get("sourceSha256", "").lower() != source_sha256:
        raise ProfileError("Edit plan sourceSha256 does not match the audited source.")
    try:
        target_slide = int(plan["targetSlide"])
    except (KeyError, TypeError, ValueError) as error:
        raise ProfileError("Edit plan targetSlide must be an integer.") from error
    if target_slide < 1 or target_slide > slide_count:
        raise ProfileError("Edit plan targetSlide is outside the source deck.")
    edits = plan.get("edits")
    if not isinstance(edits, list) or not edits:
        raise ProfileError("Edit plan must declare at least one edit.")
    names = [str(edit.get("shapeName", "")) for edit in edits if isinstance(edit, dict)]
    if len(names) != len(edits) or any(not name for name in names) or len(set(names)) != len(names):
        raise ProfileError("Edit plan shape names must be non-empty and unique.")
    return f"ppt/slides/slide{target_slide}.xml", edits


def contract_core(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "part": item["part"],
        "orientation": item["orientation"],
        "first": item["first"],
        "second": item["second"],
        "thicknessEmu": item["thicknessEmu"],
        "oppositeEdgeOffsetsEmu": item["oppositeEdgeOffsetsEmu"],
        "equalThickness": item["equalThickness"],
        "equalOppositeEdgeOffsets": item["equalOppositeEdgeOffsets"],
        "equalAppearance": item["equalAppearance"],
        "symmetric": item["symmetric"],
        "appearance": item["appearance"],
    }


def audit(
    source_path: Path,
    derived_path: Path,
    stored: dict[str, Any],
    edit_plan: dict[str, Any] | None,
    asymmetry_manifest: Path | None,
) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []

    def check(condition: bool, field: str, expected: Any, actual: Any) -> None:
        if not condition:
            failures.append({"field": field, "expected": expected, "actual": actual})

    if stored.get("schemaVersion") != "slidewright-design-profile/v1":
        raise ProfileError("Profile schemaVersion must be slidewright-design-profile/v1.")
    portable_digest = stored.get("portableIntegritySha256", "")
    portable_basis = dict(stored)
    portable_basis.pop("portableIntegritySha256", None)
    check(portable_digest == portable_integrity_hash(portable_basis), "portable-profile-integrity", portable_digest, portable_integrity_hash(portable_basis))
    supplied_digest = portable_basis.get("profileSha256", "")
    digest_basis = dict(portable_basis)
    digest_basis.pop("profileSha256", None)
    check(supplied_digest == canonical_hash(digest_basis), "profile-integrity", supplied_digest, canonical_hash(digest_basis))

    if stored.get("declaredAsymmetries") and asymmetry_manifest is None:
        raise ProfileError("A source-bound asymmetry manifest is required to revalidate declared asymmetries.")

    source = extract_profile(source_path, asymmetry_manifest, enforce_symmetry=True)
    derived = extract_profile(derived_path, None, enforce_symmetry=False)
    check(stored.get("profileSha256") == source.get("profileSha256"), "source-profile", stored.get("profileSha256"), source.get("profileSha256"))
    check(stored.get("source", {}).get("sha256") == source.get("source", {}).get("sha256"), "source-pptx-sha256", stored.get("source", {}).get("sha256"), source.get("source", {}).get("sha256"))

    plan_bound = False
    package_parts_checked = 0
    relationship_tuples_checked = 0
    authorized_text_shapes = 0
    if edit_plan is not None:
        target_part, authorized_edits = validate_edit_plan(
            edit_plan,
            source["source"]["sha256"],
            len(source["slides"]),
        )
        source_parts_raw, source_relationships = read_package(source_path)
        derived_parts_raw, derived_relationships = read_package(derived_path)
        check(
            set(source_parts_raw) == set(derived_parts_raw),
            "package-part-inventory",
            sorted(source_parts_raw),
            sorted(derived_parts_raw),
        )
        check(
            source_relationships == derived_relationships,
            "relationship-tuples",
            source_relationships,
            derived_relationships,
        )
        for part in sorted(source_parts_raw):
            if part not in derived_parts_raw:
                continue
            expected_payload = source_parts_raw[part]
            actual_payload = derived_parts_raw[part]
            if part == target_part:
                expected_payload = normalize_authorized_text(expected_payload, authorized_edits, "source")
                actual_payload = normalize_authorized_text(actual_payload, authorized_edits, "derived")
            check(
                expected_payload == actual_payload,
                f"package-part-exact:{part}",
                canonical_hash({"part": part, "payload": expected_payload.hex()}),
                canonical_hash({"part": part, "payload": actual_payload.hex()}),
            )
        plan_bound = True
        package_parts_checked = len(source_parts_raw)
        relationship_tuples_checked = len(source_relationships)
        authorized_text_shapes = len(authorized_edits)

    derived_parts = keyed(derived["package"]["parts"], "part")
    for expected in source["package"]["protectedParts"]:
        actual = derived_parts.get(expected["part"])
        check(actual is not None, f"protected-part-present:{expected['part']}", expected, actual)
        if actual is not None:
            check(actual["sha256"] == expected["sha256"], f"protected-part-hash:{expected['part']}", expected["sha256"], actual["sha256"])

    check(
        source["presentation"]["slideSize"] == derived["presentation"]["slideSize"],
        "slide-size",
        source["presentation"]["slideSize"],
        derived["presentation"]["slideSize"],
    )
    check(
        source["presentation"]["guides"] == derived["presentation"]["guides"],
        "powerpoint-guides",
        source["presentation"]["guides"],
        derived["presentation"]["guides"],
    )
    for field in ("themes", "masters", "layouts"):
        check(source[field] == derived[field], field, source[field], derived[field])

    for asset_type in ("logos", "groups", "media"):
        source_assets = keyed(source["assets"][asset_type], "objectKey" if asset_type != "media" else "part")
        derived_assets = keyed(derived["assets"][asset_type], "objectKey" if asset_type != "media" else "part")
        for key, expected in source_assets.items():
            check(key in derived_assets, f"{asset_type}-present:{key}", expected, derived_assets.get(key))
            if key in derived_assets:
                check(expected == derived_assets[key], f"{asset_type}-preserved:{key}", expected, derived_assets[key])

    source_chrome = keyed(source["chrome"]["objects"], "objectKey")
    derived_chrome = keyed(derived["chrome"]["objects"], "objectKey")
    for key, expected in source_chrome.items():
        check(key in derived_chrome, f"chrome-present:{key}", expected, derived_chrome.get(key))
        if key in derived_chrome:
            check(expected == derived_chrome[key], f"chrome-preserved:{key}", expected, derived_chrome[key])

    source_contracts = keyed(source["symmetryContracts"], "id")
    derived_contracts = keyed(derived["symmetryContracts"], "id")
    check(set(source_contracts) == set(derived_contracts), "symmetry-contract-inventory", sorted(source_contracts), sorted(derived_contracts))
    for key, expected in source_contracts.items():
        if key not in derived_contracts:
            continue
        actual = derived_contracts[key]
        check(contract_core(expected) == contract_core(actual), f"symmetry-contract:{key}", contract_core(expected), contract_core(actual))
        if expected["declaredAsymmetry"] is None:
            check(actual["symmetric"], f"exact-symmetry:{key}", True, actual["symmetric"])
        else:
            declaration = expected["declaredAsymmetry"]
            check(
                declaration.get("sourceSha256") == source["source"]["sha256"],
                f"asymmetry-source-binding:{key}",
                source["source"]["sha256"],
                declaration.get("sourceSha256"),
            )

    allowed_archetypes = {item["id"] for item in source["archetypes"]}
    actual_archetypes = {item["id"] for item in derived["archetypes"]}
    check(
        actual_archetypes <= allowed_archetypes,
        "derived-archetypes",
        sorted(allowed_archetypes),
        sorted(actual_archetypes),
    )

    report = {
        "schemaVersion": "slidewright-design-profile-audit/v1",
        "valid": not failures,
        "sourceSha256": source["source"]["sha256"],
        "derivedSha256": derived["source"]["sha256"],
        "profileSha256": stored.get("profileSha256", ""),
        "summary": {
            "planBound": plan_bound,
            "packagePartsChecked": package_parts_checked,
            "relationshipTuplesChecked": relationship_tuples_checked,
            "authorizedTextShapes": authorized_text_shapes,
            "protectedPartsChecked": len(source["package"]["protectedParts"]),
            "guidesChecked": len(source["presentation"]["guides"]),
            "logosChecked": len(source["assets"]["logos"]),
            "groupsChecked": len(source["assets"]["groups"]),
            "mediaChecked": len(source["assets"]["media"]),
            "chromeObjectsChecked": len(source["chrome"]["objects"]),
            "symmetryContractsChecked": len(source_contracts),
            "sourceArchetypes": len(allowed_archetypes),
            "derivedArchetypes": len(actual_archetypes),
        },
        "failures": failures,
    }
    report["reportSha256"] = canonical_hash(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit source-to-derived PowerPoint design preservation.")
    parser.add_argument("source", type=Path, help="Original source .pptx.")
    parser.add_argument("derived", type=Path, help="Derived .pptx to audit.")
    parser.add_argument("--profile", required=True, type=Path, help="JSON emitted by extract_design_profile.py.")
    parser.add_argument("--edit-plan", type=Path, help="Source-bound clone edit plan authorizing the only allowed text changes.")
    parser.add_argument("--json", type=Path, help="Optional audit report output.")
    parser.add_argument("--asymmetry-manifest", type=Path, help="Required when the profile declares source-bound asymmetry.")
    args = parser.parse_args()

    try:
        stored = json.loads(args.profile.read_text(encoding="utf-8"))
        edit_plan = json.loads(args.edit_plan.read_text(encoding="utf-8")) if args.edit_plan else None
        report = audit(args.source, args.derived, stored, edit_plan, args.asymmetry_manifest)
    except (OSError, json.JSONDecodeError, ProfileError) as error:
        sys.stderr.write(f"design-profile audit failed: {error}\n")
        return 2

    payload = json_payload(report)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(payload, encoding="utf-8", newline="\n")
    sys.stdout.write(payload)
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
