#!/usr/bin/env python3
"""Prove the template-preservation guards reject representative corruption."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def rewrite_part(source: Path, destination: Path, part: str, transform) -> None:
    with zipfile.ZipFile(source) as archive:
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]
    with zipfile.ZipFile(destination, "w") as archive:
        for info, payload in entries:
            if info.filename == part:
                transformed = transform(payload)
                if transformed == payload:
                    raise RuntimeError(f"Negative-control transform did not change {part}.")
                payload = transformed
            archive.writestr(info, payload)


def expect_failure(name: str, command: list[str]) -> dict:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode == 0:
        raise RuntimeError(f"Negative control {name!r} unexpectedly passed.\n{result.stdout}\n{result.stderr}")
    return {"name": name, "rejected": True, "exitCode": result.returncode}


def audit_command(audit: Path, source: Path, candidate: Path, plan: Path, folder: Path, name: str) -> list[str]:
    return [
        sys.executable,
        str(audit),
        str(source),
        str(candidate),
        str(plan),
        "--json",
        str(folder / f"{name}.json"),
        "--source-manifest",
        str(folder / f"{name}-source.json"),
        "--edited-manifest",
        str(folder / f"{name}-edited.json"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("edited", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()
    script_dir = Path(__file__).resolve().parent
    audit = script_dir / "audit_template_preservation.py"
    editor = script_dir / "edit_template.py"
    results = []

    with tempfile.TemporaryDirectory(prefix="slidewright-template-negative-") as temporary:
        folder = Path(temporary)

        theme = folder / "theme-mutated.pptx"
        rewrite_part(
            args.edited,
            theme,
            "ppt/theme/theme1.xml",
            lambda value: value + b"\n",
        )
        results.append(expect_failure("protected-theme-mutation", audit_command(audit, args.source, theme, args.plan, folder, "theme")))

        control = folder / "control-slide-mutated.pptx"
        rewrite_part(
            args.edited,
            control,
            "ppt/slides/slide2.xml",
            lambda value: value.replace(b"must remain unchanged", b"was silently changed", 1),
        )
        results.append(expect_failure("preserve-only-slide-mutation", audit_command(audit, args.source, control, args.plan, folder, "control")))

        same_slide = folder / "same-slide-nontarget-mutated.pptx"
        rewrite_part(
            args.edited,
            same_slide,
            "ppt/slides/slide1.xml",
            lambda value: value.replace(b'Footer Placeholder 3', b'Footer Placeholder X', 1),
        )
        results.append(expect_failure("same-slide-nontarget-mutation", audit_command(audit, args.source, same_slide, args.plan, folder, "same-slide")))

        extra = folder / "extra-part.pptx"
        shutil.copy2(args.edited, extra)
        with zipfile.ZipFile(extra, "a") as archive:
            archive.writestr("ppt/slidewright-unexpected.txt", "unexpected")
        results.append(expect_failure("unexpected-package-part", audit_command(audit, args.source, extra, args.plan, folder, "extra")))

        bad_plan = folder / "wrong-before.json"
        plan_data = json.loads(args.plan.read_text(encoding="utf-8"))
        plan_data["edits"][0]["before"] = "Text that is not present"
        bad_plan.write_text(json.dumps(plan_data, indent=2) + "\n", encoding="utf-8")
        results.append(
            expect_failure(
                "stale-before-text-contract",
                [sys.executable, str(editor), str(args.source), str(bad_plan), str(folder / "bad-edit.pptx"), "--json", str(folder / "bad-edit.json")],
            )
        )

    report = {"valid": all(item["rejected"] for item in results), "controls": results}
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
