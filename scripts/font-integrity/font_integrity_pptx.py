#!/usr/bin/env python3
"""Audit and mutate C11 font-integrity PPTX fixtures using only the stdlib."""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import shutil
import struct
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
RID = f"{{{NS['r']}}}id"
FONT_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
EXPECTED_STYLES = ("regular", "bold", "italic", "boldItalic")
EXPECTED_NAMES = {
    "SW-Font-Master-Footer",
    "SW-Font-Layout-Label",
    "SW-Font-Mixed-Runs",
    "SW-Font-Editable-Group",
    "SW-Font-Native-Table",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_sfnt_metadata(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 12:
        raise ValueError("font is shorter than an SFNT header")
    num_tables = struct.unpack_from(">H", data, 4)[0]
    tables = {}
    for index in range(num_tables):
        base = 12 + index * 16
        if base + 16 > len(data):
            raise ValueError("font table directory is truncated")
        tag, _checksum, offset, length = struct.unpack_from(">4sIII", data, base)
        if offset + length > len(data):
            raise ValueError(f"font table {tag!r} extends beyond the file")
        tables[tag.decode("latin1")] = (offset, length)
    if "OS/2" not in tables or "name" not in tables:
        raise ValueError("font lacks required OS/2 or name table")
    os2_offset, os2_length = tables["OS/2"]
    if os2_length < 10:
        raise ValueError("OS/2 table is too short for fsType")
    fs_type = struct.unpack_from(">H", data, os2_offset + 8)[0]

    name_offset, name_length = tables["name"]
    if name_length < 6:
        raise ValueError("name table is truncated")
    _format, count, string_offset = struct.unpack_from(">HHH", data, name_offset)
    families = set()
    for index in range(count):
        base = name_offset + 6 + index * 12
        if base + 12 > name_offset + name_length:
            raise ValueError("name record is truncated")
        platform, _encoding, _language, name_id, length, offset = struct.unpack_from(">HHHHHH", data, base)
        if name_id not in (1, 16):
            continue
        start = name_offset + string_offset + offset
        raw = data[start : start + length]
        try:
            value = raw.decode("utf-16-be" if platform in (0, 3) else "mac_roman")
        except UnicodeDecodeError:
            continue
        if value:
            families.add(value)
    return {"bytes": len(data), "fsType": fs_type, "families": sorted(families)}


def audit_fixture(fixture_dir: Path, manifest: dict, diagnostics: list[dict]) -> list[dict]:
    records = []
    license_path = fixture_dir / manifest["license"]["file"]
    if not license_path.is_file() or sha256_file(license_path) != manifest["license"]["sha256"]:
        diagnostics.append({"ruleId": "SWF101", "message": "Font license file is missing or does not match its bound SHA-256."})
    if manifest["license"].get("spdx") != "OFL-1.1":
        diagnostics.append({"ruleId": "SWF102", "message": "Font fixture does not declare the required redistributable OFL-1.1 license."})
    for font in manifest.get("fonts", []):
        path = fixture_dir / font["file"]
        record = {"style": font["style"], "file": font["file"], "sha256": None, "sfnt": None}
        if not path.is_file():
            diagnostics.append({"ruleId": "SWF103", "message": f"Licensed fixture font is missing: {font['file']}"})
            records.append(record)
            continue
        record["sha256"] = sha256_file(path)
        if record["sha256"] != font["sha256"]:
            diagnostics.append({"ruleId": "SWF104", "message": f"Licensed fixture font hash changed: {font['file']}"})
        try:
            record["sfnt"] = read_sfnt_metadata(path)
        except ValueError as error:
            diagnostics.append({"ruleId": "SWF105", "message": f"Invalid fixture font {font['file']}: {error}"})
            records.append(record)
            continue
        if record["sfnt"]["fsType"] != manifest.get("expectedFsType"):
            diagnostics.append({"ruleId": "SWF106", "message": f"Fixture font embedding permission changed for {font['file']}: fsType={record['sfnt']['fsType']}"})
        if manifest["family"] not in record["sfnt"]["families"]:
            diagnostics.append({"ruleId": "SWF107", "message": f"Fixture font family identity changed for {font['file']}."})
        records.append(record)
    if {record["style"] for record in records} != set(EXPECTED_STYLES):
        diagnostics.append({"ruleId": "SWF108", "message": "Fixture does not bind exactly the regular, bold, italic, and boldItalic styles."})
    return records


def normalized_target(source_part: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(source_part), target)).lstrip("/")


def explicit_typefaces(root: ET.Element) -> list[str]:
    values = []
    for node in root.iter():
        local = node.tag.rsplit("}", 1)[-1]
        if local in {"latin", "ea", "cs", "sym", "rPr", "defRPr", "endParaRPr"} and node.get("typeface"):
            values.append(node.get("typeface"))
    return values


def style_fingerprint(zip_file: zipfile.ZipFile, parts: list[str]) -> tuple[str, dict]:
    records = []
    counts = {"regular": 0, "bold": 0, "italic": 0, "boldItalic": 0}
    for part in sorted(parts):
        root = ET.fromstring(zip_file.read(part))
        for node in root.iter():
            local = node.tag.rsplit("}", 1)[-1]
            if local not in {"rPr", "defRPr", "endParaRPr"}:
                continue
            family = None
            for child in node:
                if child.tag.rsplit("}", 1)[-1] == "latin" and child.get("typeface"):
                    family = child.get("typeface")
                    break
            family = family or node.get("typeface")
            bold = node.get("b") in {"1", "true"}
            italic = node.get("i") in {"1", "true"}
            if family:
                key = "boldItalic" if bold and italic else "bold" if bold else "italic" if italic else "regular"
                counts[key] += 1
                records.append({"part": part, "family": family, "size": node.get("sz"), "bold": bold, "italic": italic})
    canonical = json.dumps(records, sort_keys=True, separators=(",", ":")).encode()
    return sha256_bytes(canonical), counts


def audit_pptx(pptx: Path, fixture_dir: Path, manifest: dict) -> dict:
    diagnostics: list[dict] = []
    fixture_fonts = audit_fixture(fixture_dir, manifest, diagnostics)
    result = {
        "schemaVersion": 1,
        "valid": False,
        "pptx": str(pptx.resolve()),
        "pptxSha256": None,
        "family": manifest["family"],
        "licensedFixture": {"valid": False, "fonts": fixture_fonts},
        "embedding": {"styles": {}, "partCount": 0, "uniquePartHashes": 0},
        "visibleText": {"slideCount": 0, "explicitTypefaceCount": 0, "typefaces": [], "styleCounts": {}, "styleFingerprint": None},
        "nativeStructure": {"tableCount": 0, "groupCount": 0, "requiredNamesFound": []},
        "diagnostics": diagnostics,
    }
    if not pptx.is_file():
        diagnostics.append({"ruleId": "SWF110", "message": f"PPTX does not exist: {pptx}"})
        return result
    result["pptxSha256"] = sha256_file(pptx)
    try:
        with zipfile.ZipFile(pptx) as archive:
            broken = archive.testzip()
            if broken:
                diagnostics.append({"ruleId": "SWF111", "message": f"PPTX ZIP member failed CRC: {broken}"})
                return result
            names = set(archive.namelist())
            for required in ("ppt/presentation.xml", "ppt/_rels/presentation.xml.rels", "[Content_Types].xml"):
                if required not in names:
                    diagnostics.append({"ruleId": "SWF112", "message": f"PPTX lacks required part: {required}"})
            if diagnostics:
                return result

            presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
            rels_root = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
            relationships = {node.get("Id"): node for node in rels_root.findall("rel:Relationship", NS)}
            embedded_families = presentation.findall("p:embeddedFontLst/p:embeddedFont", NS)
            matching = [node for node in embedded_families if (node.find("p:font", NS) is not None and node.find("p:font", NS).get("typeface") == manifest["family"])]
            if len(matching) != 1:
                diagnostics.append({"ruleId": "SWF120", "message": f"Expected exactly one embedded family record for {manifest['family']}; found {len(matching)}."})
            else:
                part_hashes = set()
                for style in EXPECTED_STYLES:
                    style_node = matching[0].find(f"p:{style}", NS)
                    if style_node is None or not style_node.get(RID):
                        diagnostics.append({"ruleId": "SWF121", "message": f"Embedded family is missing the {style} relationship."})
                        continue
                    rel_id = style_node.get(RID)
                    rel = relationships.get(rel_id)
                    if rel is None or rel.get("Type") != FONT_REL:
                        diagnostics.append({"ruleId": "SWF122", "message": f"Embedded {style} relationship {rel_id} is missing or has the wrong type."})
                        continue
                    target = normalized_target("ppt/presentation.xml", rel.get("Target"))
                    if target not in names:
                        diagnostics.append({"ruleId": "SWF123", "message": f"Embedded {style} font part is missing: {target}"})
                        continue
                    payload = archive.read(target)
                    payload_hash = sha256_bytes(payload)
                    if len(payload) < 50_000:
                        diagnostics.append({"ruleId": "SWF124", "message": f"Embedded {style} font payload is implausibly small ({len(payload)} bytes)."})
                    part_hashes.add(payload_hash)
                    result["embedding"]["styles"][style] = {"relationshipId": rel_id, "part": target, "bytes": len(payload), "sha256": payload_hash}
                result["embedding"]["partCount"] = len(result["embedding"]["styles"])
                result["embedding"]["uniquePartHashes"] = len(part_hashes)
                if len(part_hashes) != 4:
                    diagnostics.append({"ruleId": "SWF125", "message": "The four embedded styles do not have four distinct payloads."})

            slide_parts = sorted(name for name in names if name.startswith("ppt/slides/slide") and name.endswith(".xml"))
            structure_parts = slide_parts + sorted(name for name in names if name.startswith(("ppt/slideMasters/slideMaster", "ppt/slideLayouts/slideLayout")) and name.endswith(".xml"))
            slide_typefaces = []
            shape_names = set()
            table_count = 0
            group_count = 0
            for part in structure_parts:
                root = ET.fromstring(archive.read(part))
                for node in root.iter():
                    local = node.tag.rsplit("}", 1)[-1]
                    if local == "cNvPr" and node.get("name"):
                        shape_names.add(node.get("name"))
                    elif local == "tbl":
                        table_count += 1
                    elif local == "grpSp":
                        group_count += 1
                if part in slide_parts:
                    slide_typefaces.extend(explicit_typefaces(root))
            unexpected = sorted(set(slide_typefaces) - {manifest["family"]})
            if unexpected:
                diagnostics.append({"ruleId": "SWF130", "message": f"Visible slide text requests an unexpected or substituted font family: {', '.join(unexpected)}"})
            if len(slide_typefaces) < 20:
                diagnostics.append({"ruleId": "SWF131", "message": f"Complex fixture has too few explicit visible font bindings: {len(slide_typefaces)}"})
            fingerprint, style_counts = style_fingerprint(archive, structure_parts)
            for style in EXPECTED_STYLES:
                if style_counts[style] < 1:
                    diagnostics.append({"ruleId": "SWF132", "message": f"Complex fixture lacks an explicit {style} text run."})
            missing_names = sorted(EXPECTED_NAMES - shape_names)
            if missing_names:
                diagnostics.append({"ruleId": "SWF133", "message": f"Complex template/font structure lost named native objects: {', '.join(missing_names)}"})
            if table_count < 1 or group_count < 1:
                diagnostics.append({"ruleId": "SWF134", "message": "Complex fixture lost its native table or editable group."})
            result["visibleText"] = {
                "slideCount": len(slide_parts),
                "explicitTypefaceCount": len(slide_typefaces),
                "typefaces": sorted(set(slide_typefaces)),
                "styleCounts": style_counts,
                "styleFingerprint": fingerprint,
            }
            result["nativeStructure"] = {
                "tableCount": table_count,
                "groupCount": group_count,
                "requiredNamesFound": sorted(EXPECTED_NAMES & shape_names),
            }
    except (OSError, zipfile.BadZipFile, ET.ParseError, KeyError, ValueError) as error:
        diagnostics.append({"ruleId": "SWF199", "message": f"Font-integrity audit could not inspect the PPTX: {error}"})

    result["licensedFixture"]["valid"] = not any(item["ruleId"].startswith("SWF10") for item in diagnostics)
    result["valid"] = len(diagnostics) == 0
    return result


def rewrite_zip(source: Path, target: Path, transform) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source, "r") as src, zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            replacement = transform(info.filename, data)
            if replacement is None:
                continue
            dst.writestr(info, replacement)


def mutate_pptx(source: Path, target: Path, mode: str, family: str) -> None:
    changed = False

    def transform(name: str, data: bytes):
        nonlocal changed
        if mode == "remove-embedded" and not changed and name.startswith("ppt/fonts/"):
            changed = True
            return None
        if mode == "truncate-embedded" and not changed and name.startswith("ppt/fonts/"):
            changed = True
            return data[:64]
        if mode == "substitute-visible" and name == "ppt/slides/slide1.xml":
            root = ET.fromstring(data)
            for node in root.iter():
                local = node.tag.rsplit("}", 1)[-1]
                if local in {"latin", "rPr", "defRPr", "endParaRPr"} and node.get("typeface") == family:
                    node.set("typeface", "Slidewright Definitely Missing Sans 9F24")
                    changed = True
                    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
        return data

    rewrite_zip(source, target, transform)
    if not changed:
        target.unlink(missing_ok=True)
        raise ValueError(f"Mutation {mode} did not find a target in {source}")


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    audit_parser = subparsers.add_parser("audit")
    audit_parser.add_argument("pptx", type=Path)
    audit_parser.add_argument("--fixture-dir", type=Path, required=True)
    audit_parser.add_argument("--manifest", type=Path, required=True)
    audit_parser.add_argument("--json", type=Path, required=True)
    mutate_parser = subparsers.add_parser("mutate")
    mutate_parser.add_argument("pptx", type=Path)
    mutate_parser.add_argument("--out", type=Path, required=True)
    mutate_parser.add_argument("--mode", choices=("remove-embedded", "truncate-embedded", "substitute-visible"), required=True)
    mutate_parser.add_argument("--family", required=True)
    args = parser.parse_args()

    if args.command == "mutate":
        mutate_pptx(args.pptx, args.out, args.mode, args.family)
        return 0

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    result = audit_pptx(args.pptx, args.fixture_dir, manifest)
    write_json(args.json, result)
    if result["valid"]:
        print(f"Font-integrity audit passed: {args.pptx}")
        return 0
    print(f"Font-integrity audit rejected {args.pptx}: " + "; ".join(item["message"] for item in result["diagnostics"]), file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
