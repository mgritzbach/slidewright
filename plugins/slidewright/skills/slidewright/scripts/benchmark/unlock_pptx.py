#!/usr/bin/env python3
"""Remove grouping locks emitted by the renderer without changing content."""

from __future__ import annotations

import argparse
import shutil
import tempfile
import zipfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pptx")
    args = parser.parse_args()
    source = Path(args.pptx)
    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False, dir=source.parent) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(source, "r") as incoming, zipfile.ZipFile(temporary, "w") as outgoing:
            for item in incoming.infolist():
                data = incoming.read(item.filename)
                if item.filename.startswith("ppt/slides/") and item.filename.endswith(".xml"):
                    data = data.replace(b' noGrp="1"', b'').replace(b' noUngrp="1"', b'')
                outgoing.writestr(item, data)
        shutil.move(temporary, source)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Removed grouping locks from {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
