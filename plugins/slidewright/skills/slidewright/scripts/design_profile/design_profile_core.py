#!/usr/bin/env python3
"""Deterministic, fail-closed OOXML design-profile mechanics for Slidewright."""

from __future__ import annotations

import hashlib
import json
import posixpath
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SHAPES = {"sp", "grpSp", "pic", "graphicFrame", "cxnSp"}
PAIR_WORDS = re.compile(r"rail|rim|limit(?:er)?|divider|rule|border", re.I)
CHROME_WORDS = re.compile(
    r"(?:^|[-_\s])(logo|brand|rail|rim|limit(?:er)?|divider|footer|header|chrome|rule|border|page|slide[-_\s]?number)(?:$|[-_\s])",
    re.I,
)
COLOR_MODELS = {"srgbClr", "sysClr", "schemeClr", "prstClr"}
COLOR_TRANSFORMS = {
    "alpha", "alphaMod", "alphaOff", "blue", "blueMod", "blueOff", "comp", "gamma", "gray",
    "green", "greenMod", "greenOff", "hue", "hueMod", "hueOff", "inv", "invGamma", "lum",
    "lumMod", "lumOff", "red", "redMod", "redOff", "sat", "satMod", "satOff", "shade", "tint",
}
VALUELESS_COLOR_TRANSFORMS = {"comp", "gamma", "gray", "inv", "invGamma"}
FILL_MODELS = {"solidFill", "noFill", "grpFill"}


class ProfileError(ValueError):
    """Source or derived deck violates the bounded v1 contract."""


def lname(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def canonical_hash(value: Any) -> str:
    return sha(canonical(value))



def portable_integrity_projection(value: Any) -> Any:
    """Normalize JSON values identically after a Python/JavaScript parse."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        rendered = format(value, ".15g") if isinstance(value, float) and not value.is_integer() else str(int(value))
        return {"$number": rendered}
    if isinstance(value, list):
        return [portable_integrity_projection(item) for item in value]
    if isinstance(value, dict):
        return {key: portable_integrity_projection(value[key]) for key in sorted(value)}
    raise ProfileError(f"Unsupported profile integrity value {type(value).__name__}.")


def portable_integrity_hash(value: Any) -> str:
    return canonical_hash(portable_integrity_projection(value))

def number(value: str | None, default: int = 0) -> int:
    try:
        return default if value in (None, "") else int(value)
    except ValueError as error:
        raise ProfileError(f"Expected integer OOXML value, got {value!r}.") from error


def child(node: ET.Element | None, name: str) -> ET.Element | None:
    if node is None:
        return None
    return next((item for item in node if lname(item.tag) == name), None)


def attrs(node: ET.Element | None) -> dict[str, str]:
    return {} if node is None else {lname(key): value for key, value in sorted(node.attrib.items())}


def rel_part(owner: str) -> str:
    directory, filename = posixpath.split(owner)
    return posixpath.join(directory, "_rels", filename + ".rels")


def rel_owner(name: str) -> str | None:
    if name == "_rels/.rels":
        return None
    if "/_rels/" not in name or not name.endswith(".rels"):
        return None
    directory, filename = name.split("/_rels/", 1)
    return f"{directory}/{filename[:-5]}"


def resolve(owner: str | None, target: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(owner) if owner else "", target)).lstrip("/")


def read_package(path: Path) -> tuple[dict[str, bytes], list[dict[str, str]]]:
    try:
        with zipfile.ZipFile(path) as archive:
            parts = {item.filename: archive.read(item.filename) for item in archive.infolist() if not item.is_dir()}
    except (OSError, zipfile.BadZipFile) as error:
        raise ProfileError(f"Cannot read PPTX package: {error}") from error
    if "ppt/presentation.xml" not in parts:
        raise ProfileError("Missing ppt/presentation.xml.")
    relationships = []
    for name in sorted(part for part in parts if part.endswith(".rels")):
        root = ET.fromstring(parts[name])
        owner = rel_owner(name)
        seen = set()
        for item in root:
            rel_id = item.get("Id", "")
            if not rel_id or rel_id in seen:
                raise ProfileError(f"{name} has missing or duplicate relationship IDs.")
            seen.add(rel_id)
            target = item.get("Target", "")
            mode = item.get("TargetMode", "")
            resolved = "" if mode == "External" else resolve(owner, target)
            if mode != "External" and resolved not in parts:
                raise ProfileError(f"{name} targets missing part {resolved}.")
            relationships.append(
                {
                    "owner": owner or "",
                    "type": item.get("Type", ""),
                    "targetMode": mode,
                    "target": target,
                    "resolvedTarget": resolved,
                }
            )
    relationships.sort(key=lambda x: (x["owner"], x["type"], x["targetMode"], x["target"]))
    return parts, relationships


def rel_map(parts: dict[str, bytes], owner: str) -> dict[str, str]:
    name = rel_part(owner)
    if name not in parts:
        return {}
    result = {}
    for item in ET.fromstring(parts[name]):
        if item.get("TargetMode", "") != "External":
            result[item.get("Id", "")] = resolve(owner, item.get("Target", ""))
    return result


def color(node: ET.Element | None, context: str) -> dict[str, Any] | None:
    if node is None:
        return None
    value = node if lname(node.tag).endswith("Clr") else next(
        (item for item in node if lname(item.tag).endswith("Clr")), None
    )
    if value is None:
        return None
    kind = lname(value.tag)
    if kind not in COLOR_MODELS:
        raise ProfileError(f"Unsupported v1 color model {kind} in {context}.")
    transforms = []
    for transform in value:
        transform_kind = lname(transform.tag)
        if (
            not transform.tag.startswith(f"{{{A}}}")
            or transform_kind not in COLOR_TRANSFORMS
            or list(transform)
        ):
            raise ProfileError(f"Unsupported v1 color transform in {context}: {transform_kind}.")
        attributes = attrs(transform)
        if transform_kind in VALUELESS_COLOR_TRANSFORMS:
            if attributes:
                raise ProfileError(f"Valueless color transform {transform_kind} has attributes in {context}.")
        elif set(attributes) != {"val"}:
            raise ProfileError(f"Color transform {transform_kind} must have exactly one val attribute in {context}.")
        transforms.append({"kind": transform_kind, "attributes": attributes})
    if kind == "srgbClr":
        result = {"kind": kind, "value": value.get("val", "").upper()}
    elif kind == "sysClr":
        result = {"kind": kind, "value": value.get("lastClr", "").upper(), "system": value.get("val", "")}
    else:
        result = {"kind": kind, "value": value.get("val", "")}
    if transforms:
        result["transforms"] = transforms
    return result


def fill(node: ET.Element | None, context: str) -> dict[str, Any]:
    selected = None if node is None else next(
        (item for item in node if lname(item.tag).endswith("Fill") or lname(item.tag) == "grpFill"), None
    )
    if selected is None:
        return {"kind": "inherit"}
    kind = lname(selected.tag)
    if kind not in FILL_MODELS:
        raise ProfileError(f"Unsupported v1 fill {kind} in {context}.")
    return {"kind": kind, "color": color(selected, context)} if kind == "solidFill" else {"kind": kind}


def line(node: ET.Element | None, context: str) -> dict[str, Any]:
    value = child(node, "ln")
    if value is None:
        return {"kind": "inherit"}
    dash = child(value, "prstDash")
    return {
        "kind": "line",
        "widthEmu": number(value.get("w")),
        "cap": value.get("cap", ""),
        "compound": value.get("cmpd", ""),
        "alignment": value.get("algn", ""),
        "dash": dash.get("val", "") if dash is not None else "solid",
        "fill": fill(value, context + "/line"),
        "xmlSha256": sha(ET.tostring(value, encoding="utf-8")),
    }


def geometry(shape: ET.Element) -> dict[str, int] | None:
    properties = next((item for item in shape if lname(item.tag) in {"spPr", "grpSpPr", "xfrm"}), None)
    if properties is None:
        return None
    xfrm = properties if lname(properties.tag) == "xfrm" else child(properties, "xfrm")
    if xfrm is None:
        return None
    off, ext = child(xfrm, "off"), child(xfrm, "ext")
    if off is None or ext is None:
        return None
    return {
        "xEmu": number(off.get("x")),
        "yEmu": number(off.get("y")),
        "widthEmu": number(ext.get("cx")),
        "heightEmu": number(ext.get("cy")),
        "rotation": number(xfrm.get("rot")),
        "flipH": 1 if xfrm.get("flipH") in {"1", "true"} else 0,
        "flipV": 1 if xfrm.get("flipV") in {"1", "true"} else 0,
    }


def run_format(node: ET.Element | None, context: str) -> dict[str, Any]:
    if node is None:
        return {}
    fonts = {}
    for key in ("latin", "ea", "cs"):
        value = child(node, key)
        if value is not None and value.get("typeface"):
            fonts[key] = value.get("typeface", "")
    solid = child(node, "solidFill")
    return {
        "sizePt": number(node.get("sz")) / 100 if node.get("sz") else None,
        "bold": node.get("b", "") in {"1", "true"},
        "italic": node.get("i", "") in {"1", "true"},
        "underline": node.get("u", ""),
        "fonts": fonts,
        "color": color(solid, context) if solid is not None else None,
    }


def text_data(shape: ET.Element, context: str) -> dict[str, Any] | None:
    body = next((item for item in shape.iter() if lname(item.tag) == "txBody"), None)
    if body is None:
        return None
    paragraphs, fonts, sizes = [], set(), set()
    for p_index, paragraph in enumerate(item for item in body if lname(item.tag) == "p"):
        runs = []
        for r_index, run in enumerate(item for item in paragraph if lname(item.tag) in {"r", "fld"}):
            formatting = run_format(child(run, "rPr"), f"{context}/p{p_index}/r{r_index}")
            fonts.update(formatting.get("fonts", {}).values())
            if formatting.get("sizePt") is not None:
                sizes.add(formatting["sizePt"])
            node = child(run, "t")
            runs.append({"text": "" if node is None or node.text is None else node.text, "format": formatting})
        paragraph_properties = child(paragraph, "pPr")
        paragraphs.append(
            {
                "runs": runs,
                "properties": attrs(paragraph_properties),
                "propertiesXmlSha256": "" if paragraph_properties is None else sha(ET.tostring(paragraph_properties, encoding="utf-8")),
                "xmlSha256": sha(ET.tostring(paragraph, encoding="utf-8")),
                "endParagraphFormat": run_format(child(paragraph, "endParaRPr"), context),
            }
        )
    body_properties = child(body, "bodyPr")
    return {
        "plainText": "\n".join("".join(run["text"] for run in paragraph["runs"]) for paragraph in paragraphs),
        "paragraphs": paragraphs,
        "fonts": sorted(fonts),
        "fontSizesPt": sorted(sizes),
        "bodyProperties": attrs(body_properties),
        "bodyPropertiesXmlSha256": "" if body_properties is None else sha(ET.tostring(body_properties, encoding="utf-8")),
    }


def object_records(parts: dict[str, bytes]) -> list[dict[str, Any]]:
    result = []
    patterns = r"ppt/(?:slides/slide|slideLayouts/slideLayout|slideMasters/slideMaster)\d+\.xml"
    for part in sorted(name for name in parts if re.fullmatch(patterns, name)):
        root, relationships, order = ET.fromstring(parts[part]), rel_map(parts, part), 0

        def visit(node: ET.Element, path: str) -> None:
            nonlocal order
            for index, item in enumerate(list(node)):
                item_path = f"{path}/{index}"
                if lname(item.tag) in SHAPES:
                    non_visual = next((x for x in item.iter() if lname(x.tag) == "cNvPr"), None)
                    name = "" if non_visual is None else non_visual.get("name", "")
                    properties = next((x for x in item if lname(x.tag) in {"spPr", "grpSpPr"}), None)
                    context = f"{part}:{name or item_path}"
                    media = []
                    targets = {
                        relationships[value]
                        for x in item.iter()
                        for key, value in x.attrib.items()
                        if key in {f"{{{R}}}embed", f"{{{R}}}link"} and value in relationships
                    }
                    for target in sorted(targets):
                        if target.startswith("ppt/media/") and target in parts:
                            media.append({"part": target, "sha256": sha(parts[target])})
                    text = text_data(item, context)
                    ph = next((x for x in item.iter() if lname(x.tag) == "ph"), None)
                    placeholder = None
                    if ph is not None:
                        raw_placeholder = attrs(ph)
                        raw_type = raw_placeholder.get("type", "")
                        type_map = {"title": "title", "ctrTitle": "title", "subTitle": "subtitle", "body": "body", "obj": "body", "ftr": "footer", "dt": "date", "sldNum": "slide-number"}
                        normalized_type = type_map.get(raw_type, "body" if raw_placeholder.get("idx") is not None else "other")
                        raw_index = raw_placeholder.get("idx", "0")
                        placeholder = {"type": normalized_type, "index": int(raw_index), "raw": raw_placeholder}
                    record = {
                        "objectKey": f"{part}::{item_path}::{name}",
                        "part": part,
                        "path": item_path,
                        "order": order,
                        "type": lname(item.tag),
                        "semanticKind": (
                            "chart" if any(lname(node.tag) == "chart" for node in item.iter())
                            else "table" if any(lname(node.tag) == "tbl" for node in item.iter())
                            else lname(item.tag)
                        ),
                        "id": "" if non_visual is None else non_visual.get("id", ""),
                        "creationId": next(
                            (
                                value.get("id", "")
                                for value in item.iter()
                                if lname(value.tag) == "creationId" and value.get("id")
                            ),
                            "",
                        ),
                        "name": name,
                        "title": "" if non_visual is None else non_visual.get("title", ""),
                        "description": "" if non_visual is None else non_visual.get("descr", ""),
                        "geometry": geometry(item),
                        "fill": fill(properties, context),
                        "line": line(properties, context),
                        "text": text,
                        "placeholder": placeholder,
                        "media": media,
                        "xmlSha256": sha(ET.tostring(item, encoding="utf-8")),
                    }
                    record["styleFingerprint"] = canonical_hash(
                        {
                            "type": record["type"],
                            "name": name,
                            "geometry": record["geometry"],
                            "fill": record["fill"],
                            "line": record["line"],
                            "textFormats": None if text is None else [
                                [run["format"] for run in paragraph["runs"]] for paragraph in text["paragraphs"]
                            ],
                            "bodyProperties": None if text is None else text["bodyProperties"],
                            "media": media,
                        }
                    )
                    result.append(record)
                    order += 1
                visit(item, item_path)

        visit(root, "")
    return sorted(result, key=lambda item: (item["part"], item["order"], item["path"]))


def spacing_records(parts: dict[str, bytes]) -> list[dict[str, Any]]:
    """Capture text inset/fit and paragraph-spacing XML explicitly across the deck."""
    accepted_parts = re.compile(
        r"ppt/(?:presentation|slides/slide\d+|slideLayouts/slideLayout\d+|slideMasters/slideMaster\d+|tableStyles)\.xml"
    )
    spacing_nodes = {"bodyPr", "pPr", "defPPr", "lnSpc", "spcBef", "spcAft", "tcPr"}
    result: list[dict[str, Any]] = []
    for part in sorted(name for name in parts if accepted_parts.fullmatch(name)):
        root = ET.fromstring(parts[part])

        def visit(node: ET.Element, path: str) -> None:
            for index, item in enumerate(list(node)):
                item_path = f"{path}/{index}"
                if lname(item.tag) in spacing_nodes or re.fullmatch(r"lvl\d+pPr", lname(item.tag)):
                    result.append(
                        {
                            "part": part,
                            "path": item_path,
                            "kind": lname(item.tag),
                            "attributes": attrs(item),
                            "xmlSha256": sha(ET.tostring(item, encoding="utf-8")),
                        }
                    )
                visit(item, item_path)

        visit(root, "")
    return result


def inheritance_chains(parts: dict[str, bytes]) -> list[dict[str, str]]:
    chains = []
    for slide in sorted(name for name in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)):
        layout = slide_layout(parts, slide)
        layout_relationships = rel_map(parts, layout) if layout else {}
        master = next(
            (target for target in layout_relationships.values() if target.startswith("ppt/slideMasters/")),
            "",
        )
        master_relationships = rel_map(parts, master) if master else {}
        theme = next(
            (target for target in master_relationships.values() if target.startswith("ppt/theme/")),
            "",
        )
        chains.append({"slidePart": slide, "layoutPart": layout, "masterPart": master, "themePart": theme})
    return chains


def themes(parts: dict[str, bytes]) -> list[dict[str, Any]]:
    result = []
    for part in sorted(name for name in parts if re.fullmatch(r"ppt/theme/theme\d+\.xml", name)):
        root = ET.fromstring(parts[part])
        palette, fonts = {}, {}
        scheme = next((x for x in root.iter() if lname(x.tag) == "clrScheme"), None)
        if scheme is not None:
            for slot in scheme:
                palette[lname(slot.tag)] = color(slot, f"{part}/{lname(slot.tag)}")
        font_scheme = next((x for x in root.iter() if lname(x.tag) == "fontScheme"), None)
        if font_scheme is not None:
            for family_name in ("majorFont", "minorFont"):
                family = child(font_scheme, family_name)
                if family is not None:
                    fonts[family_name] = {
                        key: (child(family, key).get("typeface", "") if child(family, key) is not None else "")
                        for key in ("latin", "ea", "cs")
                    }
        result.append(
            {
                "part": part,
                "sha256": sha(parts[part]),
                "name": root.get("name", ""),
                "colors": {key: palette[key] for key in sorted(palette)},
                "fonts": fonts,
            }
        )
    return result


def named_parts(parts: dict[str, bytes], kind: str) -> list[dict[str, str]]:
    pattern = {
        "masters": r"ppt/slideMasters/slideMaster\d+\.xml",
        "layouts": r"ppt/slideLayouts/slideLayout\d+\.xml",
    }[kind]
    result = []
    for part in sorted(name for name in parts if re.fullmatch(pattern, name)):
        root = ET.fromstring(parts[part])
        common = next((x for x in root.iter() if lname(x.tag) == "cSld"), None)
        relationships = rel_part(part)
        result.append(
            {
                "part": part,
                "sha256": sha(parts[part]),
                "name": common.get("name", "") if common is not None else "",
                "relationshipSha256": sha(parts[relationships]) if relationships in parts else "",
            }
        )
    return result


def slide_size(parts: dict[str, bytes]) -> dict[str, Any]:
    root = ET.fromstring(parts["ppt/presentation.xml"])
    value = next((x for x in root if lname(x.tag) == "sldSz"), None)
    if value is None:
        raise ProfileError("Presentation has no p:sldSz.")
    return {"widthEmu": number(value.get("cx")), "heightEmu": number(value.get("cy")), "type": value.get("type", "")}


def guides(parts: dict[str, bytes]) -> list[dict[str, Any]]:
    if "ppt/viewProps.xml" not in parts:
        return []
    root, result = ET.fromstring(parts["ppt/viewProps.xml"]), []
    for index, item in enumerate(x for x in root.iter() if lname(x.tag) in {"guide", "sldGuide"}):
        values = attrs(item)
        position = values.get("pos", values.get("position", ""))
        raw_position = number(position) if position != "" else None
        if raw_position is not None and (raw_position * 12700) % 8 != 0:
            raise ProfileError(f"PowerPoint guide position {raw_position} cannot be represented exactly in EMU.")
        raw_orientation = values.get("orient", values.get("orientation", ""))
        result.append(
            {
                "order": index,
                "orientation": "horizontal" if raw_orientation in {"horz", "horizontal"} else "vertical",
                "rawPosition": raw_position,
                "positionPt": None if raw_position is None else raw_position / 8,
                "positionEmu": None if raw_position is None else (raw_position * 12700) // 8,
                "attributes": values,
            }
        )
    return result


def slide_layout(parts: dict[str, bytes], part: str) -> str:
    name = rel_part(part)
    if name not in parts:
        return ""
    mapping = rel_map(parts, part)
    for item in ET.fromstring(parts[name]):
        if item.get("Type", "").endswith("/slideLayout"):
            return mapping.get(item.get("Id", ""), "")
    return ""


def archetypes(parts: dict[str, bytes], objects: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_part: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in objects:
        if item["part"].startswith("ppt/slides/"):
            by_part[item["part"]].append(item)
    slides, counts, bases = [], Counter(), {}
    for part in sorted(name for name in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)):
        basis = {
            "layoutPart": slide_layout(parts, part),
            "objects": [
                {"type": x["type"], "name": x["name"], "geometry": x["geometry"], "styleFingerprint": x["styleFingerprint"]}
                for x in by_part.get(part, [])
            ],
        }
        key = canonical_hash(basis)[:24]
        counts[key], bases[key] = counts[key] + 1, basis
        slides.append({"part": part, "layoutPart": basis["layoutPart"], "archetypeId": key})
    return slides, [{"id": key, "count": counts[key], **bases[key]} for key in sorted(counts)]


def pair_token(name: str, first: str, second: str, token: str) -> str | None:
    pieces = re.split(r"([-_\s]+)", name.lower())
    for value in (first, second):
        if value in pieces:
            pieces[pieces.index(value)] = token
            return "".join(pieces)
    return None


def asymmetry_manifest(path: Path | None, source_hash: str) -> dict[str, Any]:
    if path is None:
        return {"schemaVersion": "slidewright-asymmetry/v1", "sourceSha256": source_hash, "rules": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ProfileError(f"Cannot read asymmetry manifest: {error}") from error
    if value.get("schemaVersion") != "slidewright-asymmetry/v1" or value.get("sourceSha256") != source_hash:
        raise ProfileError("Asymmetry manifest schema/sourceSha256 does not match the source PPTX.")
    if not isinstance(value.get("rules"), list):
        raise ProfileError("Asymmetry manifest rules must be a list.")
    return value


def symmetry_contracts(
    objects: list[dict[str, Any]], size: dict[str, Any], source_hash: str, manifest_path: Path | None, enforce: bool
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in objects:
        if not item["name"] or not item["geometry"] or not PAIR_WORDS.search(item["name"]):
            continue
        for orientation, first, second, token in (
            ("vertical", "left", "right", "{lr}"),
            ("horizontal", "top", "bottom", "{tb}"),
        ):
            key = pair_token(item["name"], first, second, token)
            if key is not None:
                groups[(item["part"], orientation, key)].append(item)
    manifest = asymmetry_manifest(manifest_path, source_hash) if enforce else {"rules": []}
    records, declarations, used = [], [], set()
    for (part, orientation, _), items in sorted(groups.items()):
        if len(items) != 2:
            continue
        first_word, second_word = (("left", "right") if orientation == "vertical" else ("top", "bottom"))
        first = next((x for x in items if first_word in re.split(r"[-_\s]+", x["name"].lower())), None)
        second = next((x for x in items if second_word in re.split(r"[-_\s]+", x["name"].lower())), None)
        if first is None or second is None:
            continue
        g1, g2 = first["geometry"], second["geometry"]
        if orientation == "vertical":
            thickness = [g1["widthEmu"], g2["widthEmu"]]
            offsets = [g1["xEmu"], size["widthEmu"] - g2["xEmu"] - g2["widthEmu"]]
        else:
            thickness = [g1["heightEmu"], g2["heightEmu"]]
            offsets = [g1["yEmu"], size["heightEmu"] - g2["yEmu"] - g2["heightEmu"]]
        equal_thickness = thickness[0] == thickness[1]
        equal_offsets = offsets[0] == offsets[1]
        equal_appearance = first["fill"] == second["fill"] and first["line"] == second["line"]
        symmetric, declaration = equal_thickness and equal_offsets and equal_appearance, None
        if enforce and not symmetric:
            for index, rule in enumerate(manifest["rules"]):
                hashes = rule.get("sourceObjectSha256", {})
                if (
                    rule.get("part") == part
                    and {rule.get("first"), rule.get("second")} == {first["name"], second["name"]}
                    and hashes.get(first["name"]) == first["xmlSha256"]
                    and hashes.get(second["name"]) == second["xmlSha256"]
                    and str(rule.get("reason", "")).strip()
                ):
                    declaration = {
                        "part": part,
                        "first": first["name"],
                        "second": second["name"],
                        "reason": str(rule["reason"]).strip(),
                        "sourceSha256": source_hash,
                        "sourceObjectSha256": {
                            first["name"]: first["xmlSha256"],
                            second["name"]: second["xmlSha256"],
                        },
                    }
                    used.add(index)
                    declarations.append(declaration)
                    break
            if declaration is None:
                raise ProfileError(f"Undeclared asymmetric pair in {part}: {first['name']} / {second['name']}.")
        records.append(
            {
                "id": canonical_hash(
                    {"part": part, "orientation": orientation, "first": first["name"], "second": second["name"]}
                )[:24],
                "part": part,
                "orientation": orientation,
                "first": first["name"],
                "second": second["name"],
                "objectKeys": [first["objectKey"], second["objectKey"]],
                "thicknessEmu": thickness,
                "oppositeEdgeOffsetsEmu": offsets,
                "equalThickness": equal_thickness,
                "equalOppositeEdgeOffsets": equal_offsets,
                "equalAppearance": equal_appearance,
                "symmetric": symmetric,
                "appearance": [
                    {"fill": first["fill"], "line": first["line"]},
                    {"fill": second["fill"], "line": second["line"]},
                ],
                "declaredAsymmetry": declaration,
            }
        )
    if enforce and set(range(len(manifest["rules"]))) != used:
        raise ProfileError("Asymmetry manifest contains unused or nonmatching rules.")
    return records, declarations


def extract_profile(path: Path, manifest: Path | None = None, *, enforce_symmetry: bool = True) -> dict[str, Any]:
    if not path.exists():
        raise ProfileError(f"PPTX not found: {path}")
    raw = path.read_bytes()
    parts, relationships = read_package(path)
    source_hash, size, objects = sha(raw), slide_size(parts), object_records(parts)
    slides, archetype_values = archetypes(parts, objects)
    contracts, declarations = symmetry_contracts(objects, size, source_hash, manifest, enforce_symmetry)
    inventory = [{"part": name, "sha256": sha(parts[name])} for name in sorted(parts)]
    recurring = Counter(
        (x["name"], x["styleFingerprint"])
        for x in objects
        if x["part"].startswith("ppt/slides/") and x["name"]
    )
    chrome = [
        {
            "objectKey": x["objectKey"],
            "part": x["part"],
            "name": x["name"],
            "type": x["type"],
            "geometry": x["geometry"],
            "styleFingerprint": x["styleFingerprint"],
            "xmlSha256": x["xmlSha256"],
        }
        for x in objects
        if x["part"].startswith(("ppt/slideMasters/", "ppt/slideLayouts/"))
        or CHROME_WORDS.search(x["name"] or "")
        or recurring[(x["name"], x["styleFingerprint"])] >= 2
    ]
    logos = [
        {
            "objectKey": x["objectKey"],
            "part": x["part"],
            "name": x["name"],
            "type": x["type"],
            "xmlSha256": x["xmlSha256"],
            "media": x["media"],
        }
        for x in objects
        if re.search(r"logo|brandmark|wordmark", " ".join((x["name"], x["title"], x["description"])), re.I)
    ]
    protected = sorted(
        name
        for name in parts
        if re.fullmatch(r"ppt/(?:slideMasters/slideMaster|slideLayouts/slideLayout|theme/theme)\d+\.xml", name)
        or re.fullmatch(r"ppt/(?:slideMasters|slideLayouts)/_rels/.+\.rels", name)
        or name == "ppt/viewProps.xml"
    )
    profile = {
        "schemaVersion": "slidewright-design-profile/v1",
        "source": {
            "sha256": source_hash,
            "byteLength": len(raw),
            "packageManifestSha256": canonical_hash(inventory),
        },
        "package": {
            "partCount": len(parts),
            "parts": inventory,
            "relationshipTuples": relationships,
            "relationshipManifestSha256": canonical_hash(relationships),
            "protectedParts": [{"part": name, "sha256": sha(parts[name])} for name in protected],
        },
        "presentation": {
            "slideSize": size,
            "guides": guides(parts),
            "inheritanceChains": inheritance_chains(parts),
        },
        "spacing": {"records": spacing_records(parts)},
        "themes": themes(parts),
        "masters": named_parts(parts, "masters"),
        "layouts": named_parts(parts, "layouts"),
        "slides": slides,
        "objects": objects,
        "assets": {
            "logos": logos,
            "groups": [
                {
                    "objectKey": x["objectKey"],
                    "part": x["part"],
                    "name": x["name"],
                    "xmlSha256": x["xmlSha256"],
                }
                for x in objects
                if x["type"] == "grpSp"
            ],
            "media": [
                {"part": name, "sha256": sha(parts[name])}
                for name in sorted(parts)
                if name.startswith("ppt/media/")
            ],
        },
        "chrome": {"objects": chrome},
        "archetypes": archetype_values,
        "symmetryContracts": contracts,
        "declaredAsymmetries": declarations,
        "unsupported": {
            "policy": "fail-closed",
            "standardColorTransforms": "captured-losslessly",
            "unknownColorTransforms": "rejected",
            "colorModels": sorted(COLOR_MODELS),
            "fills": sorted(FILL_MODELS | {"inherit"}),
        },
    }
    profile["profileSha256"] = canonical_hash(profile)
    profile["portableIntegritySha256"] = portable_integrity_hash(profile)
    return profile


def json_payload(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
