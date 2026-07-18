#!/usr/bin/env python3
"""Produce deterministic exact and 64-bit difference hashes for review images."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def difference_hash(path: Path) -> str:
    with Image.open(path) as image:
        grayscale = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
        pixels = list(grayscale.get_flattened_data())
    bits = 0
    for row in range(8):
        for column in range(8):
            bits = (bits << 1) | int(pixels[row * 9 + column] > pixels[row * 9 + column + 1])
    return f"{bits:016x}"


def hamming(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def select_diverse(records: list[dict], minimum_distance: int, minimum_count: int) -> set[str]:
    unique = []
    seen = set()
    for record in sorted(records, key=lambda item: item["path"]):
        if record["sha256"] in seen:
            continue
        seen.add(record["sha256"])
        unique.append(record)
    adjacency = [
        {right for right in range(len(unique)) if right != left and hamming(unique[left]["dhash64"], unique[right]["dhash64"]) >= minimum_distance}
        for left in range(len(unique))
    ]
    solution = None

    def expand(clique: list[int], candidates: set[int]) -> bool:
        nonlocal solution
        if len(clique) >= minimum_count:
            solution = list(clique)
            return True
        if len(clique) + len(candidates) < minimum_count:
            return False
        remaining = set(candidates)
        while remaining:
            if len(clique) + len(remaining) < minimum_count:
                return False
            vertex = max(remaining, key=lambda item: (len(adjacency[item] & remaining), unique[item]["path"]))
            remaining.remove(vertex)
            if expand(clique + [vertex], remaining & adjacency[vertex]):
                return True
        return False

    expand([], set(range(len(unique))))
    if solution is None:
        raise ValueError(f"No {minimum_count}-design subset meets pairwise dHash distance {minimum_distance}.")
    return {unique[index]["path"] for index in solution}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--minimum-distance", type=int, required=True)
    parser.add_argument("--minimum-count", type=int, required=True)
    args = parser.parse_args()
    paths = json.loads(args.list.read_text(encoding="utf-8"))
    records = []
    for value in paths:
        path = Path(value).resolve()
        with Image.open(path) as image:
            width, height = image.size
        records.append(
            {
                "path": str(path),
                "sha256": sha256_file(path),
                "dhash64": difference_hash(path),
                "width": width,
                "height": height,
            }
        )
    selected = select_diverse(records, args.minimum_distance, args.minimum_count)
    for record in records:
        record["selected"] = record["path"] in selected
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
