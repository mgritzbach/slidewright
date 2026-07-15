#!/usr/bin/env python3
"""Create a fixture-specific text-erasure control to challenge the image scorer."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("design")
    parser.add_argument("out")
    args = parser.parse_args()
    source = Image.open(args.source).convert("RGB")
    design = json.loads(Path(args.design).read_text(encoding="utf-8"))
    candidate = source.copy()
    draw = ImageDraw.Draw(candidate)
    width, height = source.size
    erased = 0
    for obj in design["objects"]:
        if obj["type"] != "text":
            continue
        bbox = obj["bbox"]
        left = int(bbox["left"] * width) - 8
        top = int(bbox["top"] * height) - 8
        right = int((bbox["left"] + bbox["width"]) * width) + 8
        bottom = int((bbox["top"] + bbox["height"]) * height) + 8
        fill = (25, 42, 64) if (left + right) / 2 > 800 else (244, 236, 217)
        draw.rectangle((left, top, right, bottom), fill=fill)
        erased += 1
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    candidate.save(args.out)
    print(f"Erased {erased} observed text regions into {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
