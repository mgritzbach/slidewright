#!/usr/bin/env python3
"""Verify that the shared editable header prefix is visibly rendered in C18 images."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

from PIL import Image


SCHEMA = "slidewright-rendered-header-evidence/v1"
CONTRACT_SCHEMA = "slidewright-rendered-header-contract/v1"
EXPECTED_DECKS = (
    "powerpoint-normalized-baseline",
    "horizontal-chart-data",
    "vertical-chart-data",
    "table-cell-edit",
    "diagram-node-move",
    "connector-style-geometry",
)
EXPECTED_SLIDES = (1, 2, 3, 4)
EXPECTED_FORMATS = ("png", "jpeg")
PREFIX_ROI = (70, 50, 345, 85)  # excludes the changing slide number
MIN_BLUE_PIXELS = 1700
MAX_BLUE_PIXELS = 2300
MAX_EMPTY_COLUMN_RUN = 32
MIN_OCCUPIED_COLUMN_RUNS = 12
MAX_OCCUPIED_COLUMN_RUNS = 24
MIN_CONNECTED_COMPONENTS = 12
MAX_CONNECTED_COMPONENTS = 30
EXPECTED_BOUNDS = {"leftMax": 83, "rightMin": 337, "topMin": 58, "bottomMax": 80}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def is_header_blue(pixel: tuple[int, int, int]) -> bool:
    red, green, blue = pixel
    return blue >= 145 and blue - red >= 35 and blue - green >= 15 and red <= 120


def decoded_crop_hash(image: Image.Image) -> str:
    crop = image.crop(PREFIX_ROI).convert("RGB")
    return sha256_bytes(crop.tobytes())


def measure(image: Image.Image) -> dict[str, Any]:
    rgb = image.convert("RGB")
    left, top, right, bottom = PREFIX_ROI
    points: list[tuple[int, int]] = []
    for y in range(top, bottom):
        for x in range(left, right):
            if is_header_blue(rgb.getpixel((x, y))):
                points.append((x, y))
    bounds = None
    if points:
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        bounds = {"left": min(xs), "top": min(ys), "right": max(xs), "bottom": max(ys)}
    occupied_columns = sorted({point[0] for point in points})
    occupied_column_runs = 0
    previous_column = None
    for column in occupied_columns:
        if previous_column is None or column > previous_column + 1:
            occupied_column_runs += 1
        previous_column = column
    maximum_empty_column_run = max(
        (right_column - left_column - 1 for left_column, right_column in zip(occupied_columns, occupied_columns[1:])),
        default=0,
    )
    remaining = set(points)
    connected_components = 0
    while remaining:
        connected_components += 1
        stack = [remaining.pop()]
        while stack:
            x, y = stack.pop()
            for neighbor in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    stack.append(neighbor)
    checks = {
        "pixelCount": len(points) >= MIN_BLUE_PIXELS,
        "maximumPixelCount": len(points) <= MAX_BLUE_PIXELS,
        "startsAtExpectedLeft": bounds is not None and bounds["left"] <= EXPECTED_BOUNDS["leftMax"],
        "reachesExpectedRight": bounds is not None and bounds["right"] >= EXPECTED_BOUNDS["rightMin"],
        "verticalBounds": bounds is not None
        and bounds["top"] >= EXPECTED_BOUNDS["topMin"]
        and bounds["bottom"] <= EXPECTED_BOUNDS["bottomMax"],
        "horizontalContinuity": maximum_empty_column_run <= MAX_EMPTY_COLUMN_RUN,
        "textLikeColumnRuns": MIN_OCCUPIED_COLUMN_RUNS <= occupied_column_runs <= MAX_OCCUPIED_COLUMN_RUNS,
        "textLikeComponents": MIN_CONNECTED_COMPONENTS <= connected_components <= MAX_CONNECTED_COMPONENTS,
    }
    return {
        "bluePixelCount": len(points),
        "blueBounds": bounds,
        "maximumEmptyColumnRun": maximum_empty_column_run,
        "occupiedColumnRuns": occupied_column_runs,
        "connectedComponents": connected_components,
        "decodedPrefixSha256": decoded_crop_hash(rgb),
        "checks": checks,
        "valid": all(checks.values()),
    }


def negative_control(image: Image.Image, control_id: str) -> dict[str, Any]:
    candidate = image.convert("RGB").copy()
    pixels = candidate.load()
    if control_id == "erase-prefix":
        region = (80, 55, 339, 82)
    elif control_id == "clip-leading-prefix":
        region = (70, 50, 170, 85)
    elif control_id == "remove-middle-prefix":
        region = (180, 50, 265, 85)
    elif control_id == "flatten-to-blue-bar":
        for y in range(PREFIX_ROI[1], PREFIX_ROI[3]):
            for x in range(PREFIX_ROI[0], PREFIX_ROI[2]):
                pixels[x, y] = (255, 255, 255)
        for y in range(61, 78):
            for x in range(81, 341):
                pixels[x, y] = (47, 107, 255)
        result = measure(candidate)
        return {
            "id": control_id,
            "rejected": result["valid"] is False,
            "region": {"left": 81, "top": 61, "right": 341, "bottom": 78},
            "failureChecks": sorted(key for key, value in result["checks"].items() if not value),
        }
    else:
        raise ValueError(f"Unknown negative control {control_id}")
    for y in range(region[1], region[3]):
        for x in range(region[0], region[2]):
            pixels[x, y] = (255, 255, 255)
    result = measure(candidate)
    return {
        "id": control_id,
        "rejected": result["valid"] is False,
        "region": {"left": region[0], "top": region[1], "right": region[2], "bottom": region[3]},
        "failureChecks": sorted(key for key, value in result["checks"].items() if not value),
    }


def audit(contract_path: Path, renders_root: Path, reference_root: Path) -> dict[str, Any]:
    contract = json.loads(contract_path.read_text(encoding="utf-8-sig"))
    failures: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    if contract.get("schemaVersion") != CONTRACT_SCHEMA:
        failures.append({"code": "RH001", "message": "Unsupported rendered-header contract schema."})
        return {"schemaVersion": SCHEMA, "valid": False, "warnings": warnings, "failures": failures}
    decks = contract.get("decks")
    if not isinstance(decks, list) or tuple(deck.get("id") for deck in decks if isinstance(deck, dict)) != EXPECTED_DECKS:
        failures.append({"code": "RH001", "message": "Rendered-header contract deck inventory drifted."})
        return {"schemaVersion": SCHEMA, "valid": False, "warnings": warnings, "failures": failures}

    reference_contract = contract.get("reference")
    if not isinstance(reference_contract, dict):
        failures.append({"code": "RH001", "message": "Rendered-header reference contract is missing."})
        return {"schemaVersion": SCHEMA, "valid": False, "warnings": warnings, "failures": failures}
    reference_records: dict[str, dict[str, Any]] = {}
    reference_image: Image.Image | None = None
    for image_format, file_key, hash_key in (
        ("png", "file", "sha256"),
        ("jpeg", "reviewFile", "reviewSha256"),
    ):
        image_path = (reference_root / str(reference_contract.get(file_key, ""))).resolve()
        try:
            image_path.relative_to(reference_root.resolve())
        except ValueError:
            failures.append({"code": "RH001", "message": f"Reference path escaped its root: {image_format}."})
            continue
        if not image_path.is_file() or sha256_file(image_path) != reference_contract.get(hash_key):
            failures.append({"code": "RH001", "message": f"Reference bytes drifted: {image_format}."})
            continue
        with Image.open(image_path) as opened:
            image = opened.convert("RGB")
        if image.size != (1600, 900):
            failures.append({"code": "RH002", "message": f"Reference dimensions drifted: {image_format}."})
            continue
        measured = measure(image)
        if not measured["valid"]:
            failures.append({"code": "RH003", "message": f"Reference header prefix is not valid text: {image_format}."})
        reference_records[image_format] = {"sha256": reference_contract[hash_key], **measured}
        if image_format == "png":
            reference_image = image.copy()

    records: list[dict[str, Any]] = []
    prefix_hashes: dict[str, set[str]] = {name: set() for name in EXPECTED_FORMATS}
    for deck in decks:
        renders = deck.get("renders")
        if not isinstance(renders, list) or tuple(item.get("slide") for item in renders if isinstance(item, dict)) != EXPECTED_SLIDES:
            failures.append({"code": "RH001", "message": f"Slide inventory drifted for {deck.get('id')}."})
            continue
        for render in renders:
            for image_format, file_key, hash_key in (
                ("png", "file", "sha256"),
                ("jpeg", "reviewFile", "reviewSha256"),
            ):
                relative = Path(str(deck["id"])) / str(render[file_key])
                image_path = (renders_root / relative).resolve()
                try:
                    image_path.relative_to(renders_root.resolve())
                except ValueError:
                    failures.append({"code": "RH001", "message": f"Render path escaped its root: {relative.as_posix()}."})
                    continue
                if not image_path.is_file() or sha256_file(image_path) != render[hash_key]:
                    failures.append({"code": "RH001", "message": f"Render bytes drifted: {relative.as_posix()}."})
                    continue
                with Image.open(image_path) as opened:
                    image = opened.convert("RGB")
                if image.size != (1600, 900):
                    failures.append({"code": "RH002", "message": f"Render dimensions drifted: {relative.as_posix()}."})
                    continue
                measured = measure(image)
                prefix_hashes[image_format].add(measured["decodedPrefixSha256"])
                if not measured["valid"]:
                    failures.append({"code": "RH003", "message": f"Visible header prefix is incomplete: {relative.as_posix()}."})
                records.append({
                    "deckId": deck["id"],
                    "slide": render["slide"],
                    "format": image_format,
                    "file": relative.as_posix(),
                    "sha256": render[hash_key],
                    **measured,
                })

    for image_format, hashes in prefix_hashes.items():
        if len(hashes) != 1:
            failures.append({"code": "RH004", "message": f"Decoded shared header prefix differs across {image_format} renders."})
        if reference_records.get(image_format, {}).get("decodedPrefixSha256") not in hashes:
            failures.append({"code": "RH006", "message": f"Rendered {image_format} header prefix does not match the immutable C08 glyph reference."})
    controls = [] if reference_image is None else [negative_control(reference_image, control_id) for control_id in (
        "erase-prefix", "clip-leading-prefix", "remove-middle-prefix", "flatten-to-blue-bar"
    )]
    if len(controls) != 4 or not all(item["rejected"] and item["failureChecks"] for item in controls):
        failures.append({"code": "RH005", "message": "Rendered-header negative controls did not fail closed."})
    return {
        "schemaVersion": SCHEMA,
        "valid": not failures,
        "contractSha256": sha256_file(contract_path),
        "imageCount": len(records),
        "prefixRoi": {"left": PREFIX_ROI[0], "top": PREFIX_ROI[1], "right": PREFIX_ROI[2], "bottom": PREFIX_ROI[3]},
        "minimumBluePixels": MIN_BLUE_PIXELS,
        "maximumBluePixels": MAX_BLUE_PIXELS,
        "maximumEmptyColumnRun": MAX_EMPTY_COLUMN_RUN,
        "occupiedColumnRuns": {"minimum": MIN_OCCUPIED_COLUMN_RUNS, "maximum": MAX_OCCUPIED_COLUMN_RUNS},
        "connectedComponents": {"minimum": MIN_CONNECTED_COMPONENTS, "maximum": MAX_CONNECTED_COMPONENTS},
        "expectedBounds": EXPECTED_BOUNDS,
        "sharedPrefixHashes": {key: sorted(value) for key, value in prefix_hashes.items()},
        "reference": reference_records,
        "records": records,
        "negativeControls": controls,
        "warnings": warnings,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--renders-root", type=Path, required=True)
    parser.add_argument("--reference-renders-root", type=Path, required=True)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args()
    try:
        report = audit(args.contract.resolve(), args.renders_root.resolve(), args.reference_renders_root.resolve())
    except Exception as error:  # fail closed with a stable report
        report = {
            "schemaVersion": SCHEMA,
            "valid": False,
            "warnings": [],
            "failures": [{"code": "RH999", "message": f"Rendered-header audit failed closed: {error}"}],
        }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, sort_keys=True))
    return 0 if report.get("valid") else 2


if __name__ == "__main__":
    raise SystemExit(main())
