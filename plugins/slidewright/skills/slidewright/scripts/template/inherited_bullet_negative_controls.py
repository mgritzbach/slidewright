#!/usr/bin/env python3
"""Destructive controls for the source-bound inherited-bullet hygiene contract."""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import tempfile
import zipfile
from pathlib import Path

from lxml import etree as ET

from audit_inherited_bullet_hygiene import audit
from inherited_bullet_hygiene import NS, named_shape, sanitize


def mutate_part(source: Path, output: Path, part: str, mutate) -> None:
    with zipfile.ZipFile(source, "r") as archive:
        root = ET.fromstring(archive.read(part))
        mutate(root)
        payload = ET.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w") as outgoing:
            for item in archive.infolist():
                outgoing.writestr(item, payload if item.filename == part else archive.read(item.filename))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("sanitized")
    parser.add_argument("plan")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--json", required=True)
    args = parser.parse_args()
    source = Path(args.source)
    sanitized = Path(args.sanitized)
    plan_path = Path(args.plan)
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    controls: list[dict] = []

    def record(name: str, rejected: bool, mechanism: str) -> None:
        controls.append({"name": name, "rejected": bool(rejected), "mechanism": mechanism})

    with tempfile.TemporaryDirectory(prefix="slidewright-g28-negative-") as temporary_name:
        temporary = Path(temporary_name)
        stale_plan = copy.deepcopy(plan)
        stale_plan["sourceSha256"] = "0" * 64
        stale_path = temporary / "stale.json"
        stale_path.write_text(json.dumps(stale_plan), encoding="utf-8")
        try:
            sanitize(source, stale_path, temporary / "stale.pptx")
            rejected = False
        except ValueError:
            rejected = True
        record("stale-source-hash", rejected, "sanitizer")

        wrong_shape = copy.deepcopy(plan)
        wrong_shape["shapeName"] = "MIT Preserve Body"
        wrong_path = temporary / "wrong-shape.json"
        wrong_path.write_text(json.dumps(wrong_shape), encoding="utf-8")
        try:
            sanitize(source, wrong_path, temporary / "wrong-shape.pptx")
            rejected = False
        except ValueError:
            rejected = True
        record("wrong-placeholder-shape", rejected, "sanitizer")

        reinsertion = out_dir / "reinserted-empty-inherited-bullet.pptx"

        def reinsert(root: ET._Element) -> None:
            shape = named_shape(root, plan["shapeName"])
            body = shape.find("./p:txBody", NS)
            paragraph = ET.Element(f"{{{NS['a']}}}p")
            properties = ET.SubElement(paragraph, f"{{{NS['a']}}}pPr")
            properties.set("lvl", "0")
            ET.SubElement(paragraph, f"{{{NS['a']}}}endParaRPr").set("lang", "en-US")
            body.insert(1, paragraph)

        mutate_part(sanitized, reinsertion, "ppt/slides/slide1.xml", reinsert)
        record("reinserted-empty-inherited-bullet", not audit(source, reinsertion, plan_path)["valid"], "audit")

        deleted = out_dir / "deleted-nonempty-paragraph.pptx"

        def delete_nonempty(root: ET._Element) -> None:
            shape = named_shape(root, plan["shapeName"])
            body = shape.find("./p:txBody", NS)
            body.remove(body.findall("./a:p", NS)[0])

        mutate_part(sanitized, deleted, "ppt/slides/slide1.xml", delete_nonempty)
        record("deleted-nonempty-paragraph", not audit(source, deleted, plan_path)["valid"], "audit")

        changed_title = out_dir / "changed-nontarget-title.pptx"

        def mutate_title(root: ET._Element) -> None:
            title = named_shape(root, "MIT Fixture Title")
            title.find(".//a:t", NS).text = "Collateral title mutation"

        mutate_part(sanitized, changed_title, "ppt/slides/slide1.xml", mutate_title)
        record("same-slide-nontarget-mutation", not audit(source, changed_title, plan_path)["valid"], "audit")

        changed_master = out_dir / "changed-master-bullet.pptx"

        def mutate_master(root: ET._Element) -> None:
            bullet = root.find("./p:txStyles/p:bodyStyle/a:lvl1pPr/a:buChar", NS)
            if bullet is None:
                raise ValueError("Fixture master does not expose the inherited level-1 bullet.")
            bullet.set("char", "■")

        mutate_part(sanitized, changed_master, "ppt/slideMasters/slideMaster1.xml", mutate_master)
        record("protected-master-bullet-mutation", not audit(source, changed_master, plan_path)["valid"], "audit")

    valid = all(control["rejected"] for control in controls)
    result = {
        "valid": valid,
        "controls": controls,
        "summary": {"total": len(controls), "rejected": sum(control["rejected"] for control in controls)},
    }
    report = Path(args.json)
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
