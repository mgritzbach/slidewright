#!/usr/bin/env python3
"""Destructive controls proving the PowerPoint semantic auditor fails closed."""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Callable

from audit_powerpoint_roundtrip_semantics import audit


def rewrite_deck(source: Path, target: Path, mutate: Callable[[str, bytes], tuple[bytes, bool]]) -> str | None:
    changed: list[str] = []
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as incoming, zipfile.ZipFile(target, "w") as outgoing:
        for item in incoming.infolist():
            payload = incoming.read(item.filename)
            replacement, did_change = mutate(item.filename, payload)
            if did_change:
                changed.append(item.filename)
            outgoing.writestr(item, replacement)
    if len(changed) > 1:
        raise ValueError(f"Control unexpectedly changed multiple parts: {changed}")
    return changed[0] if changed else None


def once_part(predicate: Callable[[str], bool], change: Callable[[bytes], bytes]) -> Callable[[str, bytes], tuple[bytes, bool]]:
    used = False

    def mutate(name: str, payload: bytes) -> tuple[bytes, bool]:
        nonlocal used
        if used or not predicate(name):
            return payload, False
        replacement = change(payload)
        if replacement == payload:
            return payload, False
        used = True
        return replacement, True

    return mutate


def replace_first(pattern: bytes, replacement: bytes, payload: bytes) -> bytes:
    return re.sub(pattern, replacement, payload, count=1, flags=re.DOTALL)


def chart_value(payload: bytes) -> bytes:
    return replace_first(rb"<c:v>([^<]*)</c:v>", rb"<c:v>999999999</c:v>", payload)


def flip_byte(payload: bytes) -> bytes:
    if not payload:
        return payload
    return payload[:-1] + bytes([payload[-1] ^ 1])


def table_text(payload: bytes) -> bytes:
    match = re.search(rb"<a:tbl\b.*?</a:tbl>", payload, flags=re.DOTALL)
    if not match:
        return payload
    table = replace_first(rb"<a:t>([^<]*)</a:t>", rb"<a:t>SLIDEWRIGHT CORRUPTED CELL</a:t>", match.group(0))
    return payload[:match.start()] + table + payload[match.end():]


def external_target(payload: bytes) -> bytes:
    pattern = rb'(<Relationship\b[^>]*\bTarget=")([^"]+)("[^>]*\bTargetMode="External"[^>]*/>)'
    return re.sub(pattern, rb"\1\2#slidewright-corrupt\3", payload, count=1, flags=re.DOTALL)


def native_uri(payload: bytes) -> bytes:
    pattern = rb'(<a:graphicData\b[^>]*\buri=")([^" ]+(?:chart|table)[^" ]*)(")'
    return re.sub(pattern, rb"\1urn:slidewright:corrupted-native-object\3", payload, count=1, flags=re.IGNORECASE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path, help="Edited package before PowerPoint")
    parser.add_argument("roundtrip", type=Path, help="Unmodified PowerPoint round trip")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()

    baseline = audit(args.source, args.roundtrip)
    if not baseline["valid"]:
        raise ValueError("Semantic controls require a valid unmodified PowerPoint round trip.")

    definitions = [
        ("chart-semantic-drift", once_part(lambda name: name.startswith("ppt/charts/chart") and name.endswith(".xml"), chart_value), "parts.ppt/charts/"),
        ("embedded-workbook-drift", once_part(lambda name: name.startswith("ppt/embeddings/"), flip_byte), "parts.ppt/embeddings/"),
        ("table-cell-drift", once_part(lambda name: name.startswith("ppt/slides/slide") and name.endswith(".xml"), table_text), "parts.ppt/slides/"),
        ("hyperlink-target-drift", once_part(lambda name: name.endswith(".rels"), external_target), "package.relationshipTuples"),
        ("media-byte-drift", once_part(lambda name: name.startswith("ppt/media/"), flip_byte), "parts.ppt/media/"),
        ("native-object-editability-drift", once_part(lambda name: name.startswith("ppt/slides/slide") and name.endswith(".xml"), native_uri), "parts.ppt/slides/"),
    ]
    controls = []
    for name, mutate, intended_prefix in definitions:
        deck = args.out_dir / f"{name}.pptx"
        changed_part = rewrite_deck(args.roundtrip, deck, mutate)
        if changed_part is None:
            deck.unlink(missing_ok=True)
            controls.append({"name": name, "applicable": False, "rejected": False, "intendedFailureFound": False})
            continue
        result = audit(args.source, deck)
        fields = [item.get("field", "") for item in result.get("failures", [])]
        intended = any(field == intended_prefix or field.startswith(intended_prefix) for field in fields)
        controls.append({
            "name": name,
            "applicable": True,
            "rejected": result.get("valid") is False,
            "intendedFailureFound": intended,
            "changedPart": changed_part,
            "failureFields": fields,
        })

    report = {
        "schemaVersion": "slidewright-powerpoint-roundtrip-semantic-controls/v1",
        "valid": all(not item["applicable"] or (item["rejected"] and item["intendedFailureFound"]) for item in controls),
        "baselineSemanticAuditSha256": baseline["semanticAuditSha256"],
        "controls": controls,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"PowerPoint semantic controls failed: {error}", file=sys.stderr)
        raise SystemExit(1)
