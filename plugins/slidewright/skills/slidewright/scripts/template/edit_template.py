#!/usr/bin/env python3
"""Surgically rewrite named native placeholder text without rebuilding a PPTX."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import tempfile
import zipfile
from hashlib import sha256
from pathlib import Path


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def shape_bounds(xml: str, name: str) -> tuple[int, int]:
    marker = f'name="{html.escape(name, quote=True)}"'
    if xml.count(marker) != 1:
        raise ValueError(f"Expected exactly one shape named {name!r}; found {xml.count(marker)}.")
    marker_pos = xml.index(marker)
    start = xml.rfind("<p:sp>", 0, marker_pos)
    end = xml.index("</p:sp>", marker_pos) + len("</p:sp>")
    if start < 0:
        raise ValueError(f"Could not locate p:sp boundary for {name!r}.")
    return start, end


def rewrite_shape_text(xml: str, edit: dict) -> str:
    start, end = shape_bounds(xml, edit["shapeName"])
    shape = xml[start:end]
    expected_type = edit["placeholderType"]
    expected_index = int(edit["placeholderIndex"])
    if expected_type == "title" and not re.search(r"<p:ph\b[^>]*\btype=\"title\"", shape):
        raise ValueError(f"{edit['shapeName']!r} is not the expected title placeholder.")
    if expected_type == "body" and not re.search(rf"<p:ph\b[^>]*\bidx=\"{expected_index}\"", shape):
        raise ValueError(f"{edit['shapeName']!r} is not the expected body placeholder index {expected_index}.")
    text_pattern = re.compile(r"(<a:t>)(.*?)(</a:t>)", re.DOTALL)
    current_parts = [html.unescape(match.group(2)) for match in text_pattern.finditer(shape)]
    before_parts = edit["before"].split("\n")
    after_parts = edit["after"].split("\n")
    if current_parts != before_parts:
        raise ValueError(f"{edit['shapeName']!r} source text mismatch: expected {before_parts!r}, found {current_parts!r}.")
    if len(after_parts) != len(current_parts):
        raise ValueError(f"{edit['shapeName']!r} must preserve the existing paragraph/run count.")
    iterator = iter(after_parts)
    rewritten = text_pattern.sub(lambda match: f"{match.group(1)}{html.escape(next(iterator))}{match.group(3)}", shape)
    return f"{xml[:start]}{rewritten}{xml[end:]}"


def edit_template(source: Path, plan_path: Path, out: Path) -> dict:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    expected_hash = plan.get("sourceSha256")
    actual_hash = digest(source)
    if expected_hash and expected_hash != actual_hash:
        raise ValueError(f"Source SHA-256 mismatch: expected {expected_hash}, found {actual_hash}.")
    with zipfile.ZipFile(source, "r") as archive:
        slide_name = f"ppt/slides/slide{int(plan['targetSlide'])}.xml"
        source_xml = archive.read(slide_name).decode("utf-8")
        edited_xml = source_xml
        for edit in plan["edits"]:
            edited_xml = rewrite_shape_text(edited_xml, edit)
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False, dir=out.parent) as handle:
            temporary = Path(handle.name)
        try:
            with zipfile.ZipFile(temporary, "w") as outgoing:
                for item in archive.infolist():
                    payload = edited_xml.encode("utf-8") if item.filename == slide_name else archive.read(item.filename)
                    outgoing.writestr(item, payload)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(temporary, out)
        finally:
            temporary.unlink(missing_ok=True)
    return {
        "source": str(source),
        "sourceSha256": actual_hash,
        "output": str(out),
        "outputSha256": digest(out),
        "editedSlidePart": slide_name,
        "editedShapes": [edit["shapeName"] for edit in plan["edits"]],
        "otherPartsRebuilt": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("plan")
    parser.add_argument("out")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    report = edit_template(Path(args.source), Path(args.plan), Path(args.out))
    Path(args.json).parent.mkdir(parents=True, exist_ok=True)
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
