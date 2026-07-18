#!/usr/bin/env python3
"""Destructive integration controls for the C16 hash and localized-render gates."""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
}


def tamper_unrelated_shape(source: Path, target: Path):
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as modified:
        changed = False
        for item in original.infolist():
            data = original.read(item.filename)
            if item.filename == "ppt/slides/slide4.xml":
                root = ET.fromstring(data)
                for shape in root.findall(".//p:sp", NS):
                    name = shape.find("p:nvSpPr/p:cNvPr", NS)
                    if name is not None and name.attrib.get("name") == "s4-eyebrow":
                        props = shape.find("p:spPr/a:solidFill/a:srgbClr", NS)
                        if props is not None:
                            props.attrib["val"] = "000000"
                        else:
                            xfrm = shape.find("p:spPr/a:xfrm/a:off", NS)
                            xfrm.attrib["x"] = str(int(xfrm.attrib["x"]) + 1000)
                        changed = True
                        break
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            modified.writestr(item, data)
    if not changed:
        raise ValueError("Could not tamper the unrelated s4-eyebrow object.")

REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def tamper_package(source: Path, target: Path, control: str):
    changed = False
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as modified:
        for item in original.infolist():
            data = original.read(item.filename)
            if control == "relationship-target" and item.filename == "ppt/slides/_rels/slide1.xml.rels":
                root = ET.fromstring(data)
                relationship = next(iter(root))
                relationship.set("Target", "../missing/slide.xml")
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                changed = True
            elif control == "dangling-reference" and item.filename == "ppt/presentation.xml":
                root = ET.fromstring(data)
                for element in root.iter():
                    for attribute in list(element.attrib):
                        if attribute.startswith("{" + OFFICE_REL_NS + "}"):
                            element.set(attribute, "rId999")
                            changed = True
                            break
                    if changed:
                        break
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            elif control == "master-mutation" and item.filename == "ppt/slideMasters/slideMaster1.xml":
                root = ET.fromstring(data)
                root.set("slidewrightTamper", "1")
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
                changed = True
            elif control == "chart-metadata" and item.filename == "ppt/slides/slide3.xml":
                root = ET.fromstring(data)
                for element in root.iter():
                    if element.tag.endswith("}cNvPr") and element.get("name") == "horizontal-chart-component":
                        element.set("descr", element.get("descr", "") + "x")
                        changed = True
                        break
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            elif control == "creation-id" and item.filename == "ppt/slides/slide1.xml":
                root = ET.fromstring(data)
                for element in root.iter():
                    if element.tag.endswith("}creationId"):
                        element.set("id", "{00000000-0000-0000-0000-000000000001}")
                        changed = True
                        break
                data = ET.tostring(root, encoding="utf-8", xml_declaration=True)
            modified.writestr(item, data)
        if control == "extra-part":
            info = zipfile.ZipInfo("ppt/unauthorized.bin", (2000, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            modified.writestr(info, b"unauthorized")
            changed = True
    if not changed:
        raise ValueError(f"Could not apply negative control {control}.")

def run_expected_failure(command):
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode == 0:
        raise AssertionError(f"Negative control unexpectedly passed: {' '.join(command)}")
    return {"returnCode": result.returncode, "stdout": result.stdout[-1000:], "stderr": result.stderr[-1000:]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline_pptx")
    parser.add_argument("variant_pptx")
    parser.add_argument("baseline_render_dir")
    parser.add_argument("variant_render_dir")
    parser.add_argument("--allowed-changed", required=True)
    parser.add_argument("--required-changed", required=True)
    parser.add_argument("--mask-ids", required=True)
    parser.add_argument("--audit-script", required=True)
    parser.add_argument("--compare-script", required=True)
    parser.add_argument("--json", required=True)
    args = parser.parse_args()

    output = Path(args.json)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix="rejected-c16-") as temp:
        folder = Path(temp)
        tampered_pptx = folder / "unauthorized-object-drift.pptx"
        tamper_unrelated_shape(Path(args.variant_pptx), tampered_pptx)
        object_result = run_expected_failure([
            sys.executable,
            args.audit_script,
            args.baseline_pptx,
            str(tampered_pptx),
            "--allowed-changed",
            args.allowed_changed,
            "--required-changed",
            args.required_changed,
            "--json",
            str(folder / "unauthorized-object-report.json"),
        ])
        package_results = []
        for control in [
            "relationship-target",
            "dangling-reference",
            "master-mutation",
            "extra-part",
            "chart-metadata",
            "creation-id",
        ]:
            target = folder / f"{control}.pptx"
            tamper_package(Path(args.variant_pptx), target, control)
            result = run_expected_failure([
                sys.executable,
                args.audit_script,
                args.baseline_pptx,
                str(target),
                "--allowed-changed",
                args.allowed_changed,
                "--required-changed",
                args.required_changed,
                "--json",
                str(folder / f"{control}-report.json"),
            ])
            package_results.append({"id": control, **result})

        tampered_renders = folder / "unauthorized-pixel-drift"
        shutil.copytree(args.variant_render_dir, tampered_renders)
        slide4 = next(candidate for candidate in [tampered_renders / "slide-4.png", tampered_renders / "slide-04.png"] if candidate.exists())
        image = Image.open(slide4).convert("RGB")
        image.putpixel((0, 0), (255, 0, 255))
        image.save(slide4)
        pixel_result = run_expected_failure([
            sys.executable,
            args.compare_script,
            args.baseline_pptx,
            args.variant_pptx,
            args.baseline_render_dir,
            str(tampered_renders),
            "--mask-ids",
            args.mask_ids,
            "--json",
            str(folder / "unauthorized-pixel-report.json"),
        ])

    report = {
        "valid": True,
        "rejectedControls": [
            {"id": "unauthorized-ooxml-object-drift", **object_result},
            {"id": "pixel-drift-outside-exported-mask", **pixel_result},
            *package_results,
        ],
        "rejectedArtifactsDeleted": not any(output.parent.glob("rejected-c16-*")),
    }
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
