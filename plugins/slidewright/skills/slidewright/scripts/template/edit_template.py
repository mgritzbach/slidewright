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
from xml.etree import ElementTree as ET


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


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def source_identity(xml: str, name: str, part: str) -> dict:
    root = ET.fromstring(xml.encode("utf-8"))
    matches = []

    def visit(node: ET.Element, path: str) -> None:
        for index, child in enumerate(list(node)):
            child_path = f"{path}/{index}"
            if local_name(child.tag) == "sp":
                non_visual = next((item for item in child.iter() if local_name(item.tag) == "cNvPr"), None)
                if non_visual is not None and non_visual.get("name") == name:
                    matches.append((child, non_visual, child_path))
            visit(child, child_path)

    visit(root, "")
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one native p:sp named {name!r}; found {len(matches)}.")
    shape, non_visual, shape_path = matches[0]
    paragraphs = [node for node in shape.iter() if local_name(node.tag) == "p"]
    creation = next(
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
    return {
        "objectKey": f"{part}::{shape_path}::{name}",
        "shapeId": non_visual.get("id", ""),
        "creationId": creation,
        "shapeSha256": sha256(ET.tostring(shape, encoding="utf-8")).hexdigest(),
        "paragraphSha256s": [sha256(ET.tostring(item, encoding="utf-8")).hexdigest() for item in paragraphs],
        "placeholderType": normalized_type,
        "placeholderIndex": placeholder_index,
    }


def validate_source_binding(xml: str, edit: dict, part: str) -> dict:
    required_fields = (
        "sourceObjectKey",
        "sourceObjectSha256",
        "sourceShapeId",
        "sourceCreationId",
        "sourceParagraphSha256s",
    )
    if any(field not in edit for field in required_fields) or not isinstance(edit.get("sourceParagraphSha256s"), list) or not edit["sourceParagraphSha256s"]:
        raise ValueError(f"{edit['shapeName']!r} requires a complete source-bound object identity.")
    identity = source_identity(xml, edit["shapeName"], part)
    comparisons = {
        "sourceObjectKey": identity["objectKey"],
        "sourceObjectSha256": identity["shapeSha256"],
        "sourceShapeId": identity["shapeId"],
        "sourceCreationId": identity["creationId"],
        "sourceParagraphSha256s": identity["paragraphSha256s"],
    }
    for field, actual in comparisons.items():
        if edit[field] != actual:
            raise ValueError(f"{edit['shapeName']!r} {field} mismatch: expected {edit[field]!r}, found {actual!r}.")
    expected_type = edit.get("placeholderType")
    expected_index = edit.get("placeholderIndex")
    if identity["placeholderType"] != expected_type or identity["placeholderIndex"] != expected_index:
        raise ValueError(
            f"{edit['shapeName']!r} placeholder identity mismatch: expected {(expected_type, expected_index)!r}, "
            f"found {(identity['placeholderType'], identity['placeholderIndex'])!r}."
        )
    return identity


def rewrite_shape_text(xml: str, edit: dict, part: str) -> str:
    edit_mode = edit.get("editMode", "replace-existing-text")
    validate_source_binding(xml, edit, part)
    start, end = shape_bounds(xml, edit["shapeName"])
    shape = xml[start:end]
    text_pattern = re.compile(r"(<a:t>)(.*?)(</a:t>)", re.DOTALL)
    current_parts = [html.unescape(match.group(2)) for match in text_pattern.finditer(shape)]
    before_parts = edit["before"].split("\n")
    after_parts = edit["after"].split("\n")
    if edit_mode == "populate-empty-placeholder":
        if edit["before"] != "" or current_parts:
            raise ValueError(f"{edit['shapeName']!r} populate-empty-placeholder requires a source placeholder with no a:t nodes.")
        if len(after_parts) != 1 or not after_parts[0]:
            raise ValueError(f"{edit['shapeName']!r} populate-empty-placeholder requires exactly one non-empty line.")
        paragraphs = list(re.finditer(r"<a:p(?:\s[^>]*)?>.*?</a:p>", shape, re.DOTALL))
        if len(paragraphs) != 1:
            raise ValueError(f"{edit['shapeName']!r} populate-empty-placeholder requires exactly one source paragraph.")
        paragraph = paragraphs[0].group(0)
        run = f"<a:r><a:t>{html.escape(after_parts[0])}</a:t></a:r>"
        insertion = paragraph.find("<a:endParaRPr")
        if insertion < 0:
            insertion = paragraph.rfind("</a:p>")
        if insertion < 0:
            raise ValueError(f"{edit['shapeName']!r} source paragraph has no safe text-run insertion point.")
        rewritten_paragraph = f"{paragraph[:insertion]}{run}{paragraph[insertion:]}"
        rewritten = f"{shape[:paragraphs[0].start()]}{rewritten_paragraph}{shape[paragraphs[0].end():]}"
        return f"{xml[:start]}{rewritten}{xml[end:]}"
    if edit_mode != "replace-existing-text":
        raise ValueError(f"{edit['shapeName']!r} uses unsupported editMode {edit_mode!r}.")
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
    if plan.get("mode") == "preserve-source-deck":
        if plan.get("edits") != [] or plan.get("allowedDeviation") not in (None, []):
            raise ValueError("preserve-source-deck requires zero edits and zero allowed deviations.")
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, out)
        return {
            "source": str(source),
            "sourceSha256": actual_hash,
            "output": str(out),
            "outputSha256": digest(out),
            "editedSlidePart": None,
            "editedShapes": [],
            "otherPartsRebuilt": False,
            "byteExactPreservation": digest(out) == actual_hash,
        }
    if plan.get("mode") != "clone-source-deck":
        raise ValueError("Edit plan mode must be clone-source-deck or preserve-source-deck.")
    with zipfile.ZipFile(source, "r") as archive:
        slide_name = f"ppt/slides/slide{int(plan['targetSlide'])}.xml"
        source_xml = archive.read(slide_name).decode("utf-8")
        edited_xml = source_xml
        for edit in plan["edits"]:
            edited_xml = rewrite_shape_text(edited_xml, edit, slide_name)
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
