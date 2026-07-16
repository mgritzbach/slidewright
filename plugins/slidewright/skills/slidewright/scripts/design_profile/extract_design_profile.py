#!/usr/bin/env python3
"""Extract a deterministic Slidewright v1 design profile from a PPTX.

Usage:
  python extract_design_profile.py source.pptx --out profile.json
  python extract_design_profile.py source.pptx --asymmetry-manifest approved.json

The optional manifest uses schemaVersion slidewright-asymmetry/v1 and binds
every exception to the source PPTX SHA-256 plus both exact object hashes.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from design_profile_core import ProfileError, extract_profile, json_payload


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract a deterministic, machine-readable PowerPoint design profile."
    )
    parser.add_argument("pptx", type=Path, help="Source .pptx to inspect without modifying.")
    parser.add_argument(
        "--out",
        type=Path,
        help="Write UTF-8 JSON here. JSON is always also emitted to stdout.",
    )
    parser.add_argument(
        "--asymmetry-manifest",
        type=Path,
        help="Source-hash/object-hash-bound declarations for intentional unequal rail pairs.",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress JSON on stdout when --out is used.")
    args = parser.parse_args()

    try:
        profile = extract_profile(args.pptx, args.asymmetry_manifest, enforce_symmetry=True)
    except ProfileError as error:
        sys.stderr.write(f"design-profile extraction failed: {error}\n")
        return 2

    payload = json_payload(profile)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(payload, encoding="utf-8", newline="\n")
    if not args.quiet:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
