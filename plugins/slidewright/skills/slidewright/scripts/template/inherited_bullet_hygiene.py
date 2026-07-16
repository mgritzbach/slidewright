#!/usr/bin/env python3
"""Remove only empty paragraphs from one source-bound inherited-bullet placeholder."""

from __future__ import annotations

import argparse
import json
import posixpath
import shutil
import tempfile
import zipfile
from hashlib import sha256
from pathlib import Path

from lxml import etree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
}
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
BULLET_TAGS = {
    f"{{{NS['a']}}}buChar",
    f"{{{NS['a']}}}buAutoNum",
    f"{{{NS['a']}}}buBlip",
}


def digest(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def canonical(element: ET._Element) -> bytes:
    return ET.tostring(element, method="c14n", with_comments=False)


def paragraph_text(paragraph: ET._Element) -> str:
    return "".join(paragraph.xpath(".//a:t/text()", namespaces=NS)).replace("\u00a0", " ")


def placeholder_key(shape: ET._Element) -> tuple[str, str] | None:
    placeholder = shape.find("./p:nvSpPr/p:nvPr/p:ph", NS)
    if placeholder is None:
        return None
    return placeholder.get("type", "body"), placeholder.get("idx", "0")


def named_shape(root: ET._Element, shape_name: str) -> ET._Element:
    matches = [
        shape
        for shape in root.findall(".//p:sp", NS)
        if (shape.find("./p:nvSpPr/p:cNvPr", NS) is not None)
        and shape.find("./p:nvSpPr/p:cNvPr", NS).get("name") == shape_name
    ]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one shape named {shape_name!r}; found {len(matches)}.")
    return matches[0]


def related_part(archive: zipfile.ZipFile, source_part: str, relationship_type_suffix: str) -> str:
    source = Path(source_part)
    rels_part = str(source.parent / "_rels" / f"{source.name}.rels").replace("\\", "/")
    root = ET.fromstring(archive.read(rels_part))
    matches = [
        relationship.get("Target")
        for relationship in root.findall("./pr:Relationship", NS)
        if relationship.get("Type", "").endswith(relationship_type_suffix)
    ]
    if len(matches) != 1:
        raise ValueError(f"Expected one {relationship_type_suffix} relationship from {source_part}; found {len(matches)}.")
    target = posixpath.normpath(posixpath.join(source.parent.as_posix(), matches[0]))
    if not target.startswith("ppt/"):
        raise ValueError(f"Could not normalize related part {target!r}.")
    return target


def level_properties(container: ET._Element | None, level: int) -> ET._Element | None:
    if container is None:
        return None
    return container.find(f"./a:lvl{level + 1}pPr", NS)


def bullet_state(properties: ET._Element | None) -> bool | None:
    if properties is None:
        return None
    if properties.find("./a:buNone", NS) is not None:
        return False
    if any(child.tag in BULLET_TAGS for child in properties):
        return True
    return None


def effective_bullet(
    paragraph: ET._Element,
    slide_shape: ET._Element,
    layout_shape: ET._Element,
    master_root: ET._Element,
) -> tuple[bool, str]:
    paragraph_properties = paragraph.find("./a:pPr", NS)
    level = int(paragraph_properties.get("lvl", "0")) if paragraph_properties is not None else 0
    direct = bullet_state(paragraph_properties)
    if direct is not None:
        return direct, "paragraph"
    slide_style = bullet_state(level_properties(slide_shape.find("./p:txBody/a:lstStyle", NS), level))
    if slide_style is not None:
        return slide_style, "slide-placeholder"
    layout_style = bullet_state(level_properties(layout_shape.find("./p:txBody/a:lstStyle", NS), level))
    if layout_style is not None:
        return layout_style, "layout-placeholder"
    master_style = bullet_state(level_properties(master_root.find("./p:txStyles/p:bodyStyle", NS), level))
    if master_style is not None:
        return master_style, "master-body-style"
    return False, "none"


def context(archive: zipfile.ZipFile, plan: dict) -> dict:
    slide_part = f"ppt/slides/slide{int(plan['targetSlide'])}.xml"
    slide_root = ET.fromstring(archive.read(slide_part))
    slide_shape = named_shape(slide_root, plan["shapeName"])
    expected_key = (plan["placeholderType"], str(plan["placeholderIndex"]))
    if placeholder_key(slide_shape) != expected_key:
        raise ValueError(f"Target placeholder mismatch: expected {expected_key}, found {placeholder_key(slide_shape)}.")
    layout_part = related_part(archive, slide_part, "/slideLayout")
    layout_root = ET.fromstring(archive.read(layout_part))
    layout_matches = [shape for shape in layout_root.findall(".//p:sp", NS) if placeholder_key(shape) == expected_key]
    if len(layout_matches) != 1:
        raise ValueError(f"Expected one matching layout placeholder; found {len(layout_matches)}.")
    master_part = related_part(archive, layout_part, "/slideMaster")
    master_root = ET.fromstring(archive.read(master_part))
    return {
        "slidePart": slide_part,
        "slideRoot": slide_root,
        "slideShape": slide_shape,
        "layoutPart": layout_part,
        "layoutShape": layout_matches[0],
        "masterPart": master_part,
        "masterRoot": master_root,
    }


def inspect_placeholder(archive: zipfile.ZipFile, plan: dict) -> dict:
    resolved = context(archive, plan)
    paragraphs = resolved["slideShape"].findall("./p:txBody/a:p", NS)
    records = []
    for index, paragraph in enumerate(paragraphs):
        active, source = effective_bullet(
            paragraph,
            resolved["slideShape"],
            resolved["layoutShape"],
            resolved["masterRoot"],
        )
        records.append({
            "index": index,
            "text": paragraph_text(paragraph),
            "empty": not paragraph_text(paragraph).strip(),
            "bulletActive": active,
            "bulletSource": source,
            "sha256": sha256(canonical(paragraph)).hexdigest(),
        })
    return {**resolved, "paragraphs": paragraphs, "records": records}


def sanitize(source: Path, plan_path: Path, output: Path) -> dict:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    actual_hash = digest(source)
    if plan.get("sourceSha256") != actual_hash:
        raise ValueError(f"Source SHA-256 mismatch: expected {plan.get('sourceSha256')}, found {actual_hash}.")
    with zipfile.ZipFile(source, "r") as archive:
        inspected = inspect_placeholder(archive, plan)
        removable = [
            paragraph
            for paragraph, record in zip(inspected["paragraphs"], inspected["records"], strict=True)
            if record["empty"] and record["bulletActive"] and record["bulletSource"] == plan["expectedBulletSource"]
        ]
        if len(removable) != int(plan["expectedRemovedParagraphs"]):
            raise ValueError(f"Expected {plan['expectedRemovedParagraphs']} removable inherited bullet paragraphs; found {len(removable)}.")
        nonempty_before = [record["sha256"] for record in inspected["records"] if not record["empty"]]
        text_body = inspected["slideShape"].find("./p:txBody", NS)
        for paragraph in removable:
            text_body.remove(paragraph)
        edited_xml = ET.tostring(inspected["slideRoot"], xml_declaration=True, encoding="UTF-8", standalone=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False, dir=output.parent) as handle:
            temporary = Path(handle.name)
        try:
            with zipfile.ZipFile(temporary, "w") as outgoing:
                for item in archive.infolist():
                    payload = edited_xml if item.filename == inspected["slidePart"] else archive.read(item.filename)
                    outgoing.writestr(item, payload)
            shutil.move(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
    with zipfile.ZipFile(output, "r") as archive:
        after = inspect_placeholder(archive, plan)
    nonempty_after = [record["sha256"] for record in after["records"] if not record["empty"]]
    if nonempty_before != nonempty_after:
        raise ValueError("A non-empty paragraph changed while stripping empty inherited bullets.")
    return {
        "source": str(source),
        "sourceSha256": actual_hash,
        "output": str(output),
        "outputSha256": digest(output),
        "targetSlidePart": inspected["slidePart"],
        "shapeName": plan["shapeName"],
        "removedParagraphs": len(removable),
        "remainingParagraphs": len(after["paragraphs"]),
        "remainingEmptyParagraphs": sum(record["empty"] for record in after["records"]),
        "bulletInheritanceSource": plan["expectedBulletSource"],
        "nonemptyParagraphHashesPreserved": nonempty_before == nonempty_after,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("plan")
    parser.add_argument("output")
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    report = sanitize(Path(args.source), Path(args.plan), Path(args.output))
    report_path = Path(args.json)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
