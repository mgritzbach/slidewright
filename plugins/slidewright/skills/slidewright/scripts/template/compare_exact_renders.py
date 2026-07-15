#!/usr/bin/env python3
"""Require two rendered decks to remain visually identical within tolerance."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageEnhance


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
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for number in range(1, args.slides + 1):
        expected = Image.open(expected_dir / f"slide-{number}.png").convert("RGB")
        actual = Image.open(actual_dir / f"slide-{number}.png").convert("RGB").resize(expected.size, Image.Resampling.LANCZOS)
        absolute = np.abs(np.asarray(expected, dtype=np.float32) - np.asarray(actual, dtype=np.float32))
        similarity = 1.0 - float(absolute.mean()) / 255.0
        ImageEnhance.Contrast(ImageChops.difference(expected, actual)).enhance(3).save(out_dir / f"slide-{number}-diff.png")
        results.append({"slide": number, "similarity": round(similarity, 6), "valid": similarity >= args.minimum})
    report = {"valid": all(item["valid"] for item in results), "minimumSimilarity": args.minimum, "slides": results}
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
