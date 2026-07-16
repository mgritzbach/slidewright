#!/usr/bin/env python3
"""Remove workstation identity and pin the synthetic fixture theme."""

from __future__ import annotations

import re
import sys
import tempfile
import zipfile
from pathlib import Path

NEUTRAL = b"Slidewright contributors"
COLOR_SCHEME = b"""<a:clrScheme name="Slidewright Five Color">
<a:dk1><a:srgbClr val="2F263F"/></a:dk1>
<a:lt1><a:srgbClr val="F7F3EA"/></a:lt1>
<a:dk2><a:srgbClr val="4A4552"/></a:dk2>
<a:lt2><a:srgbClr val="F7F3EA"/></a:lt2>
<a:accent1><a:srgbClr val="3D53E5"/></a:accent1>
<a:accent2><a:srgbClr val="E36B3D"/></a:accent2>
<a:accent3><a:srgbClr val="4A4552"/></a:accent3>
<a:accent4><a:srgbClr val="3D53E5"/></a:accent4>
<a:accent5><a:srgbClr val="E36B3D"/></a:accent5>
<a:accent6><a:srgbClr val="2F263F"/></a:accent6>
<a:hlink><a:srgbClr val="3D53E5"/></a:hlink>
<a:folHlink><a:srgbClr val="E36B3D"/></a:folHlink>
</a:clrScheme>"""

def normalize_core(payload: bytes) -> bytes:
    payload = re.sub(rb"(<dc:creator>).*?(</dc:creator>)", rb"\g<1>" + NEUTRAL + rb"\g<2>", payload)
    return re.sub(rb"(<cp:lastModifiedBy>).*?(</cp:lastModifiedBy>)", rb"\g<1>" + NEUTRAL + rb"\g<2>", payload)

def normalize_theme(payload: bytes) -> bytes:
    updated, count = re.subn(rb"<a:clrScheme\b.*?</a:clrScheme>", COLOR_SCHEME, payload, count=1, flags=re.DOTALL)
    if count != 1:
        raise RuntimeError("Expected exactly one theme color scheme.")
    updated = re.sub(rb'(<a:(?:latin|ea|cs)\b[^>]*\btypeface=")[^"]*(")', rb'\g<1>Arial\g<2>', updated)
    return updated

def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: sanitize-fixture-metadata.py <fixture.pptx>")
    source = Path(sys.argv[1]).resolve()
    with zipfile.ZipFile(source) as archive:
        entries = [(info, archive.read(info.filename)) for info in archive.infolist()]
    core_changed = False
    theme_changed = False
    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False, dir=source.parent) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for info, payload in entries:
                if info.filename == "docProps/core.xml":
                    normalized = normalize_core(payload)
                    core_changed = normalized != payload
                    payload = normalized
                elif info.filename.startswith("ppt/theme/theme") and info.filename.endswith(".xml"):
                    normalized = normalize_theme(payload)
                    theme_changed = theme_changed or normalized != payload
                    payload = normalized
                archive.writestr(info, payload)
        if not core_changed or not theme_changed:
            raise RuntimeError(f"Fixture normalization incomplete: core={core_changed}, theme={theme_changed}.")
        temporary.replace(source)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"Normalized fixture author metadata and theme: {source}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
