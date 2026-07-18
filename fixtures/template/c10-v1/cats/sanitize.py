#!/usr/bin/env python3
"""Create the deterministic, privacy-sanitized C10 Cats fixture.

The upstream PPTX remains the authoritative source. This script fails closed
unless that source has the exact reviewed SHA-256 and every expected private
fragment is present exactly where anticipated.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import zipfile
from pathlib import Path


EXPECTED_UPSTREAM_SHA256 = (
    "b0b5eea81ad7d8a47c5cb98f04e286d0b9bbe6177b15b57003618e1165dc77ba"
)
EXPECTED_CURATED_SHA256 = "b996327ede97791a8e54cde0983f04880bdddd68b28901ff129146d59362547c"
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)

CORE_PART = "docProps/core.xml"
APP_PART = "docProps/app.xml"
CHANGES_PART = "ppt/changesInfos/changesInfo1.xml"
REVISION_PART = "ppt/revisionInfo.xml"
SLIDE_PARTS = {
    "ppt/slides/slide31.xml": {
        "shape_marker": '<p:cNvPr id="8" name="TextBox 7"',
        "credit_url": "https://clevelandart.org/art/1940.1090",
    },
    "ppt/slides/slide32.xml": {
        "shape_marker": '<p:cNvPr id="4" name="TextBox 3"',
        "credit_url": "https://www.nga.gov/collection/art-object-page.45859.html",
    },
    "ppt/slides/slide33.xml": {
        "shape_marker": '<p:cNvPr id="4" name="TextBox 3"',
        "credit_url": "https://www.nga.gov/collection/art-object-page.220470.html",
    },
}

PRIVATE_FRAGMENTS = (
    "Dewees, John",
    "John Dewees",
    "john.dewees@rochester.edu",
    "University of Rochester",
    "DAM Lead",
    "Thank you for listening",
    "fd826619-08b0-4a32-a185-489740054ff3",
    "{E3E8D473-CAF0-44B4-9A79-5A99E944E73E}",
    "{B4260BAF-BB1B-4549-8A96-DCFFF6D83C57}",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def replace_exact(data: bytes, old: bytes, new: bytes, expected: int, label: str) -> bytes:
    count = data.count(old)
    if count != expected:
        raise ValueError(f"{label}: expected {expected} occurrence(s), found {count}")
    return data.replace(old, new)


def remove_private_shape(part: str, data: bytes, shape_marker: str, credit_url: str) -> bytes:
    text = data.decode("utf-8")
    blocks = list(re.finditer(r"<p:sp>.*?</p:sp>", text, flags=re.DOTALL))
    matches = [
        match
        for match in blocks
        if shape_marker in match.group(0)
        and "Thank you for listening" in match.group(0)
        and "john.dewees@rochester.edu" in match.group(0)
    ]
    if len(matches) != 1:
        raise ValueError(f"{part}: expected one reviewed private text shape, found {len(matches)}")
    match = matches[0]
    sanitized = text[: match.start()] + text[match.end() :]
    if credit_url not in sanitized:
        raise ValueError(f"{part}: artwork credit URL was not preserved")
    return sanitized.encode("utf-8")


def sanitize_entries(source: Path) -> tuple[list[str], dict[str, bytes]]:
    with zipfile.ZipFile(source, "r") as package:
        if package.comment:
            raise ValueError("upstream archive comment is unsupported")
        infos = package.infolist()
        names = [info.filename for info in infos]
        if len(names) != len(set(names)):
            raise ValueError("upstream package contains duplicate ZIP entries")
        if any(info.flag_bits & 0x1 for info in infos):
            raise ValueError("upstream package contains encrypted ZIP entries")
        entries = {info.filename: package.read(info) for info in infos}

    required = {CORE_PART, APP_PART, CHANGES_PART, REVISION_PART, *SLIDE_PARTS}
    missing = sorted(required.difference(entries))
    if missing:
        raise ValueError(f"upstream package is missing reviewed part(s): {missing}")

    entries[CORE_PART] = replace_exact(
        entries[CORE_PART],
        b"<dc:creator>Dewees, John</dc:creator>",
        b"<dc:creator>Slidewright Fixture</dc:creator>",
        1,
        CORE_PART,
    )
    entries[CORE_PART] = replace_exact(
        entries[CORE_PART],
        b"<cp:lastModifiedBy>John Dewees</cp:lastModifiedBy>",
        b"<cp:lastModifiedBy>Slidewright Fixture</cp:lastModifiedBy>",
        1,
        CORE_PART,
    )
    entries[APP_PART] = replace_exact(
        entries[APP_PART],
        b"<Company>University of Rochester</Company>",
        b"<Company></Company>",
        1,
        APP_PART,
    )

    changes = entries[CHANGES_PART]
    author_count = changes.count(b'name="Dewees, John"')
    if author_count == 0:
        raise ValueError(f"{CHANGES_PART}: reviewed author name was not found")
    changes = replace_exact(
        changes,
        b'name="Dewees, John"',
        b'name="Slidewright Fixture"',
        author_count,
        CHANGES_PART,
    )
    if b'name="Dewees, John"' in changes:
        raise ValueError(f"{CHANGES_PART}: author name remained after replacement")
    user_id_count = changes.count(b'userId="fd826619-08b0-4a32-a185-489740054ff3"')
    if user_id_count == 0:
        raise ValueError(f"{CHANGES_PART}: reviewed user identifier was not found")
    changes = replace_exact(
        changes,
        b'userId="fd826619-08b0-4a32-a185-489740054ff3"',
        b'userId="00000000-0000-0000-0000-000000000000"',
        user_id_count,
        CHANGES_PART,
    )
    changes_text = changes.decode("utf-8")
    changes_text, clid_count = re.subn(
        r'clId="\{[0-9A-Fa-f-]{36}\}"',
        'clId="{00000000-0000-0000-0000-000000000000}"',
        changes_text,
    )
    if clid_count == 0:
        raise ValueError(f"{CHANGES_PART}: no reviewed client identifiers found")
    entries[CHANGES_PART] = changes_text.encode("utf-8")

    entries[REVISION_PART] = replace_exact(
        entries[REVISION_PART],
        b'id="{E3E8D473-CAF0-44B4-9A79-5A99E944E73E}"',
        b'id="{00000000-0000-0000-0000-000000000000}"',
        1,
        REVISION_PART,
    )

    for part, contract in SLIDE_PARTS.items():
        entries[part] = remove_private_shape(part, entries[part], **contract)

    searchable = b"\n".join(
        data for name, data in entries.items() if name.endswith((".xml", ".rels"))
    ).decode("utf-8", errors="strict")
    leaked = [fragment for fragment in PRIVATE_FRAGMENTS if fragment.lower() in searchable.lower()]
    if leaked:
        raise ValueError(f"privacy sanitation failed; fragment(s) remain: {leaked}")

    return names, entries


def write_deterministic_package(output: Path, names: list[str], entries: dict[str, bytes]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    if temporary.exists():
        temporary.unlink()
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as package:
            for name in names:
                info = zipfile.ZipInfo(name, date_time=FIXED_ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 0
                info.external_attr = 0
                package.writestr(info, entries[name])
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()


def validate_output(output: Path, expected_names: list[str]) -> str:
    with zipfile.ZipFile(output, "r") as package:
        if package.testzip() is not None:
            raise ValueError("curated package failed ZIP CRC validation")
        names = [info.filename for info in package.infolist()]
        if names != expected_names:
            raise ValueError("curated package changed ZIP entry order or inventory")
    digest = sha256(output.read_bytes())
    if EXPECTED_CURATED_SHA256 != "TO_BE_FILLED" and digest != EXPECTED_CURATED_SHA256:
        raise ValueError(
            f"curated SHA-256 mismatch: expected {EXPECTED_CURATED_SHA256}, got {digest}"
        )
    return digest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    upstream = args.input.read_bytes()
    upstream_digest = sha256(upstream)
    if upstream_digest != EXPECTED_UPSTREAM_SHA256:
        raise ValueError(
            f"upstream SHA-256 mismatch: expected {EXPECTED_UPSTREAM_SHA256}, got {upstream_digest}"
        )
    names, entries = sanitize_entries(args.input)
    write_deterministic_package(args.output, names, entries)
    curated_digest = validate_output(args.output, names)
    print(f"upstream_sha256={upstream_digest}")
    print(f"curated_sha256={curated_digest}")
    print(f"entry_count={len(names)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"sanitize_cats_fixture failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
