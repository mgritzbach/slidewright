#!/usr/bin/env python3
"""Deterministically normalize generated PPTX packages and embed native-shape metadata."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import tempfile
import uuid
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
CORE_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
DCTERMS_NS = "http://purl.org/dc/terms/"
CREATION_NAMESPACES = {
    "http://schemas.microsoft.com/office/drawing/2014/main",
    "http://schemas.microsoft.com/office/drawing/2010/main",
    "http://schemas.microsoft.com/office/powerpoint/2010/main",
}
FIXED_TIME = "2000-01-01T00:00:00Z"
FIXED_ZIP_TIME = (2000, 1, 1, 0, 0, 0)
CREATION_NAMESPACE = uuid.UUID("f13b695a-45e8-5bd2-8a39-37fa70163b51")

for prefix, namespace in {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": OFFICE_REL_NS,
    "pr": REL_NS,
    "cp": CORE_NS,
    "dc": "http://purl.org/dc/elements/1.1/",
    "dcterms": DCTERMS_NS,
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
    "a16": "http://schemas.microsoft.com/office/drawing/2014/main",
    "a14": "http://schemas.microsoft.com/office/drawing/2010/main",
    "p14": "http://schemas.microsoft.com/office/powerpoint/2010/main",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
}.items():
    ET.register_namespace(prefix, namespace)


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def namespace(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def canonical_json(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def metadata_envelope(payload: dict) -> str:
    raw = canonical_json(payload)
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    digest = hashlib.sha256(raw).hexdigest()
    return f"slidewright-chart:v1:{encoded}:{digest}"


def owner_for_relationship_part(name: str) -> str | None:
    if name == "_rels/.rels":
        return None
    marker = "/_rels/"
    if marker not in name or not name.endswith(".rels"):
        raise ValueError(f"Invalid relationship part path: {name}")
    directory, filename = name.split(marker, 1)
    return f"{directory}/{filename[:-5]}"


def relationship_key(element: ET.Element) -> tuple[str, str, str]:
    return (
        element.get("Type", ""),
        element.get("TargetMode", ""),
        element.get("Target", ""),
    )


def normalize_relationships(roots: dict[str, ET.Element]) -> dict[str, list[tuple[str, str, str]]]:
    summaries: dict[str, list[tuple[str, str, str]]] = {}
    for part in sorted(name for name in roots if name.endswith(".rels")):
        root = roots[part]
        relationships = list(root)
        keys = [relationship_key(item) for item in relationships]
        if len(keys) != len(set(keys)):
            raise ValueError(f"Relationship part has duplicate semantic tuples: {part}")
        ordered = sorted(relationships, key=relationship_key)
        id_map: dict[str, str] = {}
        for index, item in enumerate(ordered, start=1):
            old_id = item.get("Id", "")
            new_id = f"rId{index}"
            id_map[old_id] = new_id
            item.set("Id", new_id)
        root[:] = ordered
        summaries[part] = [relationship_key(item) for item in ordered]
        owner = owner_for_relationship_part(part)
        if owner and owner in roots:
            for element in roots[owner].iter():
                for attribute, value in list(element.attrib.items()):
                    if namespace(attribute) == OFFICE_REL_NS and value in id_map:
                        element.set(attribute, id_map[value])
    return summaries


def normalize_core(root: ET.Element) -> None:
    for child in root:
        if namespace(child.tag) == DCTERMS_NS and local_name(child.tag) in {"created", "modified"}:
            child.text = FIXED_TIME
        if namespace(child.tag) == CORE_NS and local_name(child.tag) == "revision":
            child.text = "1"


def normalize_creation_ids(part: str, root: ET.Element) -> None:
    counter = 0
    for element in root.iter():
        if local_name(element.tag) != "creationId" or namespace(element.tag) not in CREATION_NAMESPACES:
            continue
        counter += 1
        deterministic = uuid.uuid5(CREATION_NAMESPACE, f"{part}:{counter}")
        value = "{" + str(deterministic).upper() + "}"
        if "val" in element.attrib:
            numeric = int.from_bytes(hashlib.sha256(f"{part}:{counter}:val".encode("utf-8")).digest()[:4], "big")
            element.set("val", str(numeric))
        elif "id" in element.attrib:
            element.set("id", value)
        else:
            element.set("id", value)


def metadata_index(metadata: dict | None) -> dict[tuple[int, str], dict]:
    result: dict[tuple[int, str], dict] = {}
    for slide in (metadata or {}).get("slides", []):
        slide_index = int(slide["slideIndex"])
        for shape in slide.get("shapes", []):
            key = (slide_index, shape["id"])
            if key in result:
                raise ValueError(f"Duplicate metadata target: slide {slide_index} {shape['id']}")
            result[key] = shape
    return result


def embed_metadata(part: str, root: ET.Element, index: dict[tuple[int, str], dict]) -> None:
    if not part.startswith("ppt/slides/slide") or not part.endswith(".xml"):
        return
    slide_index = int(part.removeprefix("ppt/slides/slide").removesuffix(".xml"))
    found: set[tuple[int, str]] = set()
    for element in root.iter():
        if local_name(element.tag) != "cNvPr":
            continue
        key = (slide_index, element.get("name", ""))
        if key not in index:
            continue
        record = index[key]
        payload = record["payload"]
        element.set("descr", metadata_envelope(payload))
        element.set("title", record.get("title", "Slidewright semantic metadata"))
        found.add(key)
    expected = {key for key in index if key[0] == slide_index}
    if found != expected:
        missing = sorted(name for _, name in expected - found)
        raise ValueError(f"Metadata targets were not found on slide {slide_index}: {missing}")


def normalize_package(input_path: Path, output_path: Path, metadata: dict | None) -> dict:
    with zipfile.ZipFile(input_path) as source:
        source_names = [item.filename for item in source.infolist() if not item.is_dir()]
        if len(source_names) != len(set(source_names)):
            raise ValueError("PPTX contains duplicate package part names.")
        parts = {name: source.read(name) for name in source_names}

    roots: dict[str, ET.Element] = {}
    for name, data in parts.items():
        if name.endswith(".xml") or name.endswith(".rels"):
            roots[name] = ET.fromstring(data)

    relationships = normalize_relationships(roots)
    if "docProps/core.xml" in roots:
        normalize_core(roots["docProps/core.xml"])
    annotations = metadata_index(metadata)
    for name, root in roots.items():
        embed_metadata(name, root, annotations)
        normalize_creation_ids(name, root)
        if name == "[Content_Types].xml":
            ET.register_namespace("", CONTENT_TYPES_NS)
        elif name.endswith(".rels"):
            ET.register_namespace("", REL_NS)
        else:
            ET.register_namespace("pr", REL_NS)
            ET.register_namespace("ct", CONTENT_TYPES_NS)
        parts[name] = ET.tostring(root, encoding="utf-8", xml_declaration=True)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(prefix=".slidewright-normalize-", suffix=".pptx", dir=output_path.parent)
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
            for name in sorted(parts):
                info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 0
                info.external_attr = 0
                target.writestr(info, parts[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        os.replace(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)

    return {
        "valid": True,
        "partCount": len(parts),
        "metadataShapeCount": len(annotations),
        "relationshipParts": len(relationships),
        "sha256": hashlib.sha256(output_path.read_bytes()).hexdigest(),
        "normalizations": [
            "deterministic relationship IDs and owner references",
            "fixed core created/modified timestamps and revision",
            "deterministic Office creation IDs",
            "sorted package entries with fixed ZIP metadata",
            "canonical native-shape chart descriptions",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--out")
    parser.add_argument("--metadata-json")
    parser.add_argument("--report-json")
    args = parser.parse_args()
    input_path = Path(args.input).resolve()
    output_path = Path(args.out).resolve() if args.out else input_path
    metadata = json.loads(Path(args.metadata_json).read_text(encoding="utf-8")) if args.metadata_json else None
    report = normalize_package(input_path, output_path, metadata)
    if args.report_json:
        report_path = Path(args.report_json)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
