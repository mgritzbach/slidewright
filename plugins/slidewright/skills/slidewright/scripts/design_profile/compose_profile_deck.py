#!/usr/bin/env python3
"""Compose a new native PPTX from source-bound slide archetypes.

This is the bounded g22-v2 path. It clones selected source slide XML and
relationships, applies only identity-bound native-placeholder text edits,
preserves the source presentation/master/layout/theme graph, and removes every
package part that is no longer reachable from the new presentation.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import sys
import tempfile
import uuid
import zipfile
from hashlib import sha256
from pathlib import Path
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).parents[1] / "template"))
from edit_template import rewrite_shape_text  # noqa: E402


P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
EP = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
VT = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
SLIDE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"
SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
SHA256 = re.compile(r"^[0-9a-f]{64}$", re.I)
UUID_NAMESPACE = uuid.UUID("13a208b4-33e7-5e8e-b935-f2caa769b42b")

class CompositionError(ValueError):
    pass


def digest_bytes(value: bytes) -> str:
    return sha256(value).hexdigest()


def digest_path(value: Path) -> str:
    return digest_bytes(value.read_bytes())


def canonical_hash(value: object) -> str:
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def rels_part(part: str) -> str:
    if not part:
        return "_rels/.rels"
    directory, name = posixpath.split(part)
    return posixpath.join(directory, "_rels", name + ".rels")


def resolve_target(owner: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)).lstrip("/")


def relationships(payload: bytes, owner: str) -> list[tuple[str, str, str, bool]]:
    root = ET.fromstring(payload)
    result = []
    for node in root.findall(f"{{{PR}}}Relationship"):
        external = node.get("TargetMode") == "External"
        target = node.get("Target", "")
        result.append((node.get("Id", ""), node.get("Type", ""), target if external else resolve_target(owner, target), external))
    return result


def reachable_parts(parts: dict[str, bytes]) -> set[str]:
    if "_rels/.rels" not in parts:
        raise CompositionError("Package root relationships are missing.")
    reachable = {"[Content_Types].xml", "_rels/.rels"}
    queue = [target for _id, _type, target, external in relationships(parts["_rels/.rels"], "") if not external]
    while queue:
        part = queue.pop(0)
        if part in reachable:
            continue
        if part not in parts:
            raise CompositionError(f"Reachable relationship target is missing: {part}")
        reachable.add(part)
        rel_part = rels_part(part)
        if rel_part not in parts:
            continue
        reachable.add(rel_part)
        for _id, _type, target, external in relationships(parts[rel_part], part):
            if not external and target not in reachable:
                queue.append(target)
    return reachable


def validate_plan(plan: dict, source_hash: str) -> list[dict]:
    if plan.get("derivationVersion") != "g22-v2" or plan.get("mode") != "compose-source-archetypes":
        raise CompositionError("Plan must use g22-v2 compose-source-archetypes mode.")
    if str(plan.get("sourceSha256", "")).lower() != source_hash:
        raise CompositionError("Plan sourceSha256 does not match the source PPTX.")
    rights = plan.get("sourceRights")
    if not isinstance(rights, dict) or rights.get("basis") not in {"licensed", "user-provided-authorized"}:
        raise CompositionError("Plan lacks an explicit accepted source-rights basis.")
    slides = plan.get("slides")
    if not isinstance(slides, list) or len(slides) < 2:
        raise CompositionError("Composition plan must declare at least two output slides.")
    if plan.get("outputSlideCount") != len(slides):
        raise CompositionError("Composition plan outputSlideCount does not close.")
    for index, slide in enumerate(slides, 1):
        if slide.get("outputSlide") != index:
            raise CompositionError("Composition plan outputSlide values must be contiguous and ordered.")
        source_part = slide.get("sourceSlidePart")
        if not isinstance(source_part, str) or not re.fullmatch(r"ppt/slides/slide\d+\.xml", source_part):
            raise CompositionError(f"Output slide {index} has an invalid sourceSlidePart.")
        if not isinstance(slide.get("edits"), list) or not slide["edits"]:
            raise CompositionError(f"Output slide {index} must declare native placeholder edits.")
    return slides


def rebase_slide_identity(xml: str, source_hash: str, output_slide: int) -> tuple[str, int]:
    count = 0

    def guid(kind: str, ordinal: int, original: str) -> str:
        return "{" + str(uuid.uuid5(UUID_NAMESPACE, f"{source_hash}:{output_slide}:{kind}:{ordinal}:{original}" )).upper() + "}"

    def replace_guid(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        return match.group(1) + guid("creation", count, match.group(2)) + match.group(3)

    xml = re.sub(r'(<a16:creationId\b[^>]*\bid=")([^\"]+)(")', replace_guid, xml)
    xml = re.sub(r'(<a:fld\b[^>]*\bid=")([^\"]+)(")', replace_guid, xml)

    def replace_numeric(match: re.Match[str]) -> str:
        nonlocal count
        count += 1
        value = int.from_bytes(sha256(f"{source_hash}:{output_slide}:slide:{count}:{match.group(2)}".encode()).digest()[:4], "big") & 0x7FFFFFFF
        return match.group(1) + str(value or 1) + match.group(3)

    xml = re.sub(r'(<p14:creationId\b[^>]*\bval=")(\d+)(")', replace_numeric, xml)
    field = re.compile(r'(<a:fld\b[^>]*\btype="slidenum"[^>]*>.*?<a:t>)(.*?)(</a:t>.*?</a:fld>)', re.S)
    xml = field.sub(lambda match: match.group(1) + str(output_slide) + match.group(3), xml)
    return xml, count


def rewrite_presentation(payload: bytes, count: int, relationship_ids: list[str]) -> bytes:
    ET.register_namespace("p", P)
    ET.register_namespace("r", R)
    root = ET.fromstring(payload)
    slide_list = root.find(f"{{{P}}}sldIdLst")
    if slide_list is None:
        slide_list = ET.Element(f"{{{P}}}sldIdLst")
        master_list = root.find(f"{{{P}}}sldMasterIdLst")
        root.insert(list(root).index(master_list) + 1 if master_list is not None else 0, slide_list)
    slide_list.clear()
    for index, rel_id in enumerate(relationship_ids):
        ET.SubElement(slide_list, f"{{{P}}}sldId", {"id": str(256 + index), f"{{{R}}}id": rel_id})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def rewrite_presentation_rels(payload: bytes, count: int) -> tuple[bytes, list[str]]:
    ET.register_namespace("", PR)
    root = ET.fromstring(payload)
    for node in list(root):
        if node.get("Type") == SLIDE_REL:
            root.remove(node)
    used = {node.get("Id", "") for node in root}
    numeric = [int(match.group(1)) for value in used if (match := re.fullmatch(r"rId(\d+)", value))]
    next_id = max(numeric, default=0) + 1
    rel_ids = []
    for index in range(1, count + 1):
        while f"rId{next_id}" in used:
            next_id += 1
        rel_id = f"rId{next_id}"
        next_id += 1
        used.add(rel_id)
        rel_ids.append(rel_id)
        ET.SubElement(root, f"{{{PR}}}Relationship", {"Id": rel_id, "Type": SLIDE_REL, "Target": f"slides/slide{index}.xml"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True), rel_ids


def rewrite_content_types(payload: bytes, slide_count: int) -> bytes:
    # System.IO.Packaging expects the OPC content-types namespace on the
    # unprefixed root.  ElementTree's generated ``ns0:Types`` form is generic
    # XML-equivalent but is rejected by PowerPoint/Open XML readers.
    ET.register_namespace("", CT)
    root = ET.fromstring(payload)
    for node in list(root):
        if node.tag == f"{{{CT}}}Override" and node.get("ContentType") == SLIDE_CONTENT_TYPE:
            root.remove(node)
    for index in range(1, slide_count + 1):
        ET.SubElement(root, f"{{{CT}}}Override", {"PartName": f"/ppt/slides/slide{index}.xml", "ContentType": SLIDE_CONTENT_TYPE})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def rewrite_app_properties(payload: bytes, slide_count: int) -> bytes:
    ET.register_namespace("", EP)
    ET.register_namespace("vt", VT)
    root = ET.fromstring(payload)
    slides = root.find(f"{{{EP}}}Slides")
    if slides is not None:
        slides.text = str(slide_count)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def deterministic_zip(out: Path, parts: dict[str, bytes]) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False, dir=out.parent) as handle:
        temporary = Path(handle.name)
    try:
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name in sorted(parts):
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o600 << 16
                archive.writestr(info, parts[name])
        temporary.replace(out)
    finally:
        temporary.unlink(missing_ok=True)


def compose(source: Path, plan_path: Path, out: Path) -> dict:
    source_hash = digest_path(source)
    plan_bytes = plan_path.read_bytes()
    plan = json.loads(plan_bytes.decode("utf-8-sig"))
    slides = validate_plan(plan, source_hash)
    with zipfile.ZipFile(source) as archive:
        original = {item.filename: archive.read(item.filename) for item in archive.infolist()}
    required = {"[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"}
    missing = sorted(required - set(original))
    if missing:
        raise CompositionError("Source package lacks required parts: " + ", ".join(missing))

    parts = {name: payload for name, payload in original.items() if not re.fullmatch(r"ppt/slides/(?:_rels/)?slide\d+\.xml(?:\.rels)?", name)}
    mappings = []
    for index, item in enumerate(slides, 1):
        source_part = item["sourceSlidePart"]
        if source_part not in original:
            raise CompositionError(f"Source slide part is missing: {source_part}")
        source_rels = rels_part(source_part)
        if source_rels in original:
            for _rel_id, rel_type, target, external in relationships(original[source_rels], source_part):
                if not external and (rel_type.endswith("/notesSlide") or rel_type.endswith("/slide")):
                    raise CompositionError(f"Source slide {source_part} has unsupported slide-local relationship {rel_type}.")
        xml = original[source_part].decode("utf-8")
        for edit in item["edits"]:
            xml = rewrite_shape_text(xml, edit, source_part)
        xml, rebased = rebase_slide_identity(xml, source_hash, index)
        destination = f"ppt/slides/slide{index}.xml"
        destination_rels = rels_part(destination)
        parts[destination] = xml.encode("utf-8")
        if source_rels in original:
            parts[destination_rels] = original[source_rels]
        layout_targets = [target for _id, rel_type, target, external in relationships(parts.get(destination_rels, b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'), destination) if not external and rel_type.endswith("/slideLayout")]
        if len(layout_targets) != 1:
            raise CompositionError(f"Composed slide {index} must resolve exactly one source layout relationship.")
        mappings.append({
            "outputSlide": index,
            "outputSlidePart": destination,
            "sourceSlide": item["sourceSlide"],
            "sourceSlidePart": source_part,
            "archetypeId": item["archetypeId"],
            "layoutPart": layout_targets[0],
            "editedShapes": [edit["shapeName"] for edit in item["edits"]],
            "identityValuesRebased": rebased,
            "sourceSlideSha256": digest_bytes(original[source_part]),
            "outputSlideSha256": digest_bytes(parts[destination]),
            "relationshipSha256": digest_bytes(parts[destination_rels]) if destination_rels in parts else None,
        })

    presentation_rels, relationship_ids = rewrite_presentation_rels(parts["ppt/_rels/presentation.xml.rels"], len(slides))
    parts["ppt/_rels/presentation.xml.rels"] = presentation_rels
    parts["ppt/presentation.xml"] = rewrite_presentation(parts["ppt/presentation.xml"], len(slides), relationship_ids)
    parts["[Content_Types].xml"] = rewrite_content_types(parts["[Content_Types].xml"], len(slides))
    if "docProps/app.xml" in parts:
        parts["docProps/app.xml"] = rewrite_app_properties(parts["docProps/app.xml"], len(slides))

    reachable = reachable_parts(parts)
    removed = sorted(set(parts) - reachable)
    parts = {name: payload for name, payload in parts.items() if name in reachable}
    if set(parts) != reachable:
        raise CompositionError("Reachable-part closure did not close exactly.")
    report = {
        "schemaVersion": "slidewright-profile-composition-provenance/v1",
        "valid": True,
        "mode": "compose-source-archetypes",
        "sourceFileName": source.name,
        "sourceSha256": source_hash,
        "planSha256": digest_bytes(plan_bytes),
        "profileId": slides[0].get("designBinding", {}).get("profileId"),
        "sourceRights": plan["sourceRights"],
        "sourceSlideCount": plan.get("sourceSlideCount"),
        "outputSlideCount": len(slides),
        "sourcePartCount": len(original),
        "outputPartCount": len(parts),
        "removedUnreachableParts": removed,
        "reachableClosureExact": True,
        "mappings": mappings,
    }
    deterministic_zip(out, parts)
    report["outputSha256"] = digest_path(out)
    report["provenanceSha256"] = canonical_hash(report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Compose a source-native g22-v2 presentation.")
    parser.add_argument("source", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--json", required=True, type=Path)
    args = parser.parse_args()
    try:
        report = compose(args.source.resolve(), args.plan.resolve(), args.out.resolve())
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps(report, indent=2))
        return 0
    except (OSError, json.JSONDecodeError, zipfile.BadZipFile, ET.ParseError, CompositionError, ValueError) as error:
        print(f"profile composition failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
