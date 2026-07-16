#!/usr/bin/env python3
"""Audit source-bound inherited-bullet cleanup and reject collateral PPTX changes."""

from __future__ import annotations

import argparse
import json
import zipfile
from hashlib import sha256
from pathlib import Path

from lxml import etree as ET

from inherited_bullet_hygiene import canonical, digest, inspect_placeholder, paragraph_text


def audit(source: Path, edited: Path, plan_path: Path) -> dict:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    checks: list[dict] = []

    def check(name: str, passed: bool, expected, actual) -> None:
        checks.append({"name": name, "passed": bool(passed), "expected": expected, "actual": actual})

    check("source-sha256", digest(source) == plan["sourceSha256"], plan["sourceSha256"], digest(source))
    with zipfile.ZipFile(source, "r") as source_archive, zipfile.ZipFile(edited, "r") as edited_archive:
        source_names = source_archive.namelist()
        edited_names = edited_archive.namelist()
        check("package-part-inventory", source_names == edited_names, source_names, edited_names)
        source_state = inspect_placeholder(source_archive, plan)
        edited_state = inspect_placeholder(edited_archive, plan)
        target = source_state["slidePart"]
        changed_parts = [
            name for name in source_names
            if name in edited_names and source_archive.read(name) != edited_archive.read(name)
        ]
        check("only-target-slide-part-changed", changed_parts == [target], [target], changed_parts)
        relationship_parts = [name for name in source_names if name.endswith(".rels")]
        relationship_drift = [name for name in relationship_parts if source_archive.read(name) != edited_archive.read(name)]
        check("relationship-parts-byte-identical", not relationship_drift, [], relationship_drift)
        protected = [
            name for name in source_names
            if name.startswith(("ppt/slideMasters/", "ppt/slideLayouts/", "ppt/theme/"))
        ]
        protected_drift = [name for name in protected if source_archive.read(name) != edited_archive.read(name)]
        check("masters-layouts-themes-byte-identical", not protected_drift, [], protected_drift)
        source_nonempty = [record for record in source_state["records"] if not record["empty"]]
        edited_nonempty = [record for record in edited_state["records"] if not record["empty"]]
        source_empty_inherited = [
            record for record in source_state["records"]
            if record["empty"] and record["bulletActive"] and record["bulletSource"] == plan["expectedBulletSource"]
        ]
        edited_empty = [record for record in edited_state["records"] if record["empty"]]
        check(
            "source-positive-inherited-bullet-fixture",
            len(source_empty_inherited) == int(plan["expectedRemovedParagraphs"]),
            int(plan["expectedRemovedParagraphs"]),
            len(source_empty_inherited),
        )
        check("all-empty-paragraphs-removed", not edited_empty, [], edited_empty)
        check(
            "nonempty-paragraph-canonical-hashes-preserved",
            [record["sha256"] for record in source_nonempty] == [record["sha256"] for record in edited_nonempty],
            [record["sha256"] for record in source_nonempty],
            [record["sha256"] for record in edited_nonempty],
        )
        edited_text = [paragraph_text(paragraph) for paragraph in edited_state["paragraphs"]]
        check("expected-visible-text", edited_text == plan["expectedRemainingText"], plan["expectedRemainingText"], edited_text)
        inheritance = [(record["bulletActive"], record["bulletSource"]) for record in edited_state["records"]]
        expected_inheritance = [(True, plan["expectedBulletSource"])] * len(plan["expectedRemainingText"])
        check("remaining-bullets-still-inherited", inheritance == expected_inheritance, expected_inheritance, inheritance)

        normalized_source_root = source_state["slideRoot"]
        source_text_body = source_state["slideShape"].find("./p:txBody", {"p": "http://schemas.openxmlformats.org/presentationml/2006/main"})
        for paragraph, record in zip(source_state["paragraphs"], source_state["records"], strict=True):
            if record["empty"]:
                source_text_body.remove(paragraph)
        check(
            "target-slide-canonical-diff-is-only-empty-removal",
            canonical(normalized_source_root) == canonical(edited_state["slideRoot"]),
            sha256(canonical(normalized_source_root)).hexdigest(),
            sha256(canonical(edited_state["slideRoot"])).hexdigest(),
        )
        preserve_part = "ppt/slides/slide2.xml"
        check(
            "preserve-only-slide-byte-identical",
            source_archive.read(preserve_part) == edited_archive.read(preserve_part),
            sha256(source_archive.read(preserve_part)).hexdigest(),
            sha256(edited_archive.read(preserve_part)).hexdigest(),
        )

    valid = all(item["passed"] for item in checks)
    return {
        "valid": valid,
        "source": str(source),
        "sourceSha256": digest(source),
        "edited": str(edited),
        "editedSha256": digest(edited),
        "checks": checks,
        "summary": {
            "checks": len(checks),
            "passed": sum(item["passed"] for item in checks),
            "failed": sum(not item["passed"] for item in checks),
            "removedInheritedEmptyParagraphs": int(plan["expectedRemovedParagraphs"]),
            "preservedNativeParagraphs": len(plan["expectedRemainingText"]),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("edited")
    parser.add_argument("plan")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    result = audit(Path(args.source), Path(args.edited), Path(args.plan))
    report = Path(args.json)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
