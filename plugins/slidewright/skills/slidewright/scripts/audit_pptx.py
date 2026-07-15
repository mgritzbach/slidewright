#!/usr/bin/env python3
"""Audit exported PowerPoint OOXML for Slidewright's formatting contract."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
APPROVED_PT = {54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12}


def slide_sort_key(name: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", name)
    return int(match.group(1)) if match else 0


def audit(pptx_path: Path) -> dict:
    slides: list[dict] = []
    all_sizes: list[float] = []
    native_text_nodes = 0
    picture_count = 0
    bold_runs = 0
    regular_runs = 0
    mixed_emphasis_paragraphs = 0

    with zipfile.ZipFile(pptx_path) as archive:
        names = sorted(
            (name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=slide_sort_key,
        )
        for name in names:
            root = ET.fromstring(archive.read(name))
            text_nodes = root.findall(".//a:t", NS)
            pictures = root.findall(".//p:pic", NS)
            native_text_nodes += len(text_nodes)
            picture_count += len(pictures)
            slide_sizes: list[float] = []

            for element in root.iter():
                if element.tag.rsplit("}", 1)[-1] in {"rPr", "defRPr", "endParaRPr"}:
                    raw = element.attrib.get("sz")
                    if raw and raw.isdigit():
                        point_size = int(raw) / 100
                        all_sizes.append(point_size)
                        slide_sizes.append(point_size)

            for paragraph in root.findall(".//a:p", NS):
                states: set[bool] = set()
                for run in paragraph.findall("a:r", NS):
                    props = run.find("a:rPr", NS)
                    is_bold = props is not None and props.attrib.get("b") in {"1", "true"}
                    states.add(is_bold)
                    if is_bold:
                        bold_runs += 1
                    else:
                        regular_runs += 1
                if states == {True, False}:
                    mixed_emphasis_paragraphs += 1

            slides.append(
                {
                    "slide": slide_sort_key(name),
                    "nativeTextNodes": len(text_nodes),
                    "pictures": len(pictures),
                    "fontSizesPt": sorted(set(slide_sizes), reverse=True),
                }
            )

    fractional = sorted({size for size in all_sizes if not float(size).is_integer()})
    outside_scale = sorted({size for size in all_sizes if size not in APPROVED_PT})
    checks = {
        "hasNativeEditableText": native_text_nodes > 0,
        "hasNoFractionalFontSizes": not fractional,
        "usesApprovedFontScale": not outside_scale,
        "preservesBoldAndRegularRuns": bold_runs > 0 and regular_runs > 0 and mixed_emphasis_paragraphs > 0,
    }
    return {
        "valid": all(checks.values()),
        "checks": checks,
        "summary": {
            "slides": len(slides),
            "nativeTextNodes": native_text_nodes,
            "pictures": picture_count,
            "boldRuns": bold_runs,
            "regularRuns": regular_runs,
            "mixedEmphasisParagraphs": mixed_emphasis_paragraphs,
            "fractionalFontSizesPt": fractional,
            "outsideApprovedScalePt": outside_scale,
        },
        "slides": slides,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx", type=Path)
    parser.add_argument("--json", dest="json_path", type=Path)
    args = parser.parse_args()

    if not args.pptx.exists():
        parser.error(f"PPTX not found: {args.pptx}")
    report = audit(args.pptx)
    payload = json.dumps(report, indent=2) + "\n"
    if args.json_path:
        args.json_path.parent.mkdir(parents=True, exist_ok=True)
        args.json_path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)
    return 0 if report["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
