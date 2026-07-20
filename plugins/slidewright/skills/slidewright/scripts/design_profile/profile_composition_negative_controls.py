#!/usr/bin/env python3
"""Destructive controls for the bounded g22-v2 composition path."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import zipfile
from hashlib import sha256
from pathlib import Path


def stable_hash(value: dict, omitted: str) -> str:
    copy = dict(value)
    copy.pop(omitted, None)
    return sha256(json.dumps(copy, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def rewrite_zip(source: Path, target: Path, mutations: dict[str, object], additions: dict[str, bytes] | None = None) -> None:
    with zipfile.ZipFile(source) as archive:
        entries = [(item, archive.read(item.filename)) for item in archive.infolist()]
    target.parent.mkdir(parents=True, exist_ok=True)
    seen = set()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as outgoing:
        for item, payload in entries:
            mutate = mutations.get(item.filename)
            if mutate:
                updated = mutate(payload)
                if updated == payload:
                    raise RuntimeError(f"Control did not mutate {item.filename}.")
                payload = updated
                seen.add(item.filename)
            outgoing.writestr(item, payload)
        for name, payload in (additions or {}).items():
            outgoing.writestr(name, payload)
    missing = set(mutations) - seen
    if missing:
        raise RuntimeError("Control parts missing: " + ", ".join(sorted(missing)))


def mutate_named_shape(payload: bytes, name: str) -> bytes:
    marker = f'name="{name}"'.encode()
    if payload.count(marker) != 1:
        raise RuntimeError(f"Expected exactly one shape named {name}.")
    position = payload.index(marker)
    start = payload.rfind(b"<p:sp>", 0, position)
    end = payload.index(b"</p:sp>", position) + len(b"</p:sp>")
    shape = payload[start:end]
    shape, count = re.subn(rb'(<a:t>)(.*?)(</a:t>)', rb'\1UNAUTHORIZED SOURCE DRIFT\3', shape, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError("Could not mutate native shape text.")
    return payload[:start] + shape + payload[end:]


def forged_provenance(source: Path, deck: Path, target: Path) -> None:
    value = json.loads(source.read_text(encoding="utf-8-sig"))
    value["outputSha256"] = sha256(deck.read_bytes()).hexdigest()
    value["provenanceSha256"] = stable_hash(value, "provenanceSha256")
    target.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("profile", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("provenance", type=Path)
    parser.add_argument("--asymmetry-manifest", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--json", required=True, type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    audit = Path(__file__).with_name("audit_profile_composition.py")
    compositor = Path(__file__).with_name("compose_profile_deck.py")

    controls: list[dict] = []

    def audit_control(name: str, mutations: dict[str, object], additions: dict[str, bytes] | None = None) -> None:
        deck = args.out_dir / f"{name}.pptx"
        provenance = args.out_dir / f"{name}-provenance.json"
        report = args.out_dir / f"{name}.json"
        rewrite_zip(args.output, deck, mutations, additions)
        forged_provenance(args.provenance, deck, provenance)
        completed = subprocess.run([
            sys.executable, str(audit), str(args.source), str(deck),
            "--profile", str(args.profile), "--plan", str(args.plan), "--provenance", str(provenance),
            "--asymmetry-manifest", str(args.asymmetry_manifest), "--json", str(report),
        ], text=True, capture_output=True, check=False)
        controls.append({"name": name, "rejected": completed.returncode != 0, "exitCode": completed.returncode, "report": report.name})

    audit_control("guide-delete", {"ppt/viewProps.xml": lambda data: re.sub(rb"<[^:>]+:guide\b[^>]*/>", b"", data, count=1)})
    audit_control("master-drift", {"ppt/slideMasters/slideMaster1.xml": lambda data: data.replace(b'name="SW Rail Right"', b'name="SW Rail Right MUTATED"', 1)})
    audit_control("layout-binding-drift", {"ppt/slides/_rels/slide1.xml.rels": lambda data: data.replace(b"slideLayout3.xml", b"slideLayout2.xml", 1)})
    audit_control("undeclared-slide-text", {"ppt/slides/slide1.xml": lambda data: mutate_named_shape(data, "Footer Placeholder 3")})
    audit_control("orphan-source-slide", {}, {"ppt/slides/slide99.xml": b"<orphan/>"})
    audit_control("orphan-media", {}, {"ppt/media/orphan.png": b"not-a-real-image"})

    bad_plan = json.loads(args.plan.read_text(encoding="utf-8-sig"))
    bad_plan["sourceSha256"] = "0" * 64
    bad_plan_path = args.out_dir / "wrong-source-plan.json"
    bad_plan_path.write_text(json.dumps(bad_plan, indent=2) + "\n", encoding="utf-8")
    completed = subprocess.run([
        sys.executable, str(compositor), str(args.source), str(bad_plan_path), str(args.out_dir / "wrong-source.pptx"),
        "--json", str(args.out_dir / "wrong-source-provenance.json"),
    ], text=True, capture_output=True, check=False)
    controls.append({"name": "wrong-source-binding", "rejected": completed.returncode != 0, "exitCode": completed.returncode})

    tampered = json.loads(args.provenance.read_text(encoding="utf-8-sig"))
    tampered["mappings"][0]["sourceSlidePart"] = "ppt/slides/slide999.xml"
    tampered["provenanceSha256"] = stable_hash(tampered, "provenanceSha256")
    tampered_path = args.out_dir / "mapping-drift-provenance.json"
    tampered_path.write_text(json.dumps(tampered, indent=2) + "\n", encoding="utf-8")
    completed = subprocess.run([
        sys.executable, str(audit), str(args.source), str(args.output),
        "--profile", str(args.profile), "--plan", str(args.plan), "--provenance", str(tampered_path),
        "--asymmetry-manifest", str(args.asymmetry_manifest), "--json", str(args.out_dir / "mapping-drift.json"),
    ], text=True, capture_output=True, check=False)
    controls.append({"name": "provenance-mapping-drift", "rejected": completed.returncode != 0, "exitCode": completed.returncode})

    required = {"guide-delete", "master-drift", "layout-binding-drift", "undeclared-slide-text", "orphan-source-slide", "orphan-media", "wrong-source-binding", "provenance-mapping-drift"}
    result = {
        "schemaVersion": "slidewright-profile-composition-negative-controls/v1",
        "valid": {item["name"] for item in controls} == required and all(item["rejected"] for item in controls),
        "controls": controls,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
