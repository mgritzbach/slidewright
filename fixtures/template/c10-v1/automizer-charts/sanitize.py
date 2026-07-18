#!/usr/bin/env python3
"""Create the deterministic, overlap-free C10 native-chart fixture.

The pinned upstream deck contains a manual chart-legend rectangle that collides
with the category axis in PowerPoint. This curator removes that manual legend
layout and pins both chart-language records to the evidence environment's
English locale. PowerPoint can then round-trip the chart without hidden locale
drift while retaining its workbook, series, axes, theme, and slide geometry.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import zipfile
from pathlib import Path


EXPECTED_UPSTREAM_SHA256 = "cb2773c55cda589145f971a754fd2e0dc5412b83e3bbf87646b3d85602306ef6"
EXPECTED_CURATED_SHA256 = "7b4d6833c93229377c160359f6764811a29728c57446ea39b7734eca5189101c"
CHART_PARTS = {"ppt/charts/chart1.xml", "ppt/charts/chart2.xml"}
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
MANUAL_LEGEND_LAYOUT = re.compile(
    rb"(<c:legend><c:legendPos\b[^>]*/>)<c:layout><c:manualLayout>.*?</c:manualLayout></c:layout>",
    re.DOTALL,
)


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("upstream", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    upstream = args.upstream.read_bytes()
    upstream_hash = digest(upstream)
    if upstream_hash != EXPECTED_UPSTREAM_SHA256:
        raise RuntimeError(f"Unexpected upstream SHA-256: {upstream_hash}")

    with zipfile.ZipFile(args.upstream) as incoming:
        entries = [(item, incoming.read(item.filename)) for item in incoming.infolist()]
    if {item.filename for item, _ in entries if item.filename in CHART_PARTS} != CHART_PARTS:
        raise RuntimeError(f"Expected exactly the chart parts {sorted(CHART_PARTS)}.")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    changed_parts: list[str] = []
    with zipfile.ZipFile(args.output, "w") as outgoing:
        for item, payload in entries:
            if item.filename in CHART_PARTS:
                payload, language_count = re.subn(rb'<c:lang val="de-DE"/>', rb'<c:lang val="en-US"/>', payload, count=1)
                if language_count != 1:
                    raise RuntimeError(f"Expected exactly one German chart-language record in {item.filename}.")
                if item.filename == "ppt/charts/chart1.xml":
                    payload, count = MANUAL_LEGEND_LAYOUT.subn(rb"\1<c:layout/>", payload, count=1)
                    if count != 1:
                        raise RuntimeError("Expected exactly one manual legend layout in chart1.xml.")
                changed_parts.append(item.filename)
            canonical = zipfile.ZipInfo(item.filename, FIXED_ZIP_TIMESTAMP)
            canonical.compress_type = zipfile.ZIP_STORED
            canonical.create_system = 3
            canonical.external_attr = 0o600 << 16
            outgoing.writestr(canonical, payload)

    curated_hash = digest(args.output.read_bytes())
    if sorted(changed_parts) != ["ppt/charts/chart1.xml", "ppt/charts/chart2.xml"]:
        raise RuntimeError(f"Unexpected changed parts: {changed_parts}")
    if curated_hash != EXPECTED_CURATED_SHA256:
        raise RuntimeError(f"Unexpected curated SHA-256: {curated_hash}")
    print(f"Created {args.output} ({curated_hash}); changed only {', '.join(sorted(changed_parts))}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"chart fixture sanitization failed: {error}", file=sys.stderr)
        raise SystemExit(1)
