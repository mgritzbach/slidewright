#!/usr/bin/env python3
"""Independently audit a g22-v2 source-archetype composition."""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import sys
import zipfile
from hashlib import sha256
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

from design_profile_core import canonical_hash, extract_profile, portable_integrity_hash, read_package


PR = "http://schemas.openxmlformats.org/package/2006/relationships"


class AuditError(ValueError):
    pass


def file_hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def stable_hash(value: Any, omitted: str | None = None) -> str:
    copy = dict(value) if isinstance(value, dict) else value
    if omitted and isinstance(copy, dict):
        copy.pop(omitted, None)
    return sha256(json.dumps(copy, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def rels_part(part: str) -> str:
    if not part:
        return "_rels/.rels"
    directory, name = posixpath.split(part)
    return posixpath.join(directory, "_rels", name + ".rels")


def relationship_targets(payload: bytes, owner: str) -> list[str]:
    root = ET.fromstring(payload)
    targets = []
    for node in root.findall(f"{{{PR}}}Relationship"):
        if node.get("TargetMode") == "External":
            continue
        target = posixpath.normpath(posixpath.join(posixpath.dirname(owner), node.get("Target", ""))).lstrip("/")
        targets.append(target)
    return targets


def independent_reachable(parts: dict[str, bytes]) -> set[str]:
    required = {"[Content_Types].xml", "_rels/.rels"}
    if not required <= set(parts):
        raise AuditError("Output lacks package roots.")
    reached = set(required)
    queue = relationship_targets(parts["_rels/.rels"], "")
    while queue:
        part = queue.pop(0)
        if part in reached:
            continue
        if part not in parts:
            raise AuditError(f"Output relationship target is missing: {part}")
        reached.add(part)
        relationship_part = rels_part(part)
        if relationship_part in parts:
            reached.add(relationship_part)
            queue.extend(target for target in relationship_targets(parts[relationship_part], part) if target not in reached)
    return reached


def object_projection(item: dict[str, Any], *, include_text: bool) -> dict[str, Any]:
    excluded = {"objectKey", "part", "xmlSha256", "creationId"}
    if not include_text:
        excluded |= {"text", "styleFingerprint"}
    return {key: value for key, value in item.items() if key not in excluded}


def objects_by_part_and_name(profile: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    result = {}
    for item in profile.get("objects", []):
        key = (item.get("part", ""), item.get("name", ""))
        if key in result:
            raise AuditError(f"Profile object name is ambiguous within a part: {key}")
        result[key] = item
    return result


def audit(source_path: Path, output_path: Path, profile_path: Path, plan_path: Path, provenance_path: Path, asymmetry_manifest: Path | None) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []

    def check(condition: bool, field: str, expected: Any, actual: Any) -> None:
        if not condition:
            failures.append({"field": field, "expected": expected, "actual": actual})

    stored_profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
    plan_bytes = plan_path.read_bytes()
    plan = json.loads(plan_bytes.decode("utf-8-sig"))
    provenance = json.loads(provenance_path.read_text(encoding="utf-8-sig"))
    source_hash = file_hash(source_path)
    output_hash = file_hash(output_path)
    check(plan.get("derivationVersion") == "g22-v2" and plan.get("mode") == "compose-source-archetypes", "plan-mode", "g22-v2/compose-source-archetypes", [plan.get("derivationVersion"), plan.get("mode")])
    check(plan.get("sourceSha256") == source_hash, "plan-source", source_hash, plan.get("sourceSha256"))
    check(plan.get("sourceRights", {}).get("basis") in {"licensed", "user-provided-authorized"}, "source-rights", "explicit accepted basis", plan.get("sourceRights"))
    check(plan.get("outputSlideCount") == len(plan.get("slides", [])) and len(plan.get("slides", [])) >= 2, "plan-slide-count", len(plan.get("slides", [])), plan.get("outputSlideCount"))
    check(plan.get("outputSlideCount") != plan.get("sourceSlideCount"), "new-deck-slide-inventory", "output count distinct from source count", [plan.get("sourceSlideCount"), plan.get("outputSlideCount")])

    portable = stored_profile.get("portableIntegritySha256", "")
    portable_basis = dict(stored_profile)
    portable_basis.pop("portableIntegritySha256", None)
    check(portable == portable_integrity_hash(portable_basis), "profile-portable-integrity", portable, portable_integrity_hash(portable_basis))
    profile_digest = portable_basis.get("profileSha256", "")
    profile_basis = dict(portable_basis)
    profile_basis.pop("profileSha256", None)
    check(profile_digest == canonical_hash(profile_basis), "profile-integrity", profile_digest, canonical_hash(profile_basis))
    check(stored_profile.get("source", {}).get("sha256") == source_hash, "profile-source", source_hash, stored_profile.get("source", {}).get("sha256"))

    check(provenance.get("schemaVersion") == "slidewright-profile-composition-provenance/v1" and provenance.get("valid") is True, "provenance-schema", "valid v1", [provenance.get("schemaVersion"), provenance.get("valid")])
    check(provenance.get("sourceSha256") == source_hash, "provenance-source", source_hash, provenance.get("sourceSha256"))
    check(provenance.get("planSha256") == sha256(plan_bytes).hexdigest(), "provenance-plan", sha256(plan_bytes).hexdigest(), provenance.get("planSha256"))
    check(provenance.get("outputSha256") == output_hash, "provenance-output", output_hash, provenance.get("outputSha256"))
    check(provenance.get("provenanceSha256") == stable_hash(provenance, "provenanceSha256"), "provenance-integrity", stable_hash(provenance, "provenanceSha256"), provenance.get("provenanceSha256"))
    check(provenance.get("sourceRights") == plan.get("sourceRights"), "provenance-rights", plan.get("sourceRights"), provenance.get("sourceRights"))

    source_parts, _source_relationships = read_package(source_path)
    output_parts, _output_relationships = read_package(output_path)
    reachable = independent_reachable(output_parts)
    check(reachable == set(output_parts), "reachable-package-closure", sorted(reachable), sorted(output_parts))
    check(provenance.get("reachableClosureExact") is True, "provenance-reachability", True, provenance.get("reachableClosureExact"))
    allowed_changed = {"[Content_Types].xml", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "docProps/app.xml"}
    for part, payload in output_parts.items():
        if part in allowed_changed or re.fullmatch(r"ppt/slides/(?:_rels/)?slide\d+\.xml(?:\.rels)?", part):
            continue
        check(part in source_parts, f"source-part-present:{part}", True, part in source_parts)
        if part in source_parts:
            check(payload == source_parts[part], f"source-part-exact:{part}", sha256(source_parts[part]).hexdigest(), sha256(payload).hexdigest())

    source_profile = extract_profile(source_path, asymmetry_manifest, enforce_symmetry=True)
    # Source-declared asymmetry is bound to the source hash. The output is
    # independently extracted without importing that declaration, then its
    # exact protected parts and symmetry geometry are compared below.
    output_profile = extract_profile(output_path, None, enforce_symmetry=False)
    check(source_profile["presentation"]["slideSize"] == output_profile["presentation"]["slideSize"], "slide-size", source_profile["presentation"]["slideSize"], output_profile["presentation"]["slideSize"])
    check(source_profile["presentation"]["guides"] == output_profile["presentation"]["guides"], "guides", source_profile["presentation"]["guides"], output_profile["presentation"]["guides"])
    for field in ("themes", "masters", "layouts"):
        check(source_profile[field] == output_profile[field], field, source_profile[field], output_profile[field])
    check(source_profile["assets"]["logos"] == output_profile["assets"]["logos"], "logos", source_profile["assets"]["logos"], output_profile["assets"]["logos"])
    source_chrome = [item for item in source_profile["chrome"]["objects"] if not item["part"].startswith("ppt/slides/")]
    output_chrome = [item for item in output_profile["chrome"]["objects"] if not item["part"].startswith("ppt/slides/")]
    check(source_chrome == output_chrome, "master-layout-chrome", source_chrome, output_chrome)
    check(len(output_profile["slides"]) == len(plan.get("slides", [])), "output-slide-count", len(plan.get("slides", [])), len(output_profile["slides"]))

    source_chains = {item["slidePart"]: item for item in source_profile["presentation"].get("inheritanceChains", [])}
    output_chains = {item["slidePart"]: item for item in output_profile["presentation"].get("inheritanceChains", [])}
    source_objects = objects_by_part_and_name(source_profile)
    output_objects = objects_by_part_and_name(output_profile)
    mappings = provenance.get("mappings", [])
    check(len(mappings) == len(plan.get("slides", [])), "provenance-mapping-count", len(plan.get("slides", [])), len(mappings))
    native_edits = 0
    object_bindings = 0
    for index, planned in enumerate(plan.get("slides", []), 1):
        destination = f"ppt/slides/slide{index}.xml"
        source_part = planned.get("sourceSlidePart")
        source_chain = source_chains.get(source_part)
        output_chain = output_chains.get(destination)
        check(source_chain is not None and output_chain is not None, f"slide-{index}-chain-present", True, [source_chain, output_chain])
        if source_chain and output_chain:
            check({key: source_chain.get(key) for key in ("layoutPart", "masterPart", "themePart")} == {key: output_chain.get(key) for key in ("layoutPart", "masterPart", "themePart")}, f"slide-{index}-inheritance", source_chain, output_chain)
        mapping = mappings[index - 1] if index - 1 < len(mappings) else {}
        check(mapping.get("outputSlide") == index and mapping.get("outputSlidePart") == destination and mapping.get("sourceSlidePart") == source_part and mapping.get("archetypeId") == planned.get("archetypeId"), f"slide-{index}-provenance-binding", [index, destination, source_part, planned.get("archetypeId")], mapping)
        edited_names = {edit["shapeName"] for edit in planned.get("edits", [])}
        for edit in planned.get("edits", []):
            expected = source_objects.get((source_part, edit["shapeName"]))
            actual = output_objects.get((destination, edit["shapeName"]))
            check(expected is not None and actual is not None, f"slide-{index}-editable-shape:{edit['shapeName']}", True, [expected is not None, actual is not None])
            if expected and actual:
                check(actual.get("type") == "sp" and actual.get("text", {}).get("plainText") == edit.get("after"), f"slide-{index}-native-text:{edit['shapeName']}", ["sp", edit.get("after")], [actual.get("type"), actual.get("text", {}).get("plainText")])
                check(object_projection(expected, include_text=False) == object_projection(actual, include_text=False), f"slide-{index}-editable-structure:{edit['shapeName']}", object_projection(expected, include_text=False), object_projection(actual, include_text=False))
                native_edits += 1
        source_slide_objects = {name: item for (part, name), item in source_objects.items() if part == source_part}
        output_slide_objects = {name: item for (part, name), item in output_objects.items() if part == destination}
        check(set(source_slide_objects) == set(output_slide_objects), f"slide-{index}-object-inventory", sorted(source_slide_objects), sorted(output_slide_objects))
        for name, expected in source_slide_objects.items():
            actual = output_slide_objects.get(name)
            if not actual:
                continue
            include_text = name not in edited_names and actual.get("placeholder", {}).get("type") != "slide-number"
            check(object_projection(expected, include_text=include_text) == object_projection(actual, include_text=include_text), f"slide-{index}-object:{name}", object_projection(expected, include_text=include_text), object_projection(actual, include_text=include_text))
            object_bindings += 1

    check(provenance.get("outputPartCount") == len(output_parts), "provenance-part-count", len(output_parts), provenance.get("outputPartCount"))
    check(provenance.get("outputSlideCount") == len(plan.get("slides", [])), "provenance-slide-count", len(plan.get("slides", [])), provenance.get("outputSlideCount"))
    report = {
        "schemaVersion": "slidewright-profile-composition-audit/v1",
        "valid": not failures,
        "sourceSha256": source_hash,
        "profileSha256": stored_profile.get("profileSha256"),
        "planSha256": sha256(plan_bytes).hexdigest(),
        "outputSha256": output_hash,
        "summary": {
            "sourceSlides": len(source_profile["slides"]),
            "outputSlides": len(output_profile["slides"]),
            "outputParts": len(output_parts),
            "reachableParts": len(reachable),
            "guides": len(output_profile["presentation"]["guides"]),
            "masters": len(output_profile["masters"]),
            "layouts": len(output_profile["layouts"]),
            "themes": len(output_profile["themes"]),
            "logos": len(output_profile["assets"]["logos"]),
            "masterLayoutChrome": len(output_chrome),
            "nativePlaceholderEdits": native_edits,
            "sourceObjectBindings": object_bindings,
        },
        "failures": failures,
    }
    report["reportSha256"] = stable_hash(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit a source-native g22-v2 composition.")
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--provenance", required=True, type=Path)
    parser.add_argument("--asymmetry-manifest", type=Path)
    parser.add_argument("--json", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = audit(args.source.resolve(), args.output.resolve(), args.profile.resolve(), args.plan.resolve(), args.provenance.resolve(), args.asymmetry_manifest.resolve() if args.asymmetry_manifest else None)
    except (OSError, json.JSONDecodeError, zipfile.BadZipFile, ET.ParseError, AuditError, ValueError) as error:
        print(f"profile composition audit failed: {error}", file=sys.stderr)
        return 2
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
