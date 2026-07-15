#!/usr/bin/env python3
"""Replace workstation Office identity in the synthetic golden fixture."""

from __future__ import annotations

import re
import sys
import tempfile
import zipfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: sanitize-fixture-metadata.py <fixture.pptx>")
    source = Path(sys.argv[1]).resolve()
    neutral = b"Slidewright contributors"
    with zipfile.ZipFile(source) as archive:
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]
    changed = False
    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False, dir=source.parent) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for info, payload in entries:
                if info.filename == "docProps/core.xml":
                    updated = re.sub(rb"(<dc:creator>).*?(</dc:creator>)", rb"\g<1>" + neutral + rb"\g<2>", payload)
                    updated = re.sub(rb"(<cp:lastModifiedBy>).*?(</cp:lastModifiedBy>)", rb"\g<1>" + neutral + rb"\g<2>", updated)
                    changed = updated != payload
                    payload = updated
                archive.writestr(info, payload)
        if not changed:
            raise RuntimeError("Expected author metadata was not found in docProps/core.xml.")
        temporary.replace(source)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Normalized fixture author metadata: {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
