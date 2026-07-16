#!/usr/bin/env python3
"""Destructive controls for G22/G23 design-profile gates."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def rewrite_zip(source: Path, target: Path, part: str, mutate) -> None:
    with zipfile.ZipFile(source) as incoming:
        entries = [(item, incoming.read(item.filename)) for item in incoming.infolist()]
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w") as outgoing:
        found = False
        for item, payload in entries:
            if item.filename == part:
                updated = mutate(payload)
                if updated == payload:
                    raise RuntimeError(f"Control did not mutate {part}.")
                payload = updated
                found = True
            outgoing.writestr(item, payload)
    if not found:
        raise RuntimeError(f"Missing package part {part}.")


def mutate_named_shape(payload: bytes, name: str, operation: str) -> bytes:
    marker = f'name="{name}"'.encode()
    if payload.count(marker) != 1:
        raise RuntimeError(f"Expected one shape named {name}.")
    pos = payload.index(marker)
    start = payload.rfind(b"<p:sp>", 0, pos)
    end = payload.index(b"</p:sp>", pos) + len(b"</p:sp>")
    shape = payload[start:end]
    if operation == "width":
        shape, count = re.subn(
            rb'(<a:ext\b[^>]*\bcx=")(\d+)(")',
            lambda match: match.group(1) + str(int(match.group(2)) + 1).encode() + match.group(3),
            shape,
            count=1,
        )
    elif operation == "color":
        shape, count = re.subn(rb'(<a:srgbClr\b[^>]*\bval=")[0-9A-Fa-f]{6}(")', rb'\g<1>FFFFFF\g<2>', shape, count=1)
    elif operation == "rename":
        shape = shape.replace(marker, f'name="{name} MUTATED"'.encode(), 1)
        count = 1
    elif operation == "width-visible":
        shape, offset_count = re.subn(
            rb'(<a:off\b[^>]*\bx=")(\d+)(")',
            lambda match: match.group(1) + str(int(match.group(2)) - 254000).encode() + match.group(3),
            shape,
            count=1,
        )
        shape, extent_count = re.subn(
            rb'(<a:ext\b[^>]*\bcx=")(\d+)(")',
            lambda match: match.group(1) + str(int(match.group(2)) + 254000).encode() + match.group(3),
            shape,
            count=1,
        )
        count = offset_count if offset_count == extent_count == 1 else 0
    else:
        raise RuntimeError(operation)
    if count != 1:
        raise RuntimeError(f"Could not apply {operation} to {name}.")
    return payload[:start] + shape + payload[end:]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("derived", type=Path)
    parser.add_argument("profile", type=Path)
    parser.add_argument("--edit-plan", type=Path, required=True)
    parser.add_argument("--asymmetry-manifest", type=Path, required=True)
    parser.add_argument("--render-tool", type=Path, required=True)
    parser.add_argument("--slides", type=int, default=2)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    audit_script = Path(__file__).with_name("audit_design_profile.py")
    audit_options = [
        "--edit-plan", str(args.edit_plan),
        "--asymmetry-manifest", str(args.asymmetry_manifest),
    ]


    controls = [
        ("guide-delete", "ppt/viewProps.xml", lambda data: re.sub(rb"<p:guide\b[^>]*/>", b"", data, count=1)),
        ("side-rail-plus-one-emu", "ppt/slideMasters/slideMaster1.xml", lambda data: mutate_named_shape(data, "SW Rail Right", "width")),
        ("limiter-color-drift", "ppt/slideLayouts/slideLayout2.xml", lambda data: mutate_named_shape(data, "SW Limiter Right", "color")),
        ("logo-rename", "ppt/slideMasters/slideMaster1.xml", lambda data: data.replace(b'name="SW Logo Group"', b'name="SW Logo Group MUTATED"', 1)),
        ("theme-font-drift", "ppt/theme/theme1.xml", lambda data: data.replace(b'typeface="Arial"', b'typeface="Calibri"', 1)),
        ("target-slide-undeclared-drift", "ppt/slides/slide1.xml", lambda data: mutate_named_shape(data, "Footer Placeholder 3", "rename")),
    ]
    results = []
    for name, part, mutate in controls:
        candidate = args.out_dir / f"{name}.pptx"
        report = args.out_dir / f"{name}.json"
        rewrite_zip(args.derived, candidate, part, mutate)
        completed = subprocess.run(
            [sys.executable, str(audit_script), str(args.source), str(candidate), "--profile", str(args.profile), *audit_options, "--json", str(report)],
            text=True,
            capture_output=True,
            check=False,
        )
        results.append({
            "name": name,
            "rejected": completed.returncode != 0,
            "exitCode": completed.returncode,
            "report": str(report),
            "stderr": completed.stderr.strip(),
        })

    tampered_profile = args.out_dir / "tampered-profile.json"
    value = json.loads(args.profile.read_text(encoding="utf-8"))
    value["profileSha256"] = "0" * 64
    tampered_profile.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    report = args.out_dir / "profile-integrity.json"
    completed = subprocess.run(
        [sys.executable, str(audit_script), str(args.source), str(args.derived), "--profile", str(tampered_profile), *audit_options, "--json", str(report)],
        text=True,
        capture_output=True,
        check=False,
    )
    results.append({
        "name": "profile-integrity",
        "rejected": completed.returncode != 0,
        "exitCode": completed.returncode,
        "report": str(report),
        "stderr": completed.stderr.strip(),
    })

    render_baseline = args.out_dir / "render-baseline.pptx"
    rendered_candidate = args.out_dir / "rendered-rim-geometry-drift.pptx"
    rendered_report = args.out_dir / "rendered-rim-geometry-drift.json"
    shutil.copyfile(args.derived, render_baseline)
    rewrite_zip(
        args.derived,
        rendered_candidate,
        "ppt/slideMasters/slideMaster1.xml",
        lambda data: mutate_named_shape(data, "SW Rail Right", "width-visible"),
    )
    for deck in (render_baseline, rendered_candidate):
        completed = subprocess.run(
            [sys.executable, str(args.render_tool), str(deck)],
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"Could not render {deck}: {completed.stderr.strip()}")

    compare_script = Path(__file__).parents[1] / "template" / "compare_exact_renders.py"
    completed = subprocess.run(
        [
            sys.executable,
            str(compare_script),
            str(render_baseline.with_suffix("")),
            str(rendered_candidate.with_suffix("")),
            "--slides", str(args.slides),
            "--minimum", "1",
            "--json", str(rendered_report),
            "--out-dir", str(args.out_dir / "rendered-rim-geometry-diff"),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    rendered_value = json.loads(rendered_report.read_text(encoding="utf-8"))
    results.append({
        "name": "rendered-rim-geometry-drift",
        "rejected": completed.returncode == 1
        and rendered_value.get("valid") is False
        and any(item.get("similarity", 1) < 1 for item in rendered_value.get("slides", [])),
        "exitCode": completed.returncode,
        "report": str(rendered_report),
        "stderr": completed.stderr.strip(),
    })

    required = {
        "guide-delete",
        "side-rail-plus-one-emu",
        "limiter-color-drift",
        "logo-rename",
        "theme-font-drift",
        "target-slide-undeclared-drift",
        "profile-integrity",
        "rendered-rim-geometry-drift",
    }
    output = {
        "valid": {item["name"] for item in results} == required and all(item["rejected"] for item in results),
        "controls": results,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, indent=2))
    return 0 if output["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
