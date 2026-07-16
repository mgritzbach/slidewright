#!/usr/bin/env python3
"""Create the source-bound asymmetry manifest for the synthetic G23 fixture."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


FIRST = "SW Declared Rule Left"
SECOND = "SW Declared Rule Right"
REASON = "Source-authored paired section rules use different thickness to encode primary and secondary emphasis."


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[3]
    sys.path.insert(
        0,
        str(repo / "plugins" / "slidewright" / "skills" / "slidewright" / "scripts" / "design_profile"),
    )
    from design_profile_core import extract_profile  # pylint: disable=import-outside-toplevel

    profile = extract_profile(args.source, None, enforce_symmetry=False)
    contract = next(
        (
            item
            for item in profile["symmetryContracts"]
            if {item["first"], item["second"]} == {FIRST, SECOND}
        ),
        None,
    )
    if contract is None or contract["symmetric"]:
        raise RuntimeError("Fixture does not contain the intended asymmetric paired rule.")

    objects = {item["name"]: item for item in profile["objects"] if item["part"] == contract["part"]}
    value = {
        "schemaVersion": "slidewright-asymmetry/v1",
        "sourceSha256": profile["source"]["sha256"],
        "rules": [
            {
                "part": contract["part"],
                "first": FIRST,
                "second": SECOND,
                "reason": REASON,
                "sourceObjectSha256": {
                    FIRST: objects[FIRST]["xmlSha256"],
                    SECOND: objects[SECOND]["xmlSha256"],
                },
            }
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
