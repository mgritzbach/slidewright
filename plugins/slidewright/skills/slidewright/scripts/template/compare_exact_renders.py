#!/usr/bin/env python3
"""Require two rendered decks to remain visually identical within tolerance."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageEnhance


def render_inventory(directory: Path) -> list[int]:
    result = []
    for item in directory.iterdir():
        if item.is_file() and item.name.startswith("slide-") and item.suffix.lower() == ".png":
            raw = item.stem.removeprefix("slide-")
            if not raw.isdigit() or int(raw) < 1:
                raise ValueError(f"Invalid rendered-slide filename: {item.name}")
            result.append(int(raw))
    return sorted(result)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("expected")
    parser.add_argument("actual")
    parser.add_argument("--slides", type=int, required=True)
    parser.add_argument("--json", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--minimum", type=float, default=0.999)
    args = parser.parse_args()
    expected_dir, actual_dir, out_dir = Path(args.expected), Path(args.actual), Path(args.out_dir)
    if args.slides < 1:
        parser.error("--slides must be a positive integer")
    if not 0.0 <= args.minimum <= 1.0:
        parser.error("--minimum must be between 0 and 1 inclusive")
    expected_inventory = list(range(1, args.slides + 1))
    if render_inventory(expected_dir) != expected_inventory:
        parser.error(f"expected render inventory must be exactly {expected_inventory}")
    if render_inventory(actual_dir) != expected_inventory:
        parser.error(f"actual render inventory must be exactly {expected_inventory}")
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for number in range(1, args.slides + 1):
        expected = Image.open(expected_dir / f"slide-{number}.png").convert("RGB")
        actual = Image.open(actual_dir / f"slide-{number}.png").convert("RGB")
        dimensions_match = actual.size == expected.size
        if not dimensions_match:
            diagnostic = Image.new("RGB", expected.size, "#FF00FF")
            diagnostic.save(out_dir / f"slide-{number}-diff.png")
            results.append({
                "slide": number,
                "expectedSize": list(expected.size),
                "actualSize": list(actual.size),
                "dimensionsMatch": False,
                "similarity": 0.0,
                "changedPixelFraction": 1.0,
                "maximumChannelDelta": 255,
                "valid": False,
            })
            continue
        absolute = np.abs(np.asarray(expected, dtype=np.float32) - np.asarray(actual, dtype=np.float32))
        similarity = 1.0 - float(absolute.mean()) / 255.0
        changed = absolute.max(axis=2) > 0
        changed_fraction = float(changed.mean())
        maximum_delta = int(absolute.max())
        ImageEnhance.Contrast(ImageChops.difference(expected, actual)).enhance(3).save(out_dir / f"slide-{number}-diff.png")
        exact_required = args.minimum == 1.0
        valid = similarity >= args.minimum and (not exact_required or changed_fraction == 0.0)
        results.append({
            "slide": number,
            "expectedSize": list(expected.size),
            "actualSize": list(actual.size),
            "dimensionsMatch": True,
            "similarity": round(similarity, 6),
            "changedPixelFraction": round(changed_fraction, 9),
            "maximumChannelDelta": maximum_delta,
            "valid": valid,
        })
    report = {"valid": all(item["valid"] for item in results), "minimumSimilarity": args.minimum, "slides": results}
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
