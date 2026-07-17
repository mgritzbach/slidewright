#!/usr/bin/env python3
"""Create tiny deterministic OPC packages for repair-free auditor tests."""

from __future__ import annotations

import argparse
import struct
import zipfile
from pathlib import Path


FIXED_TIME = (2000, 1, 1, 0, 0, 0)


def content_types(include_png: bool = True) -> bytes:
    png = '<Default Extension="png" ContentType="image/png"/>' if include_png else ""
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  {png}
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>'''.encode()


def rels(items: str) -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{items}</Relationships>'''.encode()


def parts(mode: str) -> list[tuple[str, bytes]]:
    slide_reference = "rIdMissing" if mode == "dangling-reference" else "rIdImage1"
    image_target = "../media/missing.png" if mode == "missing-target" else "../media/image1.png"
    image_id = "" if mode == "empty-id" else "rIdImage1"
    image_relationships = f'<Relationship Id="{image_id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="{image_target}"/>'
    if mode == "duplicate-id":
        image_relationships += '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png#duplicate"/>'
    slide = f'''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree/><p:ext r:id="{slide_reference}"/></p:cSld></p:sld>'''.encode()
    if mode == "invalid-xml":
        slide = b'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><broken></p:sld>'
    entries = [
        ("[Content_Types].xml", content_types(mode != "missing-content-type")),
        ("_rels/.rels", rels('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>')),
        ("ppt/presentation.xml", b'<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'),
        ("ppt/_rels/presentation.xml.rels", rels('<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>')),
        ("ppt/slides/slide1.xml", slide),
        ("ppt/slides/_rels/slide1.xml.rels", rels(image_relationships)),
        ("ppt/media/image1.png", b"slidewright-test-image"),
    ]
    if mode == "orphan-owner":
        entries.append(("ppt/orphan/_rels/missing.xml.rels", rels("")))
    if mode == "duplicate-part":
        entries.append(("ppt/media/image1.png", b"duplicate"))
    return entries


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--mode", default="valid")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.mode == "corrupt-zip":
        args.output.write_bytes(b"not a zip archive")
        return
    with zipfile.ZipFile(args.output, "w") as archive:
        for name, data in parts(args.mode):
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    if args.mode == "crc-corrupt":
        with zipfile.ZipFile(args.output) as archive:
            item = archive.getinfo("ppt/media/image1.png")
            header_offset = item.header_offset
        with args.output.open("r+b") as package:
            package.seek(header_offset)
            header = package.read(30)
            signature, *_, filename_length, extra_length = struct.unpack("<IHHHHHIIIHH", header)
            if signature != 0x04034B50:
                raise ValueError("unexpected ZIP local header signature")
            data_offset = header_offset + 30 + filename_length + extra_length
            package.seek(data_offset)
            original = package.read(1)
            package.seek(data_offset)
            package.write(bytes([original[0] ^ 0xFF]))


if __name__ == "__main__":
    main()
