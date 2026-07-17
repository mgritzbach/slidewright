#!/usr/bin/env python3
"""Generate and verify the nine C18 semantic-mutation negative controls.

The controls are destructive integration tests, not fixtures for delivery.  The
five untouched PowerPoint-mutated decks must first pass the real mutation
auditor.  Each control is then produced from an isolated copy and required to
be rejected by that same auditor.  Positive PowerPoint and render evidence is
never rebound to a tampered artifact: the auditor must report the stale binding
and the control-specific semantic or readability defect.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import posixpath
import shutil
import subprocess
import sys
from typing import Any, Callable
import zipfile
import xml.etree.ElementTree as ET


P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"p": P, "a": A, "c": C, "r": R}
Q = lambda namespace, local: f"{{{namespace}}}{local}"

for prefix, uri in (("a", A), ("c", C), ("p", P), ("r", R)):
    ET.register_namespace(prefix, uri)
ET.register_namespace("", REL)


CONTROL_IDS = [
    "stale-baseline-hash",
    "unauthorized-object-mutation",
    "chart-flatten",
    "chart-label-unreadable",
    "table-flatten",
    "table-cell-overflow",
    "connector-detach",
    "connector-crosses-label",
    "diagram-label-outside-node",
]

CONTROL_CASES = {
    "stale-baseline-hash": "horizontal-chart-data",
    "unauthorized-object-mutation": "horizontal-chart-data",
    "chart-flatten": "horizontal-chart-data",
    "chart-label-unreadable": "horizontal-chart-data",
    "table-flatten": "table-cell-edit",
    "table-cell-overflow": "table-cell-edit",
    "connector-detach": "connector-style-geometry",
    "connector-crosses-label": "connector-style-geometry",
    "diagram-label-outside-node": "diagram-node-move",
}

INTENDED_FAILURE_CODES = {
    "stale-baseline-hash": ("SM001",),
    "unauthorized-object-mutation": ("SM002",),
    "chart-flatten": ("SM004",),
    "chart-label-unreadable": ("SM007",),
    "table-flatten": ("SM005",),
    "table-cell-overflow": ("SM008",),
    "connector-detach": ("SM006",),
    "connector-crosses-label": ("SM009",),
    "diagram-label-outside-node": ("SM009",),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_package(path: Path) -> tuple[list[zipfile.ZipInfo], dict[str, bytes]]:
    with zipfile.ZipFile(path) as archive:
        infos = [copy.copy(item) for item in archive.infolist() if not item.is_dir()]
        parts = {item.filename: archive.read(item.filename) for item in infos}
    return infos, parts


def write_package(path: Path, infos: list[zipfile.ZipInfo], parts: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.unlink(missing_ok=True)
    seen: set[str] = set()
    with zipfile.ZipFile(temporary, "w") as archive:
        for info in infos:
            if info.filename not in parts:
                continue
            archive.writestr(info, parts[info.filename])
            seen.add(info.filename)
        for name in sorted(set(parts) - seen):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, parts[name])
    os.replace(temporary, path)


def serialize(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def slide_part(number: int) -> str:
    return f"ppt/slides/slide{number}.xml"


def relationship_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    return posixpath.join(directory, "_rels", f"{filename}.rels")


def resolve_target(owner: str, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner), target)).lstrip("/")


def nonvisual(element: ET.Element) -> ET.Element | None:
    paths = {
        Q(P, "sp"): "p:nvSpPr/p:cNvPr",
        Q(P, "grpSp"): "p:nvGrpSpPr/p:cNvPr",
        Q(P, "graphicFrame"): "p:nvGraphicFramePr/p:cNvPr",
        Q(P, "cxnSp"): "p:nvCxnSpPr/p:cNvPr",
        Q(P, "pic"): "p:nvPicPr/p:cNvPr",
    }
    path = paths.get(element.tag)
    return element.find(path, NS) if path else None


def object_name(element: ET.Element) -> str:
    props = nonvisual(element)
    return props.get("name", "") if props is not None else ""


def drawable_children(container: ET.Element) -> list[ET.Element]:
    tags = {Q(P, "sp"), Q(P, "grpSp"), Q(P, "graphicFrame"), Q(P, "cxnSp"), Q(P, "pic")}
    return [child for child in list(container) if child.tag in tags]


def locate_named(parts: dict[str, bytes], number: int, name: str) -> tuple[str, ET.Element, ET.Element, ET.Element]:
    part = slide_part(number)
    if part not in parts:
        raise ValueError(f"Missing {part} while locating {name!r}.")
    root = ET.fromstring(parts[part])
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError(f"Slide {number} has no shape tree.")

    matches = [(element, parent) for element, parent in iter_drawables(tree) if object_name(element) == name]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one {name!r} on slide {number}; found {len(matches)}.")
    return part, root, matches[0][0], matches[0][1]


def iter_drawables(container: ET.Element):
    for child in drawable_children(container):
        yield child, container
        if child.tag == Q(P, "grpSp"):
            yield from iter_drawables(child)


def locate_in_root(root: ET.Element, name: str) -> tuple[ET.Element, ET.Element]:
    tree = root.find("p:cSld/p:spTree", NS)
    if tree is None:
        raise ValueError("Slide has no shape tree.")
    matches = [(element, parent) for element, parent in iter_drawables(tree) if object_name(element) == name]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one {name!r}; found {len(matches)}.")
    return matches[0]


def frame_shape(frame: ET.Element, suffix: str) -> ET.Element:
    """Replace a graphic frame with a named native shape at the same bounds."""

    source_props = frame.find("p:nvGraphicFramePr/p:cNvPr", NS)
    source_xfrm = frame.find("p:xfrm", NS)
    if source_props is None or source_xfrm is None:
        raise ValueError("Graphic frame lacks non-visual properties or a transform.")
    shape = ET.Element(Q(P, "sp"))
    nv = ET.SubElement(shape, Q(P, "nvSpPr"))
    ET.SubElement(
        nv,
        Q(P, "cNvPr"),
        {
            "id": source_props.get("id", "1"),
            "name": source_props.get("name", f"flattened-{suffix}"),
            "descr": f"Deliberately flattened {suffix} C18 negative control",
        },
    )
    ET.SubElement(nv, Q(P, "cNvSpPr"))
    ET.SubElement(nv, Q(P, "nvPr"))
    shape_props = ET.SubElement(shape, Q(P, "spPr"))
    xfrm = ET.SubElement(shape_props, Q(A, "xfrm"))
    for child in list(source_xfrm):
        xfrm.append(copy.deepcopy(child))
    geometry = ET.SubElement(shape_props, Q(A, "prstGeom"), {"prst": "rect"})
    ET.SubElement(geometry, Q(A, "avLst"))
    text_body = ET.SubElement(shape, Q(P, "txBody"))
    ET.SubElement(text_body, Q(A, "bodyPr"))
    ET.SubElement(text_body, Q(A, "lstStyle"))
    paragraph = ET.SubElement(text_body, Q(A, "p"))
    run = ET.SubElement(paragraph, Q(A, "r"))
    ET.SubElement(run, Q(A, "rPr"), {"lang": "en-US", "sz": "1400"})
    ET.SubElement(run, Q(A, "t")).text = f"Flattened {suffix}"
    ET.SubElement(paragraph, Q(A, "endParaRPr"), {"lang": "en-US", "sz": "1400"})
    return shape


def replace_element(parent: ET.Element, source: ET.Element, replacement: ET.Element) -> None:
    index = list(parent).index(source)
    parent.remove(source)
    parent.insert(index, replacement)


def mutate_unauthorized_object(parts: dict[str, bytes]) -> None:
    part, root, shape, _ = locate_named(parts, 1, "surface-01-title")
    text = shape.find("p:txBody/a:p//a:t", NS)
    if text is None:
        raise ValueError("Unrelated title has no editable text to tamper.")
    text.text = (text.text or "") + " — unauthorized"
    parts[part] = serialize(root)


def mutate_chart_flatten(parts: dict[str, bytes]) -> None:
    part, root, frame, parent = locate_named(parts, 2, "surface-02-bar-chart")
    if frame.tag != Q(P, "graphicFrame"):
        raise ValueError("Horizontal chart is not a graphic frame before flattening.")
    replace_element(parent, frame, frame_shape(frame, "chart"))
    parts[part] = serialize(root)


def chart_part_for_frame(parts: dict[str, bytes], slide_owner: str, frame: ET.Element) -> str:
    chart = frame.find("a:graphic/a:graphicData/c:chart", NS)
    rel_id = chart.get(Q(R, "id")) if chart is not None else None
    if not rel_id:
        raise ValueError("Chart frame has no embedded chart relationship.")
    rel_name = relationship_part(slide_owner)
    rel_root = ET.fromstring(parts[rel_name])
    relationship = next((item for item in rel_root if item.get("Id") == rel_id), None)
    if relationship is None:
        raise ValueError(f"Chart relationship {rel_id!r} was not found.")
    target = resolve_target(slide_owner, relationship.get("Target", ""))
    if target not in parts:
        raise ValueError(f"Chart part {target!r} was not found.")
    return target


def unreadable_text_properties() -> ET.Element:
    tx_pr = ET.Element(Q(C, "txPr"))
    ET.SubElement(tx_pr, Q(A, "bodyPr"))
    ET.SubElement(tx_pr, Q(A, "lstStyle"))
    paragraph = ET.SubElement(tx_pr, Q(A, "p"))
    paragraph_props = ET.SubElement(paragraph, Q(A, "pPr"))
    ET.SubElement(paragraph_props, Q(A, "defRPr"), {"sz": "600"})
    ET.SubElement(paragraph, Q(A, "endParaRPr"), {"lang": "en-US", "sz": "600"})
    return tx_pr


def mutate_chart_label_unreadable(parts: dict[str, bytes]) -> None:
    owner, _, frame, _ = locate_named(parts, 2, "surface-02-bar-chart")
    target = chart_part_for_frame(parts, owner, frame)
    root = ET.fromstring(parts[target])
    changed = 0
    for props in root.findall(".//a:defRPr", NS) + root.findall(".//a:rPr", NS) + root.findall(".//a:endParaRPr", NS):
        props.set("sz", "600")
        changed += 1
    axes = root.findall(".//c:catAx", NS) + root.findall(".//c:valAx", NS)
    if not axes:
        chart = root.find("c:chart", NS)
        if chart is None:
            raise ValueError("Chart part has neither axes nor a chart node.")
        axes = [chart]
    for axis in axes:
        for existing in axis.findall("c:txPr", NS):
            axis.remove(existing)
        axis.append(unreadable_text_properties())
        changed += 1
    if not changed:
        raise ValueError("No chart label typography was available to shrink.")
    parts[target] = serialize(root)


def mutate_table_flatten(parts: dict[str, bytes]) -> None:
    part, root, frame, parent = locate_named(parts, 3, "surface-03-table")
    if frame.tag != Q(P, "graphicFrame"):
        raise ValueError("Table is not a graphic frame before flattening.")
    replace_element(parent, frame, frame_shape(frame, "table"))
    parts[part] = serialize(root)


def mutate_table_cell_overflow(parts: dict[str, bytes]) -> None:
    part, root, frame, _ = locate_named(parts, 3, "surface-03-table")
    table = frame.find("a:graphic/a:graphicData/a:tbl", NS)
    if table is None:
        raise ValueError("Native table XML was not found.")
    rows = table.findall("a:tr", NS)
    if len(rows) < 4:
        raise ValueError("Native table has fewer than four rows.")
    cells = rows[3].findall("a:tc", NS)
    if len(cells) < 3:
        raise ValueError("Native table row four has fewer than three cells.")
    target = cells[2]
    texts = target.findall("a:txBody/a:p//a:t", NS)
    if not texts:
        raise ValueError("Target table cell has no text run.")
    texts[0].text = "Verified " + ("W" * 320)
    for extra in texts[1:]:
        extra.text = ""
    body = target.find("a:txBody/a:bodyPr", NS)
    if body is not None:
        body.set("wrap", "none")
    parts[part] = serialize(root)


def mutate_connector_detach(parts: dict[str, bytes]) -> None:
    part, root, connector, _ = locate_named(parts, 4, "surface-04-connector-b")
    props = connector.find("p:nvCxnSpPr/p:cNvCxnSpPr", NS)
    start = props.find("a:stCxn", NS) if props is not None else None
    if props is None or start is None:
        raise ValueError("Connector B is already detached at its start.")
    props.remove(start)
    parts[part] = serialize(root)


def mutate_connector_crosses_label(parts: dict[str, bytes]) -> None:
    part, root, connector, _ = locate_named(parts, 4, "surface-04-connector-b")
    xfrm = connector.find("p:spPr/a:xfrm", NS)
    off = xfrm.find("a:off", NS) if xfrm is not None else None
    ext = xfrm.find("a:ext", NS) if xfrm is not None else None
    if xfrm is None or off is None or ext is None:
        raise ValueError("Connector B has no editable geometry.")
    # Draw through the non-endpoint source label and structure label while
    # retaining the declared structure-to-delivery attachment records.
    source_label, _ = locate_in_root(root, "surface-04-source-text")
    delivery_label, _ = locate_in_root(root, "surface-04-delivery-text")
    source_xfrm = transform(source_label)
    delivery_xfrm = transform(delivery_label)
    source_off = source_xfrm.find("a:off", NS) if source_xfrm is not None else None
    source_ext = source_xfrm.find("a:ext", NS) if source_xfrm is not None else None
    delivery_off = delivery_xfrm.find("a:off", NS) if delivery_xfrm is not None else None
    delivery_ext = delivery_xfrm.find("a:ext", NS) if delivery_xfrm is not None else None
    if source_off is None or source_ext is None or delivery_off is None or delivery_ext is None:
        raise ValueError("Source or delivery label lacks an editable transform.")
    left = int(source_off.get("x", "0"))
    right = int(delivery_off.get("x", "0")) + int(delivery_ext.get("cx", "0"))
    mid_y = int(source_off.get("y", "0")) + int(source_ext.get("cy", "0")) // 2
    off.set("x", str(left))
    off.set("y", str(mid_y))
    ext.set("cx", str(right - left))
    ext.set("cy", "0")
    xfrm.attrib.pop("flipH", None)
    xfrm.attrib.pop("flipV", None)
    parts[part] = serialize(root)


def transform(element: ET.Element) -> ET.Element | None:
    if element.tag == Q(P, "grpSp"):
        return element.find("p:grpSpPr/a:xfrm", NS)
    if element.tag == Q(P, "graphicFrame"):
        return element.find("p:xfrm", NS)
    return element.find("p:spPr/a:xfrm", NS)


def mutate_diagram_label_outside_node(parts: dict[str, bytes]) -> None:
    part, root, node, _ = locate_named(parts, 4, "surface-04-structure")
    label, _ = locate_in_root(root, "surface-04-structure-text")
    node_xfrm = transform(node)
    label_xfrm = transform(label)
    node_off = node_xfrm.find("a:off", NS) if node_xfrm is not None else None
    node_ext = node_xfrm.find("a:ext", NS) if node_xfrm is not None else None
    label_off = label_xfrm.find("a:off", NS) if label_xfrm is not None else None
    if node_off is None or node_ext is None or label_off is None:
        raise ValueError("Diagram node or label lacks an editable transform.")
    label_off.set("x", str(int(node_off.get("x", "0")) + int(node_ext.get("cx", "0")) + 9525))
    label_off.set("y", node_off.get("y", "0"))
    parts[part] = serialize(root)


MUTATIONS: dict[str, Callable[[dict[str, bytes]], None] | None] = {
    "stale-baseline-hash": None,
    "unauthorized-object-mutation": mutate_unauthorized_object,
    "chart-flatten": mutate_chart_flatten,
    "chart-label-unreadable": mutate_chart_label_unreadable,
    "table-flatten": mutate_table_flatten,
    "table-cell-overflow": mutate_table_cell_overflow,
    "connector-detach": mutate_connector_detach,
    "connector-crosses-label": mutate_connector_crosses_label,
    "diagram-label-outside-node": mutate_diagram_label_outside_node,
}


def validate_powerpoint_report(source_report: Any, case_id: str) -> None:
    if not isinstance(source_report, dict) or source_report.get("schemaVersion") != "slidewright-semantic-mutation-powerpoint/v1":
        raise ValueError("PowerPoint mutation report has an unsupported schemaVersion.")
    cases = source_report.get("cases")
    if not isinstance(cases, list):
        raise ValueError("PowerPoint mutation report has no cases list.")
    matches = [item for item in cases if isinstance(item, dict) and item.get("id") == case_id]
    if len(matches) != 1:
        raise ValueError(f"PowerPoint mutation report must contain exactly one {case_id!r} case.")


def audit_command(
    audit_script: Path,
    baseline: Path,
    variant: Path,
    mutation_contract: Path,
    case_id: str,
    baseline_contract: Path,
    powerpoint_report: Path,
    render_evidence: Path,
    output_json: Path,
) -> list[str]:
    return [
        sys.executable,
        str(audit_script),
        str(baseline),
        str(variant),
        str(mutation_contract),
        "--case",
        case_id,
        "--baseline-contract",
        str(baseline_contract),
        "--powerpoint-report",
        str(powerpoint_report),
        "--render-evidence",
        str(render_evidence),
        "--json",
        str(output_json),
    ]


def run_audit(command: list[str], report_path: Path) -> tuple[int, dict[str, Any] | None]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    report: dict[str, Any] | None = None
    if report_path.is_file():
        try:
            candidate = read_json(report_path)
            if isinstance(candidate, dict):
                report = candidate
        except (OSError, json.JSONDecodeError):
            report = None
    return result.returncode, report


def failure_codes(report: dict[str, Any] | None) -> list[str]:
    if not isinstance(report, dict):
        return []
    failures = report.get("failures")
    if not isinstance(failures, list):
        return []
    return sorted({item.get("code") for item in failures if isinstance(item, dict) and isinstance(item.get("code"), str)})


def write_summary(path: Path, summary: dict[str, Any]) -> None:
    payload = json.dumps(summary, indent=2, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    sys.stdout.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline_pptx", type=Path)
    parser.add_argument("variants_dir", type=Path)
    parser.add_argument("mutation_contract", type=Path)
    parser.add_argument("baseline_contract", type=Path)
    parser.add_argument("powerpoint_report", type=Path)
    parser.add_argument("render_evidence_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--audit-script", required=True, type=Path)
    parser.add_argument("--json", dest="json_path", required=True, type=Path)
    args = parser.parse_args()

    required_files = [
        args.baseline_pptx,
        args.mutation_contract,
        args.baseline_contract,
        args.powerpoint_report,
        args.audit_script,
    ]
    missing = [str(path) for path in required_files if not path.is_file()]
    if missing:
        parser.error(f"Required file(s) not found: {', '.join(missing)}")
    if not args.variants_dir.is_dir():
        parser.error(f"Variants directory not found: {args.variants_dir}")
    if not args.render_evidence_dir.is_dir():
        parser.error(f"Render-evidence directory not found: {args.render_evidence_dir}")

    mutation_contract = read_json(args.mutation_contract)
    if not isinstance(mutation_contract, dict) or mutation_contract.get("schemaVersion") != "slidewright-semantic-mutation/v1":
        parser.error("Mutation contract must use slidewright-semantic-mutation/v1.")
    if mutation_contract.get("negativeControls") != CONTROL_IDS:
        parser.error("Mutation contract negativeControls must exactly match the C18 control inventory.")
    case_ids = [item.get("id") for item in mutation_contract.get("cases", []) if isinstance(item, dict)]
    if len(case_ids) != len(set(case_ids)) or set(CONTROL_CASES.values()) - set(case_ids):
        parser.error("Mutation contract is missing a unique case needed by the negative controls.")

    variants = {case_id: args.variants_dir / f"{case_id}.pptx" for case_id in case_ids}
    missing_variants = [str(path) for path in variants.values() if not path.is_file()]
    if missing_variants:
        parser.error(f"Mutation variant(s) not found: {', '.join(missing_variants)}")
    source_powerpoint_report = read_json(args.powerpoint_report)
    for case_id in case_ids:
        validate_powerpoint_report(source_powerpoint_report, case_id)
    render_evidence = {case_id: args.render_evidence_dir / f"{case_id}.json" for case_id in case_ids}
    missing_evidence = [str(path) for path in render_evidence.values() if not path.is_file()]
    if missing_evidence:
        parser.error(f"Render evidence not found: {', '.join(missing_evidence)}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    positive_dir = args.output_dir / "positive-audits"
    if positive_dir.exists():
        shutil.rmtree(positive_dir)
    positive_dir.mkdir(parents=True)

    positive_audits: list[dict[str, Any]] = []
    for case_id in case_ids:
        audit_path = positive_dir / f"{case_id}.json"
        command = audit_command(
            args.audit_script,
            args.baseline_pptx,
            variants[case_id],
            args.mutation_contract,
            case_id,
            args.baseline_contract,
            args.powerpoint_report,
            render_evidence[case_id],
            audit_path,
        )
        return_code, report = run_audit(command, audit_path)
        valid = bool(
            return_code == 0
            and report
            and report.get("schemaVersion") == "slidewright-semantic-mutation-audit/v1"
            and report.get("valid") is True
        )
        positive_audits.append(
            {
                "caseId": case_id,
                "valid": valid,
                "returnCode": return_code,
                "failureCodes": failure_codes(report),
                "failureCount": len(report.get("failures", [])) if isinstance(report, dict) and isinstance(report.get("failures"), list) else 0,
                "variantSha256": sha256_file(variants[case_id]),
                "renderEvidenceSha256": sha256_file(render_evidence[case_id]),
                "auditReport": f"positive-audits/{case_id}.json",
            }
        )

    baseline_valid = all(item["valid"] for item in positive_audits)
    if not baseline_valid:
        controls = [
            {
                "id": control_id,
                "caseId": CONTROL_CASES[control_id],
                "expectedRejection": True,
                "actualRejection": False,
                "rejected": False,
                "failureCodes": [],
                "failureCount": 0,
                "intendedFailureCodes": list(INTENDED_FAILURE_CODES[control_id]),
                "matchedIntendedFailureCodes": [],
                "skippedReason": "positive mutation audit failed",
            }
            for control_id in CONTROL_IDS
        ]
        summary = {
            "schemaVersion": "slidewright-semantic-mutation-negative-controls/v1",
            "version": "semantic-mutation-negative-controls-v1",
            "valid": False,
            "baselineValid": False,
            "positiveAudits": positive_audits,
            "controls": controls,
            "rejected": 0,
            "rejectedCount": 0,
            "total": len(CONTROL_IDS),
        }
        write_summary(args.json_path, summary)
        return 2

    controls: list[dict[str, Any]] = []
    for control_id in CONTROL_IDS:
        case_id = CONTROL_CASES[control_id]
        folder = args.output_dir / control_id
        if folder.exists():
            shutil.rmtree(folder)
        folder.mkdir(parents=True)
        variant = folder / f"{control_id}.pptx"
        mutate = MUTATIONS[control_id]
        if mutate is None:
            shutil.copyfile(variants[case_id], variant)
        else:
            infos, parts = read_package(variants[case_id])
            mutate(parts)
            write_package(variant, infos, parts)

        control_contract_path = folder / "mutation-contract.json"
        control_contract = copy.deepcopy(mutation_contract)
        if control_id == "stale-baseline-hash":
            baseline_binding = control_contract.get("baselineContract")
            if not isinstance(baseline_binding, dict) or not isinstance(baseline_binding.get("sha256"), str):
                raise ValueError("Mutation contract has no baselineContract.sha256 to stale.")
            original_hash = baseline_binding["sha256"]
            baseline_binding["sha256"] = ("0" if original_hash[:1] != "0" else "1") + original_hash[1:]
            write_json(control_contract_path, control_contract)
        else:
            shutil.copyfile(args.mutation_contract, control_contract_path)

        control_report_path = folder / "powerpoint-report.json"
        # This is an unchanged copy of trusted evidence.  Rebinding its output
        # or SHA to a tampered deck would make the harness an evidence forger.
        shutil.copyfile(args.powerpoint_report, control_report_path)
        audit_path = folder / "audit.json"
        command = audit_command(
            args.audit_script,
            args.baseline_pptx,
            variant,
            control_contract_path,
            case_id,
            args.baseline_contract,
            control_report_path,
            render_evidence[case_id],
            audit_path,
        )
        return_code, report = run_audit(command, audit_path)
        codes = failure_codes(report)
        intended_codes = list(INTENDED_FAILURE_CODES[control_id])
        matched_intended_codes = [code for code in intended_codes if code in codes]
        count = len(report.get("failures", [])) if isinstance(report, dict) and isinstance(report.get("failures"), list) else 0
        rejected = bool(
            return_code == 2
            and report
            and report.get("schemaVersion") == "slidewright-semantic-mutation-audit/v1"
            and report.get("valid") is False
            and count > 0
            and matched_intended_codes
        )
        controls.append(
            {
                "id": control_id,
                "caseId": case_id,
                "expectedRejection": True,
                "actualRejection": rejected,
                "rejected": rejected,
                "returnCode": return_code,
                "failureCodes": codes,
                "failureCount": count,
                "intendedFailureCodes": intended_codes,
                "matchedIntendedFailureCodes": matched_intended_codes,
                "artifactSha256": sha256_file(variant),
                "contractSha256": sha256_file(control_contract_path),
                "powerPointReportSha256": sha256_file(control_report_path),
                "renderEvidenceSha256": sha256_file(render_evidence[case_id]),
                "artifact": f"{control_id}/{control_id}.pptx",
                "auditReport": f"{control_id}/audit.json",
            }
        )

    rejected_count = sum(1 for item in controls if item["rejected"])
    valid = baseline_valid and rejected_count == len(CONTROL_IDS)
    summary = {
        "schemaVersion": "slidewright-semantic-mutation-negative-controls/v1",
        "version": "semantic-mutation-negative-controls-v1",
        "valid": valid,
        "baselineValid": baseline_valid,
        "positiveAudits": positive_audits,
        "controls": controls,
        "rejected": rejected_count,
        "rejectedCount": rejected_count,
        "total": len(CONTROL_IDS),
    }
    write_summary(args.json_path, summary)
    return 0 if valid else 2


if __name__ == "__main__":
    raise SystemExit(main())
