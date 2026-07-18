#!/usr/bin/env python3
"""Destructive, fixture-agnostic controls for the C10 template matrix."""

from __future__ import annotations

import argparse
import copy
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path


def rewrite_zip(source: Path, target: Path, mutations: dict[str, callable], extra: tuple[str, bytes] | None = None) -> None:
    with zipfile.ZipFile(source) as incoming:
        entries = [(item, incoming.read(item.filename)) for item in incoming.infolist()]
    target.parent.mkdir(parents=True, exist_ok=True)
    applied = set()
    with zipfile.ZipFile(target, "w") as outgoing:
        for item, payload in entries:
            if item.filename in mutations:
                updated = mutations[item.filename](payload)
                if updated == payload:
                    raise RuntimeError(f"Control did not mutate {item.filename}.")
                payload = updated
                applied.add(item.filename)
            outgoing.writestr(item, payload)
        if extra:
            outgoing.writestr(extra[0], extra[1])
    if applied != set(mutations):
        raise RuntimeError(f"Missing mutation parts: {sorted(set(mutations) - applied)}")


def replace_once(payload: bytes, pattern: bytes, replacement) -> bytes:
    updated, count = re.subn(pattern, replacement, payload, count=1)
    if count != 1:
        raise RuntimeError(f"Pattern did not match exactly once: {pattern!r}")
    return updated


def append_comment(payload: bytes) -> bytes:
    marker = payload.rfind(b"</")
    if marker < 0:
        raise RuntimeError("XML part has no closing tag.")
    return payload[:marker] + b"<!--slidewright-negative-drift-->" + payload[marker:]


def mutate_theme(payload: bytes) -> bytes:
    return replace_once(
        payload,
        rb'(<a:(?:srgbClr|sysClr)\b[^>]*(?:val|lastClr)=")[0-9A-Fa-f]{6}(")',
        lambda match: match.group(1) + (b"010203" if match.group(0).find(b"010203") < 0 else b"A1B2C3") + match.group(2),
    )


def mutate_relationship(payload: bytes) -> bytes:
    return replace_once(payload, rb'(/slideLayout)(")', rb'\1-mutated\2')


def mutate_spacing(payload: bytes) -> bytes:
    def rewrite(match) -> bytes:
        attributes = match.group(1).rstrip()
        self_closing = attributes.endswith(b"/")
        if self_closing:
            attributes = attributes[:-1].rstrip()
        attributes = re.sub(rb'\s+lIns="[^"]*"', b"", attributes)
        return b"<a:bodyPr" + attributes + b' lIns="12701"' + (b"/>" if self_closing else b">")

    return replace_once(
        payload,
        rb'<a:bodyPr\b([^>]*)>',
        rewrite,
    )


def mutate_geometry(payload: bytes) -> bytes:
    return replace_once(
        payload,
        rb'(<a:off\b[^>]*\bx=")(-?\d+)(")',
        lambda match: match.group(1) + str(int(match.group(2)) + 12700).encode() + match.group(3),
    )


def mutate_named_geometry(payload: bytes, name: str) -> bytes:
    marker = f'name="{name}"'.encode()
    if payload.count(marker) != 1:
        raise RuntimeError(f"Expected one visible object named {name!r}.")
    position = payload.index(marker)
    candidates = []
    for kind in (b"sp", b"graphicFrame", b"pic", b"grpSp", b"cxnSp"):
        start = payload.rfind(b"<p:" + kind, 0, position)
        if start >= 0:
            candidates.append((start, kind))
    if not candidates:
        raise RuntimeError(f"Could not locate object boundary for {name!r}.")
    start, kind = max(candidates)
    close = b"</p:" + kind + b">"
    end = payload.index(close, position) + len(close)
    shape = replace_once(
        payload[start:end],
        rb'(<a:off\b[^>]*\bx=")(-?\d+)(")',
        lambda match: match.group(1) + str(int(match.group(2)) + 254000).encode() + match.group(3),
    )
    return payload[:start] + shape + payload[end:]


def mutate_placeholder(payload: bytes, shape_name: str) -> bytes:
    marker = f'name="{shape_name}"'.encode()
    if payload.count(marker) != 1:
        raise RuntimeError(f"Expected one shape {shape_name!r}.")
    position = payload.index(marker)
    start = payload.rfind(b"<p:sp>", 0, position)
    end = payload.index(b"</p:sp>", position) + len(b"</p:sp>")
    shape = payload[start:end]
    if re.search(rb'<p:ph\b[^>]*\btype="(?:title|ctrTitle)"', shape):
        changed = re.sub(rb'(<p:ph\b[^>]*\btype=")(?:title|ctrTitle)(")', rb'\1body\2', shape, count=1)
    elif re.search(rb'<p:ph\b[^>]*\bidx="\d+"', shape):
        changed = re.sub(
            rb'(<p:ph\b[^>]*\bidx=")(\d+)(")',
            lambda match: match.group(1) + str(int(match.group(2)) + 100).encode() + match.group(3),
            shape,
            count=1,
        )
    else:
        raise RuntimeError(f"Shape {shape_name!r} has no mutable placeholder binding.")
    return payload[:start] + changed + payload[end:]


def mutate_inserted_run(payload: bytes, text: str, operation: str) -> bytes:
    escaped = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").encode()
    run = b"<a:r><a:t>" + escaped + b"</a:t></a:r>"
    if payload.count(run) != 1:
        raise RuntimeError("Could not find the one declared minimal inserted run.")
    if operation == "direct-formatting":
        replacement = b'<a:r><a:rPr b="1"/><a:t>' + escaped + b"</a:t></a:r>"
    elif operation == "second-run":
        replacement = run + run
    elif operation == "second-paragraph":
        replacement = run + b"</a:p><a:p><a:endParaRPr/>"
    else:
        raise RuntimeError(operation)
    return payload.replace(run, replacement, 1)


def run_audit(
    audit_script: Path,
    source: Path,
    candidate: Path,
    profile: Path,
    plan: Path,
    report: Path,
    *,
    intended_fields: tuple[str, ...] = (),
    intended_error: str | None = None,
) -> dict:
    completed = subprocess.run(
        [sys.executable, str(audit_script), str(source), str(candidate), "--profile", str(profile), "--edit-plan", str(plan), "--json", str(report)],
        text=True,
        capture_output=True,
        check=False,
    )
    payload = None
    try:
        payload = json.loads(report.read_text(encoding="utf-8")) if report.exists() else None
    except (OSError, json.JSONDecodeError):
        payload = None
    failure_fields = [str(item.get("field", "")) for item in (payload or {}).get("failures", []) if isinstance(item, dict)]
    report_rejection = completed.returncode == 1 and payload is not None and payload.get("valid") is False and any(
        any(field == expected or field.startswith(expected) for expected in intended_fields) for field in failure_fields
    )
    diagnostic_rejection = completed.returncode == 2 and intended_error is not None and re.search(intended_error, completed.stderr) is not None
    return {
        "rejected": report_rejection or diagnostic_rejection,
        "exitCode": completed.returncode,
        "report": str(report),
        "failureFields": failure_fields,
        "rejectionMode": "audit-report" if report_rejection else "allowlisted-diagnostic" if diagnostic_rejection else "unexpected-failure",
        "stderr": completed.stderr.strip(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("edited", type=Path)
    parser.add_argument("profile", type=Path)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--json", required=True, type=Path)
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    plan = json.loads(args.plan.read_text(encoding="utf-8"))
    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    audit_script = Path(__file__).with_name("audit_design_profile.py")
    edit_script = Path(__file__).parents[1] / "template" / "edit_template.py"
    preserve_mode = plan.get("mode") == "preserve-source-deck"
    target_slide = int(plan.get("targetSlide", 1))
    target_part = f"ppt/slides/slide{target_slide}.xml"
    controls: list[dict] = []

    def audit_control(
        name: str,
        mutations: dict[str, callable],
        *,
        extra: tuple[str, bytes] | None = None,
        intended_fields: tuple[str, ...] = (),
        intended_error: str | None = None,
    ) -> None:
        candidate = args.out_dir / f"{name}.pptx"
        report = args.out_dir / f"{name}.json"
        rewrite_zip(args.edited, candidate, mutations, extra)
        controls.append({
            "name": name,
            "applicable": True,
            **run_audit(
                audit_script,
                args.source,
                candidate,
                args.profile,
                args.plan,
                report,
                intended_fields=intended_fields,
                intended_error=intended_error,
            ),
        })

    bad_source_plan = copy.deepcopy(plan)
    bad_source_plan["sourceSha256"] = "0" * 64
    bad_source_path = args.out_dir / "wrong-source-sha-plan.json"
    bad_source_path.write_text(json.dumps(bad_source_plan, indent=2) + "\n", encoding="utf-8")
    completed = subprocess.run(
        [sys.executable, str(edit_script), str(args.source), str(bad_source_path), str(args.out_dir / "wrong-source-sha.pptx"), "--json", str(args.out_dir / "wrong-source-sha.json")],
        text=True,
        capture_output=True,
        check=False,
    )
    controls.append({
        "name": "wrong-source-sha",
        "applicable": True,
        "rejected": completed.returncode == 1 and "Source SHA-256 mismatch" in completed.stderr,
        "exitCode": completed.returncode,
        "rejectionMode": "allowlisted-editor-diagnostic",
        "stderr": completed.stderr.strip(),
    })

    if preserve_mode:
        controls.append({"name": "stale-source-binding", "applicable": False, "rejected": None, "reason": "preserve-only fixture has no editable source binding"})
    else:
        stale_plan = copy.deepcopy(plan)
        first = stale_plan["edits"][0]
        if first.get("editMode") == "populate-empty-placeholder":
            first["sourceParagraphSha256s"][0] = "f" * 64
        else:
            first["before"] += " stale"
        stale_path = args.out_dir / "stale-edit-plan.json"
        stale_path.write_text(json.dumps(stale_plan, indent=2) + "\n", encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(edit_script), str(args.source), str(stale_path), str(args.out_dir / "stale-edit.pptx"), "--json", str(args.out_dir / "stale-edit.json")],
            text=True,
            capture_output=True,
            check=False,
        )
        controls.append({
            "name": "stale-source-binding",
            "applicable": True,
            "rejected": completed.returncode == 1 and ("sourceParagraphSha256s mismatch" in completed.stderr or "source text mismatch" in completed.stderr),
            "exitCode": completed.returncode,
            "rejectionMode": "allowlisted-editor-diagnostic",
            "stderr": completed.stderr.strip(),
        })

    audit_control("same-slide-undeclared-drift", {target_part: append_comment}, intended_fields=(f"package-part-exact:{target_part}",))
    master_part = profile["masters"][0]["part"]
    layout_part = next(item["layoutPart"] for item in profile["slides"] if item["part"] == target_part)
    theme_part = profile["presentation"]["inheritanceChains"][target_slide - 1]["themePart"]
    audit_control("master-part-drift", {master_part: append_comment}, intended_fields=(f"package-part-exact:{master_part}",))
    audit_control("layout-part-drift", {layout_part: append_comment}, intended_fields=(f"package-part-exact:{layout_part}",))

    placeholder_edit = next((edit for edit in plan["edits"] if edit.get("placeholderType") != "freeform"), None)
    if placeholder_edit:
        object_key = next(item["objectKey"] for item in profile["objects"] if item["part"] == target_part and item["name"] == placeholder_edit["shapeName"])
        audit_control("placeholder-binding-drift", {target_part: lambda data: mutate_placeholder(data, placeholder_edit["shapeName"])}, intended_fields=(f"object-identity:{object_key}",))
    else:
        controls.append({"name": "placeholder-binding-drift", "applicable": False, "rejected": None, "reason": "fixture has no instantiated placeholders"})

    audit_control("theme-palette-drift", {theme_part: mutate_theme}, intended_fields=("themes",))
    slide_rels = f"ppt/slides/_rels/slide{target_slide}.xml.rels"
    audit_control("inheritance-relationship-drift", {slide_rels: mutate_relationship}, intended_fields=("relationship-tuples", "slide-layout-master-theme-chains"))
    spacing_part = next((item["part"] for item in profile["spacing"]["records"] if item["kind"] == "bodyPr"), None)
    if spacing_part:
        audit_control("text-spacing-drift", {spacing_part: mutate_spacing}, intended_fields=("text-spacing",))
    else:
        controls.append({"name": "text-spacing-drift", "applicable": False, "rejected": None, "reason": "fixture has no bodyPr spacing record"})
    geometry_object = next((item for item in profile["chrome"]["objects"] if item.get("geometry") and item.get("name")), None)
    if geometry_object:
        audit_control(
            "chrome-geometry-drift",
            {geometry_object["part"]: lambda data, item=geometry_object: mutate_named_geometry(data, item["name"])},
            intended_fields=(f"chrome-preserved:{geometry_object['objectKey']}",),
        )
    else:
        controls.append({"name": "chrome-geometry-drift", "applicable": False, "rejected": None, "reason": "fixture has no explicit chrome geometry"})
    visible_object = next(
        (item for item in profile["objects"] if item["part"].startswith("ppt/slides/") and item.get("geometry") and item.get("name")),
        None,
    )
    if visible_object is None and plan["edits"]:
        target_edit = plan["edits"][0]
        raw_placeholder_type = target_edit.get("placeholderType")
        normalized_placeholder_type = {
            "ctrTitle": "title",
            "subTitle": "subtitle",
            "obj": "body",
        }.get(raw_placeholder_type, raw_placeholder_type)
        try:
            placeholder_index = int(target_edit.get("placeholderIndex", "0"))
        except (TypeError, ValueError):
            placeholder_index = None
        visible_object = next(
            (
                item
                for item in profile["objects"]
                if item["part"] == layout_part
                and item.get("geometry")
                and item.get("name")
                and item.get("placeholder")
                and item["placeholder"].get("type") == normalized_placeholder_type
                and item["placeholder"].get("index") == placeholder_index
            ),
            None,
        )
        if visible_object is None:
            visible_object = next(
                (
                    item
                    for item in profile["objects"]
                    if item["part"] == master_part
                    and item.get("geometry")
                    and item.get("name")
                    and item.get("placeholder")
                    and item["placeholder"].get("type") == normalized_placeholder_type
                    and item["placeholder"].get("index") == placeholder_index
                ),
                None,
            )
    if visible_object is None:
        visible_object = next(
            (item for item in profile["objects"] if item["part"] == layout_part and item.get("geometry") and item.get("name")),
            None,
        )
    if visible_object:
        audit_control(
            "visible-geometry-drift",
            {visible_object["part"]: lambda data, item=visible_object: mutate_named_geometry(data, item["name"])},
            intended_fields=(f"object-identity:{visible_object['objectKey']}",),
        )
    else:
        controls.append({"name": "visible-geometry-drift", "applicable": False, "rejected": None, "reason": "fixture has no renderable explicit geometry"})
    audit_control("unexpected-package-part", {}, extra=("ppt/slidewright-unexpected.xml", b"<unexpected/>"), intended_fields=("package-part-inventory",))

    populated = [edit for edit in plan["edits"] if edit.get("editMode") == "populate-empty-placeholder"]
    for operation in ("direct-formatting", "second-run", "second-paragraph"):
        if populated:
            edit = populated[0]
            if operation == "direct-formatting":
                audit_control(operation, {target_part: lambda data, e=edit, op=operation: mutate_inserted_run(data, e["after"], op)}, intended_error=r"must contain one exact minimal native text run")
            elif operation == "second-run":
                audit_control(operation, {target_part: lambda data, e=edit, op=operation: mutate_inserted_run(data, e["after"], op)}, intended_error=r"derived text mismatch")
            else:
                audit_control(operation, {target_part: lambda data, e=edit, op=operation: mutate_inserted_run(data, e["after"], op)}, intended_error=r"must contain exactly one native paragraph")
        else:
            controls.append({"name": operation, "applicable": False, "rejected": None, "reason": "fixture does not populate an empty placeholder"})

    required = {item["name"] for item in controls if item["applicable"]}
    valid = len(required) == len([item for item in controls if item["applicable"]]) and all(item["rejected"] for item in controls if item["applicable"])
    report = {
        "schemaVersion": "slidewright-template-matrix-negative-controls/v1",
        "valid": valid,
        "applicableCount": len(required),
        "notApplicableCount": len(controls) - len(required),
        "controls": controls,
    }
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if valid else 1


if __name__ == "__main__":
    raise SystemExit(main())
