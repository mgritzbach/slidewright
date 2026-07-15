#!/usr/bin/env python3
"""Independent pixel scorer for opaque-image reconstruction."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageEnhance, ImageFilter


def background_from_corners(image: np.ndarray) -> np.ndarray:
    height, width, _ = image.shape
    patch = max(4, min(height, width) // 80)
    pixels = np.concatenate([
        image[:patch, :patch].reshape(-1, 3),
        image[:patch, width - patch:].reshape(-1, 3),
        image[height - patch:, :patch].reshape(-1, 3),
        image[height - patch:, width - patch:].reshape(-1, 3),
    ])
    return np.median(pixels, axis=0)


def edge_map(image: Image.Image, threshold: float = 20) -> np.ndarray:
    values = np.asarray(image.convert("L"), dtype=np.float32)
    horizontal = np.zeros_like(values)
    vertical = np.zeros_like(values)
    horizontal[:, 1:] = np.abs(values[:, 1:] - values[:, :-1])
    vertical[1:] = np.abs(values[1:] - values[:-1])
    return np.maximum(horizontal, vertical) > threshold


def dilate(mask: np.ndarray, size: int = 5) -> np.ndarray:
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(size))) > 0


def edge_f1(source: Image.Image, candidate: Image.Image) -> dict:
    source_edges = edge_map(source)
    candidate_edges = edge_map(candidate)
    precision = float((candidate_edges & dilate(source_edges)).sum()) / max(1, int(candidate_edges.sum()))
    recall = float((source_edges & dilate(candidate_edges)).sum()) / max(1, int(source_edges.sum()))
    f1 = 2 * precision * recall / max(1e-12, precision + recall)
    return {"precision": precision, "recall": recall, "f1": f1}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("render")
    parser.add_argument("--json", required=True)
    parser.add_argument("--diff", required=True)
    parser.add_argument("--overlay", required=True)
    parser.add_argument("--min-similarity", type=float, default=0.95)
    parser.add_argument("--min-foreground-similarity", type=float, default=0.80)
    parser.add_argument("--min-background-normalized-similarity", type=float, default=0.40)
    parser.add_argument("--min-edge-f1", type=float, default=0.70)
    args = parser.parse_args()
    source = Image.open(args.source).convert("RGB")
    render = Image.open(args.render).convert("RGB").resize(source.size, Image.Resampling.LANCZOS)
    source_arr = np.asarray(source, dtype=np.float32)
    render_arr = np.asarray(render, dtype=np.float32)
    background = background_from_corners(source_arr)
    absolute = np.abs(source_arr - render_arr)
    similarity = 1.0 - float(absolute.mean()) / 255.0
    foreground_mask = (np.abs(source_arr - background).max(axis=2) > 8) | (np.abs(render_arr - background).max(axis=2) > 8)
    foreground_mae = float(absolute[foreground_mask].mean()) if foreground_mask.any() else 0.0
    foreground_similarity = 1.0 - foreground_mae / 255.0
    signal = max(float(np.abs(source_arr - background).sum()), float(np.abs(render_arr - background).sum()))
    normalized = max(0.0, 1.0 - float(absolute.sum()) / signal) if signal else 1.0
    blank_absolute = np.abs(source_arr - background)
    blank_similarity = 1.0 - float(blank_absolute.mean()) / 255.0
    source_foreground = np.abs(source_arr - background).max(axis=2) > 8
    blank_foreground = 1.0 - float(blank_absolute[source_foreground].mean()) / 255.0 if source_foreground.any() else 1.0
    blank_normalized = 0.0 if float(blank_absolute.sum()) else 1.0
    blank_pass = blank_similarity >= args.min_similarity and blank_foreground >= args.min_foreground_similarity and blank_normalized >= args.min_background_normalized_similarity
    edges = edge_f1(source, render)
    passed = similarity >= args.min_similarity and foreground_similarity >= args.min_foreground_similarity and normalized >= args.min_background_normalized_similarity and edges["f1"] >= args.min_edge_f1 and not blank_pass
    Path(args.diff).parent.mkdir(parents=True, exist_ok=True)
    ImageEnhance.Contrast(ImageChops.difference(source, render)).enhance(3).save(args.diff)
    Image.blend(source, render, 0.5).save(args.overlay)
    report = {
        "valid": passed,
        "thresholdPolicy": {
            "pixelThresholdsFrozenBeforeFirstRun": True,
            "edgeGateAddedAfterErasedTextNegativeControlAudit": True,
            "edgeGateVersion": "edge-v1",
        },
        "minimumSimilarity": args.min_similarity,
        "minimumForegroundSimilarity": args.min_foreground_similarity,
        "minimumBackgroundNormalizedSimilarity": args.min_background_normalized_similarity,
        "minimumEdgeF1": args.min_edge_f1,
        "backgroundDerivedFromSourceCorners": [round(float(value), 3) for value in background],
        "similarity": round(similarity, 5),
        "foregroundSimilarity": round(foreground_similarity, 5),
        "backgroundNormalizedSimilarity": round(normalized, 5),
        "edgePrecision": round(edges["precision"], 5),
        "edgeRecall": round(edges["recall"], 5),
        "edgeF1": round(edges["f1"], 5),
        "blankControl": {
            "similarity": round(blank_similarity, 5),
            "foregroundSimilarity": round(blank_foreground, 5),
            "backgroundNormalizedSimilarity": blank_normalized,
            "pass": blank_pass,
        },
    }
    Path(args.json).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
