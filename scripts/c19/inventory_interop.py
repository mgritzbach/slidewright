#!/usr/bin/env python3
"""Prepare and independently inventory the C19 interoperability PPTX fixture."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageStat

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"p": P, "a": A, "c": C, "r": R}
for prefix, uri in NS.items():
    ET.register_namespace(prefix, uri)


def canonical_hash(value: object) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def slide_parts(names: list[str]) -> list[str]:
    found = [name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    return sorted(found, key=lambda name: int(re.search(r"(\d+)", Path(name).stem).group(1)))


def shape_name(element: ET.Element) -> str:
    node = element.find("./p:nvSpPr/p:cNvPr", NS)
    if node is None:
        node = element.find("./p:nvGraphicFramePr/p:cNvPr", NS)
    if node is None:
        node = element.find("./p:nvGrpSpPr/p:cNvPr", NS)
    if node is None:
        node = element.find("./p:nvCxnSpPr/p:cNvPr", NS)
    if node is None:
        node = element.find("./p:nvPicPr/p:cNvPr", NS)
    return node.get("name", "") if node is not None else ""


def bold_value(run: ET.Element) -> bool:
    properties = run.find("./a:rPr", NS)
    value = properties.get("b") if properties is not None else None
    return value in {"1", "true"}


def has_mixed_emphasis(container: ET.Element) -> bool:
    runs = [run for run in container.findall(".//a:r", NS) if (run.findtext("./a:t", default="", namespaces=NS) or "").strip()]
    values = [bold_value(run) for run in runs]
    return len(values) >= 2 and any(values) and not all(values)


def ordered_native_text(element: ET.Element) -> list[str]:
    """Return native visible text in recursive shape-tree order.

    Application round trips may replace DrawingML object names, so C19 v2 also
    binds reading order to the ordered native text itself. The known sentinel
    mutation is applied before source/result comparison by the suite runner.
    """
    local = element.tag.rsplit("}", 1)[-1]
    if local == "sp":
        text = "".join((item.text or "") for item in element.findall("./p:txBody//a:t", NS)).strip()
        return [text] if text else []
    if local == "graphicFrame":
        values: list[str] = []
        for cell in element.findall(".//a:tc", NS):
            text = "".join((item.text or "") for item in cell.findall(".//a:t", NS)).strip()
            if text:
                values.append(text)
        return values
    if local == "grpSp":
        values: list[str] = []
        for child in list(element):
            child_local = child.tag.rsplit("}", 1)[-1]
            if child_local in {"nvGrpSpPr", "grpSpPr"}:
                continue
            values.extend(ordered_native_text(child))
        return values
    return []


def inventory(pptx: Path) -> dict:
    with zipfile.ZipFile(pptx) as package:
        names = package.namelist()
        presentation = ET.fromstring(package.read("ppt/presentation.xml"))
        size = presentation.find("./p:sldSz", NS)
        slide_width = int(size.get("cx"))
        slide_height = int(size.get("cy"))
        reading_order: list[list[str]] = []
        visible_text_order: list[list[str]] = []
        visible_strings: list[str] = []
        native_text = mixed = tables = charts = groups = connectors = attached_connectors = full_slide_pictures = 0
        for part in slide_parts(names):
            root = ET.fromstring(package.read(part))
            tree = root.find("./p:cSld/p:spTree", NS)
            order: list[str] = []
            if tree is not None:
                for child in list(tree):
                    local = child.tag.rsplit("}", 1)[-1]
                    if local in {"nvGrpSpPr", "grpSpPr"}:
                        continue
                    name = shape_name(child)
                    if name:
                        order.append(name)
            reading_order.append(order)
            slide_visible_order: list[str] = []
            if tree is not None:
                for child in list(tree):
                    local = child.tag.rsplit("}", 1)[-1]
                    if local in {"nvGrpSpPr", "grpSpPr"}:
                        continue
                    slide_visible_order.extend(ordered_native_text(child))
            visible_text_order.append(slide_visible_order)
            visible_strings.extend(slide_visible_order)
            for shape in root.findall(".//p:sp", NS):
                text = "".join((item.text or "") for item in shape.findall(".//a:t", NS)).strip()
                if text:
                    native_text += 1
                    if has_mixed_emphasis(shape):
                        mixed += 1
            for cell in root.findall(".//a:tc", NS):
                text = "".join((item.text or "") for item in cell.findall(".//a:t", NS)).strip()
                if text:
                    native_text += 1
                    if has_mixed_emphasis(cell):
                        mixed += 1
            groups += len(root.findall(".//p:grpSp", NS))
            for connector in root.findall(".//p:cxnSp", NS):
                connectors += 1
                if connector.find("./p:nvCxnSpPr/p:cNvCxnSpPr/a:stCxn", NS) is not None \
                        and connector.find("./p:nvCxnSpPr/p:cNvCxnSpPr/a:endCxn", NS) is not None:
                    attached_connectors += 1
            for frame in root.findall(".//p:graphicFrame", NS):
                data = frame.find("./a:graphic/a:graphicData", NS)
                uri = data.get("uri", "") if data is not None else ""
                if uri.endswith("/chart"):
                    charts += 1
                if uri.endswith("/table"):
                    tables += 1
            for picture in root.findall(".//p:pic", NS):
                extent = picture.find("./p:spPr/a:xfrm/a:ext", NS)
                if extent is not None and int(extent.get("cx", "0")) >= int(slide_width * 0.9) and int(extent.get("cy", "0")) >= int(slide_height * 0.9):
                    full_slide_pictures += 1
        result = {
            "slides": len(reading_order),
            "nativeTextObjects": native_text,
            "mixedEmphasisObjects": mixed,
            "tables": tables,
            "charts": charts,
            "groups": groups,
            "connectors": connectors,
            "attachedConnectors": attached_connectors,
            "fullSlidePictures": full_slide_pictures,
            "slideWidthEmu": slide_width,
            "slideHeightEmu": slide_height,
            "readingOrder": reading_order,
            "visibleTextOrder": visible_text_order,
            "visibleTextSha256": canonical_hash(visible_strings),
        }
    return result


def prepare_source(source: Path, output: Path, target_name: str) -> None:
    with zipfile.ZipFile(source) as package:
        members = {name: package.read(name) for name in package.namelist()}
    changed = False
    for part in slide_parts(list(members)):
        root = ET.fromstring(members[part])
        for shape in root.findall(".//p:sp", NS):
            if shape_name(shape) != target_name:
                continue
            paragraph = shape.find(".//a:p", NS)
            run = paragraph.find("./a:r", NS) if paragraph is not None else None
            text_node = run.find("./a:t", NS) if run is not None else None
            text = text_node.text if text_node is not None else ""
            if not text or " " not in text:
                raise RuntimeError(f"Target {target_name!r} has no splittable native run")
            first, remainder = text.split(" ", 1)
            first_run = copy.deepcopy(run)
            second_run = copy.deepcopy(run)
            first_run.find("./a:t", NS).text = first + " "
            second_run.find("./a:t", NS).text = remainder
            for item, value in ((first_run, "1"), (second_run, "0")):
                props = item.find("./a:rPr", NS)
                if props is None:
                    props = ET.Element(f"{{{A}}}rPr")
                    item.insert(0, props)
                props.set("b", value)
            index = list(paragraph).index(run)
            paragraph.remove(run)
            paragraph.insert(index, first_run)
            paragraph.insert(index + 1, second_run)
            members[part] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            changed = True
            break
        if changed:
            break
    if not changed:
        raise RuntimeError(f"Could not find native text target {target_name!r}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            package.writestr(info, members[name])


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    prepare = subparsers.add_parser("prepare")
    prepare.add_argument("--input", required=True, type=Path)
    prepare.add_argument("--output", required=True, type=Path)
    prepare.add_argument("--target", default="surface-01-title")
    inspect = subparsers.add_parser("inspect")
    inspect.add_argument("--input", required=True, type=Path)
    inspect.add_argument("--out", required=True, type=Path)
    renders = subparsers.add_parser("inspect-renders")
    renders.add_argument("--input-dir", required=True, type=Path)
    renders.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "prepare":
        prepare_source(args.input.resolve(), args.output.resolve(), args.target)
        print(json.dumps({"valid": True, "outputSha256": sha256_file(args.output.resolve())}, indent=2))
        return
    if args.command == "inspect-renders":
        items = []
        for index, image_path in enumerate(sorted(args.input_dir.resolve().glob("slide-*.png")), start=1):
            with Image.open(image_path) as image:
                rgb = image.convert("RGB")
                entropy = float(rgb.entropy())
                extrema = ImageStat.Stat(rgb).extrema
                non_blank = entropy > 0.5 and any(high - low > 8 for low, high in extrema)
                readable = entropy > 1.5 and non_blank
                items.append({"slide": index, "file": image_path.name, "width": image.width, "height": image.height, "entropy": round(entropy, 6), "notBlank": non_blank, "readable": readable, "sha256": sha256_file(image_path)})
        payload = {"schemaVersion": "slidewright-c19-render-analysis/v1", "valid": bool(items) and all(item["notBlank"] and item["readable"] for item in items), "slides": items}
        args.out.resolve().parent.mkdir(parents=True, exist_ok=True)
        args.out.resolve().write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(payload, indent=2))
        return
    result = inventory(args.input.resolve())
    payload = {"schemaVersion": "slidewright-c19-inventory/v1", "valid": True, "inputSha256": sha256_file(args.input.resolve()), "inventory": result, "inventoryHash": canonical_hash(result)}
    args.out.resolve().parent.mkdir(parents=True, exist_ok=True)
    args.out.resolve().write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
