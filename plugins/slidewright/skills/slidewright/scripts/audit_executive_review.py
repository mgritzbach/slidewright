#!/usr/bin/env python3
"""Fail-closed OOXML audit for Slidewright E6 executive-review overlays."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
OVERLAY_PATTERN = re.compile(r"^SW-E6-\d{2}-\d{2}$")


def slide_key(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def shape_records(pptx: Path) -> list[dict]:
    records: list[dict] = []
    with zipfile.ZipFile(pptx) as archive:
        slide_names = sorted(
            (name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=slide_key,
        )
        for slide_index, name in enumerate(slide_names, start=1):
            root = ET.fromstring(archive.read(name))
            for shape in root.findall(".//p:sp", NS):
                properties = shape.find("./p:nvSpPr/p:cNvPr", NS)
                if properties is None:
                    continue
                shape_name = properties.get("name", "")
                if not OVERLAY_PATTERN.fullmatch(shape_name):
                    continue
                text = "".join(node.text or "" for node in shape.findall("./p:txBody//a:t", NS))
                fill = shape.find("./p:spPr/a:solidFill/a:srgbClr", NS)
                line = shape.find("./p:spPr/a:ln/a:solidFill/a:srgbClr", NS)
                records.append({
                    "id": shape_name,
                    "slideIndex": slide_index,
                    "text": text,
                    "fill": f"#{fill.get('val')}" if fill is not None else None,
                    "border": f"#{line.get('val')}" if line is not None else None,
                    "nativeText": shape.find("./p:txBody", NS) is not None,
                })
    return records


def audit(pptx: Path, manifest: dict, expect_clean: bool) -> dict:
    failures: list[str] = []
    try:
        records = shape_records(pptx)
    except (OSError, zipfile.BadZipFile, ET.ParseError) as error:
        return {"schemaVersion": "slidewright-executive-review-audit/v1", "valid": False, "failures": [str(error)]}

    if expect_clean:
        if records:
            failures.append("Canonical clean deck contains E6 review-overlay objects.")
        expected: list[dict] = []
    else:
        expected = manifest.get("findings", [])
        expected_ids = [item.get("id") for item in expected]
        actual_ids = [item["id"] for item in records]
        if len(actual_ids) != len(set(actual_ids)):
            failures.append("Review copy contains duplicate E6 object names.")
        if sorted(actual_ids) != sorted(expected_ids):
            failures.append("Review copy E6 object inventory does not match the bound review manifest.")
        by_id = {item["id"]: item for item in records}
        style = manifest.get("style", {})
        for finding in expected:
            record = by_id.get(finding.get("id"))
            if record is None:
                continue
            if record["slideIndex"] != finding.get("slideIndex"):
                failures.append(f"{record['id']} is on the wrong slide.")
            if not record["nativeText"]:
                failures.append(f"{record['id']} is not native editable text.")
            if "PARTNER CHECK" not in record["text"] or finding.get("note", "") not in record["text"]:
                failures.append(f"{record['id']} text does not match the bound review finding.")
            if record["fill"] != style.get("fill"):
                failures.append(f"{record['id']} does not use the bound yellow review fill.")
            if record["border"] != style.get("border"):
                failures.append(f"{record['id']} does not use the bound review border.")

    return {
        "schemaVersion": "slidewright-executive-review-audit/v1",
        "valid": not failures,
        "mode": "clean" if expect_clean else "executive-overlay",
        "expectedOverlayCount": len(expected),
        "actualOverlayCount": len(records),
        "nativeEditableOverlayCount": sum(1 for item in records if item["nativeText"]),
        "failures": failures,
        "overlays": records,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--expect-clean", action="store_true")
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()
    if not args.expect_clean and args.manifest is None:
        parser.error("--manifest is required unless --expect-clean is set")
    manifest = {} if args.expect_clean else json.loads(args.manifest.read_text(encoding="utf-8"))
    report = audit(args.pptx, manifest, args.expect_clean)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
