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
from hashlib import sha256
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

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


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def validate_source_shape_binding(payload: bytes, edit: dict[str, Any], part: str) -> None:
    fields = ("sourceObjectKey", "sourceObjectSha256", "sourceShapeId", "sourceCreationId", "sourceParagraphSha256s")
    if any(field not in edit for field in fields) or not isinstance(edit.get("sourceParagraphSha256s"), list) or not edit["sourceParagraphSha256s"]:
        raise ProfileError(f"Edit {edit.get('shapeName')!r} lacks its complete source-bound object identity.")
    root = ET.fromstring(payload)
    matches = []

    def visit(node: ET.Element, path: str) -> None:
        for index, child in enumerate(list(node)):
            child_path = f"{path}/{index}"
            if local_name(child.tag) == "sp":
                properties = next((item for item in child.iter() if local_name(item.tag) == "cNvPr"), None)
                if properties is not None and properties.get("name") == edit.get("shapeName"):
                    matches.append((child, properties, child_path))
            visit(child, child_path)

    visit(root, "")
    if len(matches) != 1:
        raise ProfileError(f"Edit plan shape {edit.get('shapeName')!r} is not a unique native source shape.")
    shape, properties, shape_path = matches[0]
    paragraphs = [node for node in shape.iter() if local_name(node.tag) == "p"]
    creation_id = next(
        (node.get("id", "") for node in shape.iter() if local_name(node.tag) == "creationId" and node.get("id")),
        "",
    )
    placeholder = next((node for node in shape.iter() if local_name(node.tag) == "ph"), None)
    raw_type = "" if placeholder is None else placeholder.get("type", "")
    normalized_type = {
        "title": "title",
        "ctrTitle": "title",
        "subTitle": "subtitle",
        "body": "body",
        "obj": "body",
    }.get(raw_type, "body" if placeholder is not None and placeholder.get("idx") is not None else "other")
    placeholder_index = 0 if placeholder is None else int(placeholder.get("idx", "0"))
    actual = {
        "sourceObjectKey": f"{part}::{shape_path}::{edit.get('shapeName')}",
        "sourceObjectSha256": sha256(ET.tostring(shape, encoding="utf-8")).hexdigest(),
        "sourceShapeId": properties.get("id", ""),
        "sourceCreationId": creation_id,
        "sourceParagraphSha256s": [sha256(ET.tostring(item, encoding="utf-8")).hexdigest() for item in paragraphs],
    }
    for field, value in actual.items():
        if edit[field] != value:
            raise ProfileError(f"Edit plan {field} mismatch for {edit.get('shapeName')!r}.")
    if edit.get("placeholderType") != normalized_type or edit.get("placeholderIndex") != placeholder_index:
        raise ProfileError(f"Edit plan placeholder identity mismatch for {edit.get('shapeName')!r}.")


def normalize_authorized_text(
    payload: bytes,
    edits: list[dict[str, Any]],
    side: str,
    part: str,
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
        edit_mode = str(edit.get("editMode", "replace-existing-text"))
        if side == "source":
            validate_source_shape_binding(payload, edit, part)
        if edit_mode == "populate-empty-placeholder":
            expected_text = str(edit.get("before" if side == "source" else "after", ""))
            text_pattern = re.compile(r"<a:t(?:\s[^>]*)?>(.*?)</a:t>", re.DOTALL)
            actual_text = [html.unescape(match.group(1)) for match in text_pattern.finditer(shape)]
            if side == "source":
                if expected_text != "" or actual_text:
                    raise ProfileError(f"Populate edit source placeholder {shape_name!r} is not empty.")
                normalized_shape = shape
            else:
                if actual_text != [expected_text]:
                    raise ProfileError(
                        f"Populate edit derived text mismatch for {shape_name!r}: expected {[expected_text]!r}, found {actual_text!r}."
                    )
                if len(re.findall(r"<a:p(?:\s|>)", shape)) != 1:
                    raise ProfileError(f"Populate edit {shape_name!r} must contain exactly one native paragraph.")
                escaped = re.escape(html.escape(expected_text))
                inserted_run = re.compile(rf"<a:r><a:t>{escaped}</a:t></a:r>")
                matches = list(inserted_run.finditer(shape))
                if len(matches) != 1:
                    raise ProfileError(f"Populate edit {shape_name!r} must contain one exact minimal native text run.")
                normalized_shape = inserted_run.sub("", shape, count=1)
            xml = xml[:start] + normalized_shape + xml[end:]
            continue
        if edit_mode != "replace-existing-text":
            raise ProfileError(f"Edit plan shape {shape_name!r} uses unsupported editMode {edit_mode!r}.")
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
) -> tuple[str | None, list[dict[str, Any]]]:
    if plan.get("mode") not in {"clone-source-deck", "preserve-source-deck"}:
        raise ProfileError("Edit plan mode must be clone-source-deck or preserve-source-deck.")
    if plan.get("sourceSha256", "").lower() != source_sha256:
        raise ProfileError("Edit plan sourceSha256 does not match the audited source.")
    if plan.get("mode") == "preserve-source-deck":
        if plan.get("edits") != [] or plan.get("allowedDeviation") not in (None, []):
            raise ProfileError("Preserve-source-deck plans must declare zero edits and zero deviations.")
        return None, []
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
    for edit in edits:
        if edit.get("editMode", "replace-existing-text") not in {"replace-existing-text", "populate-empty-placeholder"}:
            raise ProfileError("Edit plan editMode must be replace-existing-text or populate-empty-placeholder.")
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
    target_part: str | None = None
    authorized_shape_names: set[str] = set()
    package_parts_checked = 0
    relationship_tuples_checked = 0
    authorized_text_shapes = 0
    if edit_plan is not None:
        target_part, authorized_edits = validate_edit_plan(
            edit_plan,
            source["source"]["sha256"],
            len(source["slides"]),
        )
        authorized_shape_names = {str(edit["shapeName"]) for edit in authorized_edits}
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
            if target_part is not None and part == target_part:
                expected_payload = normalize_authorized_text(expected_payload, authorized_edits, "source", part)
                actual_payload = normalize_authorized_text(actual_payload, authorized_edits, "derived", part)
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
    check(
        source["presentation"].get("inheritanceChains") == derived["presentation"].get("inheritanceChains"),
        "slide-layout-master-theme-chains",
        source["presentation"].get("inheritanceChains"),
        derived["presentation"].get("inheritanceChains"),
    )
    check(source.get("spacing") == derived.get("spacing"), "text-spacing", source.get("spacing"), derived.get("spacing"))
    for field in ("themes", "masters", "layouts"):
        check(source[field] == derived[field], field, source[field], derived[field])

    # Compare every native object semantically, independently from the exact
    # package-byte check. Authorized text objects may change only their text
    # subtree; identity, native kind, placeholder binding, geometry, styling,
    # media bindings, and metadata must remain exact.
    source_objects = keyed(source["objects"], "objectKey")
    derived_objects = keyed(derived["objects"], "objectKey")
    check(set(source_objects) == set(derived_objects), "object-identity-inventory", sorted(source_objects), sorted(derived_objects))
    for key, expected_object in source_objects.items():
        actual_object = derived_objects.get(key)
        if actual_object is None:
            continue
        authorized = target_part is not None and expected_object.get("part") == target_part and expected_object.get("name") in authorized_shape_names
        if authorized:
            expected_object = {field: value for field, value in expected_object.items() if field not in {"xmlSha256", "styleFingerprint", "text"}}
            actual_object = {field: value for field, value in actual_object.items() if field not in {"xmlSha256", "styleFingerprint", "text"}}
        check(expected_object == actual_object, f"object-identity:{key}", expected_object, actual_object)

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
            actual = derived_chrome[key]
            if target_part is not None and expected.get("part") == target_part and expected.get("name") in authorized_shape_names:
                expected = {field: value for field, value in expected.items() if field != "xmlSha256"}
                actual = {field: value for field, value in actual.items() if field != "xmlSha256"}
            check(expected == actual, f"chrome-preserved:{key}", expected, actual)

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
    if plan_bound:
        source_slides = keyed(source["slides"], "part")
        derived_slides = keyed(derived["slides"], "part")
        check(set(source_slides) == set(derived_slides), "slide-profile-inventory", sorted(source_slides), sorted(derived_slides))
        for part, expected_slide in source_slides.items():
            actual_slide = derived_slides.get(part)
            if actual_slide is None:
                continue
            check(
                expected_slide["layoutPart"] == actual_slide["layoutPart"],
                f"slide-layout-binding:{part}",
                expected_slide["layoutPart"],
                actual_slide["layoutPart"],
            )
            if target_part is None or part != target_part:
                check(
                    expected_slide["archetypeId"] == actual_slide["archetypeId"],
                    f"preserved-slide-archetype:{part}",
                    expected_slide["archetypeId"],
                    actual_slide["archetypeId"],
                )
    else:
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
            "inheritanceChainsChecked": len(source["presentation"].get("inheritanceChains", [])),
            "spacingRecordsChecked": len(source.get("spacing", {}).get("records", [])),
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
