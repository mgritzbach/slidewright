#!/usr/bin/env python3
"""Compare browser ground truth with rendered PowerPoint slides."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageEnhance


def display_path(value: Path) -> str:
    try:
        return str(value.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("references")
    parser.add_argument("renders")
    parser.add_argument("suite")
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-similarity", type=float, default=0.95)
    parser.add_argument("--min-foreground-similarity", type=float, default=0.80)
    parser.add_argument("--min-background-normalized-similarity", type=float, default=0.40)
    args = parser.parse_args()
    refs, renders, out = Path(args.references), Path(args.renders), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    suite = json.loads(Path(args.suite).read_text(encoding="utf-8"))
    results = []
    for index, slide in enumerate(suite["slides"], start=1):
        reference = Image.open(refs / f"{slide['id']}.png").convert("RGB")
        candidate_path = renders / f"slide-{index}.png"
        candidate = Image.open(candidate_path).convert("RGB").resize(reference.size, Image.Resampling.LANCZOS)
        ref_arr = np.asarray(reference, dtype=np.float32)
        cand_arr = np.asarray(candidate, dtype=np.float32)
        absolute = np.abs(ref_arr - cand_arr)
        mae = float(absolute.mean())
        similarity = 1.0 - mae / 255.0
        background = np.array([int(slide["background"][offset:offset + 2], 16) for offset in (1, 3, 5)], dtype=np.float32)
        foreground_mask = (np.abs(ref_arr - background).max(axis=2) > 8) | (np.abs(cand_arr - background).max(axis=2) > 8)
        foreground_mae = float(absolute[foreground_mask].mean()) if foreground_mask.any() else 0.0
        foreground_similarity = 1.0 - foreground_mae / 255.0
        signal = max(float(np.abs(ref_arr - background).sum()), float(np.abs(cand_arr - background).sum()))
        background_normalized_similarity = max(0.0, 1.0 - float(absolute.sum()) / signal) if signal else 1.0
        blank_absolute = np.abs(ref_arr - background)
        blank_global_similarity = 1.0 - float(blank_absolute.mean()) / 255.0
        reference_foreground = np.abs(ref_arr - background).max(axis=2) > 8
        blank_foreground_similarity = 1.0 - float(blank_absolute[reference_foreground].mean()) / 255.0 if reference_foreground.any() else 1.0
        blank_background_normalized_similarity = 0.0 if float(blank_absolute.sum()) else 1.0
        blank_pass = blank_global_similarity >= args.min_similarity and blank_foreground_similarity >= args.min_foreground_similarity and blank_background_normalized_similarity >= args.min_background_normalized_similarity
        within_16 = float((absolute.max(axis=2) <= 16).mean())
        diff = ImageChops.difference(reference, candidate)
        ImageEnhance.Contrast(diff).enhance(3).save(out / f"{slide['id']}-diff.png")
        Image.blend(reference, candidate, 0.5).save(out / f"{slide['id']}-overlay.png")
        results.append({"id": slide["id"], "reference": display_path(refs / f"{slide['id']}.png"), "render": display_path(candidate_path), "mae": round(mae, 3), "similarity": round(similarity, 5), "foregroundMae": round(foreground_mae, 3), "foregroundSimilarity": round(foreground_similarity, 5), "foregroundCoverage": round(float(foreground_mask.mean()), 5), "backgroundNormalizedSimilarity": round(background_normalized_similarity, 5), "blankControl": {"similarity": round(blank_global_similarity, 5), "foregroundSimilarity": round(blank_foreground_similarity, 5), "backgroundNormalizedSimilarity": blank_background_normalized_similarity, "pass": blank_pass}, "pixelsWithin16": round(within_16, 5), "pass": similarity >= args.min_similarity and foreground_similarity >= args.min_foreground_similarity and background_normalized_similarity >= args.min_background_normalized_similarity})
    average = sum(item["similarity"] for item in results) / len(results)
    foreground_average = sum(item["foregroundSimilarity"] for item in results) / len(results)
    background_normalized_average = sum(item["backgroundNormalizedSimilarity"] for item in results) / len(results)
    blank_control_rejected = all(not item["blankControl"]["pass"] for item in results)
    report = {"valid": all(item["pass"] for item in results) and blank_control_rejected, "blankControlRejected": blank_control_rejected, "minimumSimilarity": args.min_similarity, "minimumForegroundSimilarity": args.min_foreground_similarity, "minimumBackgroundNormalizedSimilarity": args.min_background_normalized_similarity, "averageSimilarity": round(average, 5), "averageForegroundSimilarity": round(foreground_average, 5), "averageBackgroundNormalizedSimilarity": round(background_normalized_average, 5), "slides": results}
    (out / "visual-fidelity.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"valid": report["valid"], "blankControlRejected": report["blankControlRejected"], "averageSimilarity": report["averageSimilarity"], "averageForegroundSimilarity": report["averageForegroundSimilarity"], "averageBackgroundNormalizedSimilarity": report["averageBackgroundNormalizedSimilarity"], "minimumSimilarity": args.min_similarity, "minimumForegroundSimilarity": args.min_foreground_similarity, "minimumBackgroundNormalizedSimilarity": args.min_background_normalized_similarity}, indent=2))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
