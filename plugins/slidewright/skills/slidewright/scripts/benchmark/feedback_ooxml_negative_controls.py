#!/usr/bin/env python3
import argparse
import json
import shutil
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)


def shape_by_name(root, name):
    for shape in root.findall(".//p:sp", NS):
        identity = shape.find("p:nvSpPr/p:cNvPr", NS)
        if identity is not None and identity.get("name") == name:
            return shape
    raise ValueError(f"Shape {name!r} not found")


def rewrite(source: Path, target: Path, mutations):
    with tempfile.TemporaryDirectory(prefix="slidewright-feedback-mutant-") as directory:
        root = Path(directory)
        with zipfile.ZipFile(source) as archive:
            archive.extractall(root)
        for part, mutate in mutations:
            path = root / part
            xml = ET.parse(path)
            mutate(xml.getroot())
            xml.write(path, encoding="utf-8", xml_declaration=True)
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(root.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(root).as_posix())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)

    first_content = plan["slides"][1]
    content_title = next(shape["id"] for shape in first_content["shapes"] if shape.get("role") == "title")
    content_body = next(shape["id"] for shape in first_content["shapes"] if shape.get("role") == "body")
    first_divider = plan["slides"][0]
    divider_title = first_divider["layoutContract"]["headline"]["shapeId"]
    divider_surface = first_divider["layoutContract"]["fitSurfaces"][0]["surfaceId"]

    mutants = []

    def overlap(root):
        title = shape_by_name(root, content_title).find("p:spPr/a:xfrm", NS)
        body = shape_by_name(root, content_body).find("p:spPr/a:xfrm", NS)
        title_off = title.find("a:off", NS)
        body_off = body.find("a:off", NS)
        body_off.set("x", title_off.get("x"))
        body_off.set("y", title_off.get("y"))

    def short_headline(root):
        ext = shape_by_name(root, content_title).find("p:spPr/a:xfrm/a:ext", NS)
        ext.set("cx", str(max(1, int(ext.get("cx")) // 3)))

    def short_backing(root):
        ext = shape_by_name(root, divider_surface).find("p:spPr/a:xfrm/a:ext", NS)
        ext.set("cy", str(max(1, int(ext.get("cy")) // 2)))

    def missing_topic(root):
        shape = shape_by_name(root, divider_title)
        for node in shape.findall(".//a:t", NS):
            node.text = ""

    def empty_bullet(root):
        shape = shape_by_name(root, content_body)
        body = shape.find("p:txBody", NS)
        paragraph = ET.Element(f"{{{NS['a']}}}p")
        ppr = ET.SubElement(paragraph, f"{{{NS['a']}}}pPr")
        bullet = ET.SubElement(ppr, f"{{{NS['a']}}}buChar")
        bullet.set("char", "\u2022")
        ET.SubElement(paragraph, f"{{{NS['a']}}}endParaRPr")
        body.append(paragraph)

    definitions = [
        ("ooxml-text-overlap", "OOXML_G24", "ppt/slides/slide2.xml", overlap),
        ("ooxml-shortened-headline", "OOXML_G25", "ppt/slides/slide2.xml", short_headline),
        ("ooxml-undersized-backing", "OOXML_G26", "ppt/slides/slide1.xml", short_backing),
        ("ooxml-missing-topic-title", "OOXML_G27", "ppt/slides/slide1.xml", missing_topic),
        ("ooxml-empty-bullet", "OOXML_G28", "ppt/slides/slide2.xml", empty_bullet),
    ]
    for identifier, rule_id, part, mutation in definitions:
        target = args.output / f"{identifier}.pptx"
        rewrite(args.source, target, [(part, mutation)])
        mutants.append({"id": identifier, "ruleId": rule_id, "path": str(target)})

    (args.output / "manifest.json").write_text(json.dumps(mutants, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
