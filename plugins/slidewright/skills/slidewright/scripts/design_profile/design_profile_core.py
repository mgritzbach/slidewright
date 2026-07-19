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
FILL_MODELS = {"solidFill", "noFill", "grpFill", "gradFill"}


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
        if isinstance(value, float) and not value.is_integer():
            rendered = format(value, ".15g")
            if "e" in rendered and 1e-6 <= abs(value) < 1e21:
                rendered = format(value, ".15f").rstrip("0").rstrip(".")
            elif "e" in rendered:
                mantissa, exponent = rendered.split("e", 1)
                exponent_value = int(exponent)
                rendered = f"{mantissa}e{'+' if exponent_value >= 0 else ''}{exponent_value}"
        else:
            rendered = str(int(value))
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
    if kind == "solidFill":
        return {"kind": kind, "color": color(selected, context)}
    if kind != "gradFill":
        return {"kind": kind}

    stops = []
    stop_list = child(selected, "gsLst")
    if stop_list is not None:
        for index, stop in enumerate(item for item in stop_list if lname(item.tag) == "gs"):
            position = number(stop.get("pos"))
            if not 0 <= position <= 100000:
                raise ProfileError(f"Gradient stop position {position} is outside 0..100000 in {context}.")
            stops.append({
                "position": position,
                "color": color(stop, f"{context}/gradient-stop-{index}"),
            })
    linear = child(selected, "lin")
    path_gradient = child(selected, "path")
    fill_to_rect = child(path_gradient, "fillToRect") if path_gradient is not None else None
    tile_rect = child(selected, "tileRect")
    normalized = {
        "kind": kind,
        "flip": selected.get("flip", ""),
        "rotateWithShape": selected.get("rotWithShape", "") in {"1", "true"},
        "stops": stops,
        "mode": (
            {"kind": "linear", "angle": number(linear.get("ang")), "scaled": linear.get("scaled", "") in {"1", "true"}}
            if linear is not None
            else {
                "kind": "path",
                "path": path_gradient.get("path", ""),
                "fillToRect": attrs(fill_to_rect),
            }
            if path_gradient is not None
            else {"kind": "unspecified"}
        ),
        "tileRect": attrs(tile_rect),
        "xmlSha256": sha(ET.tostring(selected, encoding="utf-8")),
        "reconstructable": bool(stops) and (linear is not None or path_gradient is not None),
    }
    if not normalized["reconstructable"]:
        normalized["fidelityWarning"] = "Gradient was normalized losslessly but is not yet guaranteed reconstructable by the native renderer."
    return normalized


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
                        "presetGeometry": next(
                            (
                                value.get("prst", "custom")
                                for value in item.iter()
                                if lname(value.tag) in {"prstGeom", "custGeom"}
                            ),
                            "",
                        ),
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
    for slide in presentation_slide_parts(parts):
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
        position_numerator = None if raw_position is None else raw_position * 12700
        exact_emu = raw_position is None or position_numerator % 8 == 0
        raw_orientation = values.get("orient", values.get("orientation", ""))
        result.append(
            {
                "order": index,
                "orientation": "horizontal" if raw_orientation in {"horz", "horizontal"} else "vertical",
                "rawPosition": raw_position,
                "positionPt": None if raw_position is None else raw_position / 8,
                "positionEmu": None if raw_position is None else (position_numerator + 4) // 8,
                "exactEmu": exact_emu,
                "emuRemainderEighths": None if raw_position is None else position_numerator % 8,
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


def slide_number(part: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", part)
    return int(match.group(1)) if match else 0


def presentation_slide_parts(parts: dict[str, bytes]) -> list[str]:
    """Return slide parts in the display order declared by p:sldIdLst.

    Package part names are allocation identifiers, not presentation ordinals.  A
    deck can legally display slide9.xml before slide2.xml, so any user-facing
    sourceSlide value must follow the relationship sequence in presentation.xml.
    """
    root = ET.fromstring(parts["ppt/presentation.xml"])
    slide_list = next((item for item in root if lname(item.tag) == "sldIdLst"), None)
    if slide_list is None:
        return []
    relationships = rel_map(parts, "ppt/presentation.xml")
    ordered: list[str] = []
    seen: set[str] = set()
    for index, slide_id in enumerate(item for item in slide_list if lname(item.tag) == "sldId"):
        relationship_id = slide_id.get(f"{{{R}}}id", "")
        part = relationships.get(relationship_id, "")
        if not relationship_id or not re.fullmatch(r"ppt/slides/slide\d+\.xml", part):
            raise ProfileError(
                f"Presentation slide entry {index + 1} has no valid internal slide relationship."
            )
        if part in seen:
            raise ProfileError(f"Presentation slide list references {part} more than once.")
        seen.add(part)
        ordered.append(part)
    return ordered


def archetypes(parts: dict[str, bytes], objects: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_part: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in objects:
        if item["part"].startswith("ppt/slides/"):
            by_part[item["part"]].append(item)
    slides, counts, bases = [], Counter(), {}
    for part in presentation_slide_parts(parts):
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


def _plain_text(item: dict[str, Any]) -> str:
    return "" if item.get("text") is None else str(item["text"].get("plainText", "")).strip()


def _concept_title(items: list[dict[str, Any]], height: int) -> str:
    candidates = []
    for item in items:
        text = _plain_text(item)
        geometry_value = item.get("geometry")
        if not text:
            continue
        sizes = item.get("text", {}).get("fontSizesPt", [])
        maximum_size = max(sizes) if sizes else 0
        if geometry_value is None:
            if (item.get("placeholder") or {}).get("type") != "title":
                continue
            top_ratio = 0.0
        else:
            top_ratio = geometry_value["yEmu"] / max(1, height)
        candidates.append((top_ratio > 0.32, top_ratio, -maximum_size, item["order"], text))
    if not candidates:
        return ""
    return sorted(candidates)[0][-1].replace("\n", " ").strip()


def _box(item: dict[str, Any], size: dict[str, Any]) -> dict[str, float] | None:
    geometry_value = item.get("geometry")
    if geometry_value is None:
        return None
    width, height = max(1, size["widthEmu"]), max(1, size["heightEmu"])
    left = geometry_value["xEmu"] / width
    top = geometry_value["yEmu"] / height
    box_width = geometry_value["widthEmu"] / width
    box_height = geometry_value["heightEmu"] / height
    return {
        "left": left,
        "top": top,
        "width": box_width,
        "height": box_height,
        "right": left + box_width,
        "bottom": top + box_height,
        "centerX": left + box_width / 2,
        "centerY": top + box_height / 2,
        "area": max(0.0, box_width) * max(0.0, box_height),
    }


def _cluster_count(values: list[float], gap: float) -> int:
    if not values:
        return 0
    count, previous = 1, sorted(values)[0]
    for value in sorted(values)[1:]:
        if value - previous > gap:
            count += 1
        previous = value
    return count


def _content_text_items(items: list[dict[str, Any]], size: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for item in items:
        box = _box(item, size)
        if (
            item.get("semanticKind") not in {"sp", "grpSp"}
            or not _plain_text(item)
            or box is None
            or box["area"] < 0.001
        ):
            continue
        placeholder_type = (item.get("placeholder") or {}).get("type", "")
        if placeholder_type == "title" or (box["top"] < 0.17 and box["height"] < 0.18):
            continue
        result.append(item)
    return result


def _nontext_shapes(items: list[dict[str, Any]], size: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        item for item in items
        if item.get("semanticKind") in {"sp", "grpSp", "cxnSp"}
        and not _plain_text(item)
        and (box := _box(item, size)) is not None
        and box["area"] >= 0.001
    ]


def _stair_step_shapes(items: list[dict[str, Any]], size: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = []
    for item in _nontext_shapes(items, size):
        box = _box(item, size)
        if (
            item.get("presetGeometry") in {"rect", "roundRect", ""}
            and box is not None
            and 0.08 <= box["width"] <= 0.32
            and 0.01 <= box["height"] <= 0.2
        ):
            candidates.append(item)
    candidates.sort(key=lambda item: _box(item, size)["left"])
    for count in range(min(8, len(candidates)), 2, -1):
        for start in range(len(candidates) - count + 1):
            group = candidates[start:start + count]
            boxes = [_box(item, size) for item in group]
            widths = [value["width"] for value in boxes]
            gaps = [boxes[index + 1]["left"] - boxes[index]["left"] for index in range(count - 1)]
            tops = [value["top"] for value in boxes]
            heights = [value["height"] for value in boxes]
            if (
                max(widths) - min(widths) <= 0.03
                and gaps and min(gaps) >= widths[0] * 0.7
                and all(tops[index + 1] <= tops[index] + 0.005 for index in range(count - 1))
                and all(heights[index + 1] >= heights[index] - 0.005 for index in range(count - 1))
                and (tops[0] - tops[-1] >= 0.04 or heights[-1] - heights[0] >= 0.04)
            ):
                return group
    return []


def _quadrant_structure(items: list[dict[str, Any]], size: dict[str, Any]) -> bool:
    central = []
    for item in _nontext_shapes(items, size):
        box = _box(item, size)
        if (
            item.get("presetGeometry") in {"rect", "roundRect", "custom"}
            and box is not None
            and 0.27 <= box["centerX"] <= 0.73
            and 0.25 <= box["centerY"] <= 0.78
            and 0.05 <= box["width"] <= 0.26
            and 0.07 <= box["height"] <= 0.34
        ):
            central.append(box)
    if not 4 <= len(central) <= 6:
        return False
    return _cluster_count([value["centerX"] for value in central], 0.08) >= 2 and _cluster_count(
        [value["centerY"] for value in central], 0.1
    ) >= 2 and len(_content_text_items(items, size)) >= 4


def _triangular_structure(items: list[dict[str, Any]], size: dict[str, Any]) -> bool:
    central_custom = []
    for item in _nontext_shapes(items, size):
        box = _box(item, size)
        if (
            item.get("presetGeometry") in {"custom", "triangle", "rtTriangle"}
            and box is not None
            and 0.25 <= box["centerX"] <= 0.75
            and 0.18 <= box["centerY"] <= 0.78
        ):
            central_custom.append(box)
    text_boxes = [_box(item, size) for item in _content_text_items(items, size)]
    exterior = [
        value for value in text_boxes
        if value["centerX"] < 0.36 or value["centerX"] > 0.64 or value["centerY"] > 0.68
    ]
    enclosing_group = any(
        item.get("semanticKind") == "grpSp"
        and item.get("presetGeometry") in {"custom", "triangle", "rtTriangle"}
        and (value := _box(item, size)) is not None
        and value["area"] >= 0.08
        and 0.3 <= value["centerX"] <= 0.7
        for item in items
    )
    return enclosing_group and 3 <= len(central_custom) <= 6 and len(exterior) >= 3


def _four_callout_structure(items: list[dict[str, Any]], size: dict[str, Any]) -> bool:
    text_boxes = [
        value for item in _content_text_items(items, size)
        if (value := _box(item, size)) is not None
        and 0.12 <= value["width"] <= 0.38
        and value["height"] >= 0.05
    ]
    left = [value for value in text_boxes if value["right"] <= 0.43]
    right = [value for value in text_boxes if value["left"] >= 0.57]
    central_visual = any(
        (value := _box(item, size)) is not None
        and not _plain_text(item)
        and item.get("presetGeometry") in {"diamond", "ellipse", "circle", "custom"}
        and 0.35 <= value["centerX"] <= 0.65
        and 0.35 <= value["centerY"] <= 0.75
        and value["area"] >= 0.02
        for item in items
    )
    return (
        central_visual
        and len(left) >= 2
        and len(right) >= 2
        and _cluster_count([value["centerY"] for value in left], 0.13) >= 2
        and _cluster_count([value["centerY"] for value in right], 0.13) >= 2
    )


def _paired_columns(items: list[dict[str, Any]], size: dict[str, Any]) -> bool:
    text_boxes = [_box(item, size) for item in _content_text_items(items, size)]
    major = [value for value in text_boxes if value["width"] >= 0.18 and value["height"] >= 0.12]
    if len(major) != 2:
        return False
    left, right = sorted(major, key=lambda value: value["centerX"])
    return (
        left["centerX"] < 0.5 < right["centerX"]
        and abs(left["top"] - right["top"]) <= 0.06
        and abs(left["width"] - right["width"]) <= 0.08
        and abs(left["height"] - right["height"]) <= 0.12
    )


def _table_side_panel_structure(items: list[dict[str, Any]], size: dict[str, Any]) -> bool:
    tables = [item for item in items if item.get("semanticKind") == "table" and _box(item, size)]
    if len(tables) != 1:
        return False
    table_box = _box(tables[0], size)
    if table_box["width"] > 0.72 or table_box["height"] < 0.3:
        return False
    matching_panels = []
    for item in _content_text_items(items, size):
        value = _box(item, size)
        horizontally_separate = value["left"] >= table_box["right"] - 0.02 or value["right"] <= table_box["left"] + 0.02
        if (
            horizontally_separate
            and value["width"] >= 0.2
            and abs(value["top"] - table_box["top"]) <= 0.06
            and abs(value["height"] - table_box["height"]) <= 0.12
        ):
            matching_panels.append(item)
    return len(matching_panels) == 1


def _grid_structure(items: list[dict[str, Any]], size: dict[str, Any]) -> bool:
    connectors = [_box(item, size) for item in items if item.get("semanticKind") == "cxnSp" and _box(item, size)]
    text_boxes = [_box(item, size) for item in _content_text_items(items, size)]
    axis_aligned = sum(1 for value in connectors if value["width"] < 0.003 or value["height"] < 0.003)
    return (
        len(connectors) >= 8
        and axis_aligned / len(connectors) >= 0.9
        and len(text_boxes) >= 12
        and _cluster_count([value["centerX"] for value in text_boxes], 0.08) >= 3
        and _cluster_count([value["centerY"] for value in text_boxes], 0.08) >= 3
    )


def _composition_model(
    title: str,
    items: list[dict[str, Any]],
    size: dict[str, Any],
    all_items: list[dict[str, Any]] | None = None,
) -> tuple[str, list[str], float]:
    """Classify composition from native object topology, never fixture wording."""
    structural_items = all_items if all_items is not None else items
    semantic_kinds = Counter(item.get("semanticKind", "unknown") for item in structural_items)
    width, height = size["widthEmu"], size["heightEmu"]
    large_pictures = sum(
        1 for item in structural_items
        if item.get("semanticKind") == "pic" and item.get("geometry")
        and item["geometry"]["widthEmu"] * item["geometry"]["heightEmu"] >= width * height * 0.18
    )
    preset_counts = Counter(item.get("presetGeometry", "") for item in structural_items)
    if _stair_step_shapes(structural_items, size):
        return "process-flow", ["sequence", "implementation"], 0.94
    if _triangular_structure(structural_items, size):
        return "layered-diagram", ["hierarchy", "prioritization"], 0.93
    if preset_counts["trapezoid"] >= 3:
        return "layered-diagram", ["hierarchy", "prioritization"], 0.9
    if semantic_kinds["table"] >= 2:
        return "comparison", ["choice", "trade-off"], 0.9
    if semantic_kinds["table"]:
        if preset_counts["chevron"] + preset_counts["homePlate"] >= 2 or (
            _table_side_panel_structure(structural_items, size)
        ):
            return "process-flow", ["sequence", "implementation"], 0.88
        return "table-matrix", ["structured-data", "comparison"], 0.92
    if _quadrant_structure(structural_items, size) or _four_callout_structure(structural_items, size):
        return "radial-diagram", ["relationship", "system"], 0.93
    if _paired_columns(structural_items, size):
        return "comparison", ["choice", "trade-off"], 0.9
    if _grid_structure(structural_items, size):
        return "table-matrix", ["structured-data", "comparison"], 0.9
    if semantic_kinds["chart"]:
        return "chart-led", ["evidence", "trend"], 0.9
    if large_pictures:
        return "image-editorial", ["evidence", "storytelling"], 0.88

    connector_count = semantic_kinds["cxnSp"]
    if preset_counts["chevron"] + preset_counts["homePlate"] >= 2 or connector_count >= 4:
        return "process-flow", ["sequence", "implementation"], 0.88
    if preset_counts["ellipse"] >= 3 or preset_counts["circle"] >= 3:
        return "radial-diagram", ["relationship", "system"], 0.84
    if sum(1 for item in structural_items if item.get("type") == "grpSp") >= 3 or preset_counts["custom"] >= 4:
        return "radial-diagram", ["relationship", "system"], 0.8
    if connector_count >= 2:
        return "process-flow", ["sequence", "implementation"], 0.86

    major = [
        item for item in _content_text_items(structural_items, size)
        if (value := _box(item, size)) is not None and value["area"] >= 0.02
    ]
    centers = [_box(item, size)["centerX"] for item in major]
    band_count = _cluster_count(centers, 0.14)
    if 3 <= band_count <= 5 and len(major) >= band_count:
        return "column-cards", ["categorization", "overview"], 0.78
    if len(items) <= 4 and sum(len(_plain_text(item)) for item in items) <= 180:
        return "statement", ["opening", "transition"], 0.7
    return "structured-content", ["explanation", "evidence"], 0.62


def _count_hint(title: str) -> int | None:
    normalized = re.sub(r"\s+", " ", title.lower())
    words = {
        "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
        "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
    }
    count_nouns = r"steps?|stages?|phases?|parts?|segments?|columns?|boxes|cards?|nodes?|elements?|features?|options?|chevrons?|circles?|items?"
    for expression in (
        r"\b(\d{1,2})\s*(?:[-x\u00d7]\s*\d+\s*)?(?:" + count_nouns + r")\b",
        r"\b(" + "|".join(words) + r")[- ](?:" + count_nouns + r")\b",
    ):
        match = re.search(expression, normalized)
        if match:
            value = match.group(1)
            return int(value) if value.isdigit() else words[value]
    return None


def _table_header_band_count(items: list[dict[str, Any]], size: dict[str, Any]) -> int:
    tables = [item for item in items if item.get("semanticKind") == "table" and _box(item, size) is not None]
    if len(tables) != 1:
        return 0
    table_box = _box(tables[0], size)
    headers = []
    for item in _content_text_items(items, size):
        value = _box(item, size)
        if (
            value is not None
            and table_box["top"] - 0.11 <= value["top"] <= table_box["top"] + 0.02
            and 0.08 <= value["width"] <= 0.34
            and value["height"] <= 0.12
        ):
            headers.append(value)
    return _cluster_count([value["centerX"] for value in headers], 0.12)


def _table_option_markers(items: list[dict[str, Any]], size: dict[str, Any]) -> int:
    tables = [item for item in items if item.get("semanticKind") == "table" and _box(item, size) is not None]
    if len(tables) != 1:
        return 0
    table_box = _box(tables[0], size)
    markers = []
    for item in _nontext_shapes(items, size):
        value = _box(item, size)
        if (
            value is not None
            and item.get("presetGeometry") == "custom"
            and value["width"] <= 0.08
            and value["height"] <= 0.04
            and table_box["left"] <= value["centerX"] <= table_box["right"]
            and table_box["top"] <= value["centerY"] <= table_box["bottom"]
        ):
            markers.append(value)
    return _cluster_count([value["centerX"] for value in markers], 0.07) if len(markers) >= 3 else 0


def _composition_variant(
    model: str,
    title: str,
    item_count: int,
    items: list[dict[str, Any]],
    size: dict[str, Any] | None = None,
) -> str:
    """Resolve a visible native variant from geometry and object kinds."""
    if model in {"cover", "statement"}:
        return "centered-color-field"
    if model == "table-matrix":
        if size is not None and _table_option_markers(items, size) >= 3:
            return "option-matrix"
        if size is not None and _table_header_band_count(items, size) == 3:
            return "numbered-three-column-grid"
        if size is not None and any(
            item.get("semanticKind") == "pic"
            and (value := _box(item, size)) is not None
            and value["area"] >= 0.03
            for item in items
        ):
            return "media-caption-grid"
        return "banded-matrix"
    if model == "comparison":
        tables = [item for item in items if item.get("semanticKind") == "table"]
        return "dual-rail" if len(tables) >= 2 else "split-highlight"
    if model == "process-flow":
        if size is not None and _stair_step_shapes(items, size):
            return "stair-step"
        preset_counts = Counter(item.get("presetGeometry", "") for item in items)
        if preset_counts["chevron"] + preset_counts["homePlate"] >= 2:
            return "chevron-steps"
        if sum(1 for item in items if item.get("semanticKind") == "cxnSp") >= 2:
            return "connected-timeline"
        if size is not None and _table_side_panel_structure(items, size):
            return "horizontal-steps-impact"
        return "numbered-steps" if item_count > 0 else "sequential-bands"
    if model == "layered-diagram":
        if size is not None and _triangular_structure(items, size):
            return "triangular-cycle"
        presets = Counter(item.get("presetGeometry", "") for item in items)
        if presets["cylinder"] or presets["can"]:
            return "stacked-cylinder"
        if presets["trapezoid"] + presets["triangle"] + presets["rtTriangle"] >= 2:
            return "layered-pyramid"
        return "stacked-layers"
    if model == "radial-diagram":
        presets = Counter(item.get("presetGeometry", "") for item in items)
        groups = sum(1 for item in items if item.get("type") == "grpSp")
        if presets["custom"] >= 8:
            return "four-part-venn" if item_count == 4 else "venn-system"
        if groups >= 3:
            return "puzzle-system"
        if size is not None and (_quadrant_structure(items, size) or _four_callout_structure(items, size)):
            return "four-callout-quadrant"
        ellipses = presets["ellipse"] + presets["circle"]
        if ellipses >= 3:
            return "hub-spoke" if item_count == 3 and ellipses >= 5 else (
                "four-part-venn" if item_count == 4 else "venn-system"
            )
        return "radial-system"
    if model == "column-cards":
        if item_count == 4:
            return "four-column-cards"
        if item_count == 3:
            return "three-column-cards"
        return "parallel-cards"
    if model == "image-editorial":
        return "media-editorial"
    return "structured-content"


def _concept_item_count(
    model: str,
    title: str,
    regions: list[dict[str, Any]],
    items: list[dict[str, Any]] | None = None,
    size: dict[str, Any] | None = None,
) -> int:
    structural_items = [] if items is None else items
    if size is not None:
        stair = _stair_step_shapes(structural_items, size)
        if stair:
            return len(stair)
        if _triangular_structure(structural_items, size):
            return 3
        if _quadrant_structure(structural_items, size) or _four_callout_structure(structural_items, size):
            return 4
    if model in {"cover", "statement", "chart-led", "image-editorial"}:
        return 1
    if model == "comparison":
        return 2
    if size is not None and model == "column-cards":
        centers = [
            value["centerX"] for item in _content_text_items(structural_items, size)
            if (value := _box(item, size)) is not None and value["width"] >= 0.12
        ]
        bands = _cluster_count(centers, 0.14)
        if 2 <= bands <= 12:
            return bands
    if size is not None and model == "radial-diagram":
        exterior = [
            value for item in _content_text_items(structural_items, size)
            if (value := _box(item, size)) is not None
            and (value["centerX"] < 0.35 or value["centerX"] > 0.65 or value["centerY"] > 0.68)
        ]
        if 2 <= len(exterior) <= 12:
            return len(exterior)
    if size is not None and model == "table-matrix":
        # Native tables do not always expose usable cell text in the generic
        # object record. Recover their semantic column topology from visible
        # option markers or the aligned header band above the table. A zero
        # count must never become a wildcard for grounded reconstruction.
        option_columns = _table_option_markers(structural_items, size)
        header_columns = _table_header_band_count(structural_items, size)
        semantic_columns = option_columns or header_columns
        if 2 <= semantic_columns <= 12:
            return semantic_columns
    hinted = _count_hint(title)
    if hinted is not None:
        return hinted
    if model in {"table-matrix", "map-chart", "structured-content", "exercise-sidebar"}:
        return 0
    candidates = [
        region for region in regions
        if region["normalized"]["top"] >= 0.18 and region["normalized"]["width"] <= 0.5
    ]
    return max(1, min(12, len(candidates) or len(regions)))


def _communication_purpose(model: str, title: str) -> str:
    purposes = {
        "cover": "Open a narrative with one dominant proposition.",
        "statement": "Create emphasis or transition with a concise statement.",
        "table-matrix": "Compare structured facts, choices, or performance across dimensions.",
        "layered-diagram": "Explain hierarchy, progression, or narrowing choices.",
        "radial-diagram": "Show a system of related elements around a shared center.",
        "process-flow": "Explain sequence, ownership, milestones, or implementation flow.",
        "comparison": "Contrast alternatives and make a decision boundary explicit.",
        "map-chart": "Communicate geographic distribution or portfolio location.",
        "column-cards": "Organize parallel categories into a scan-friendly framework.",
        "image-editorial": "Pair visual evidence with concise explanatory copy.",
        "exercise-sidebar": "Guide an audience through an activity or facilitated decision.",
        "chart-led": "Lead with quantitative evidence and its implication.",
        "structured-content": "Explain a structured argument with supporting evidence.",
    }
    purpose = purposes.get(model, purposes["structured-content"])
    return purpose if not title else f"{purpose} Source framing: {title[:120]}"


def semantic_concept_inventory(objects: list[dict[str, Any]], slides: list[dict[str, Any]], size: dict[str, Any]) -> dict[str, Any]:
    by_part: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in objects:
        if item["part"].startswith("ppt/slides/"):
            by_part[item["part"]].append(item)
    concepts, slide_inventory = [], []
    width, height = size["widthEmu"], size["heightEmu"]
    for ordinal, slide in enumerate(slides, start=1):
        items = sorted(by_part.get(slide["part"], []), key=lambda item: item["order"])
        substantive = [
            item for item in items
            if (len(_plain_text(item)) >= 3)
            or item.get("semanticKind") in {"table", "chart"}
            or (
                item.get("semanticKind") == "pic" and item.get("geometry")
                and item["geometry"]["widthEmu"] * item["geometry"]["heightEmu"] >= width * height * 0.04
            )
        ]
        text_characters = sum(len(_plain_text(item)) for item in substantive)
        viable = bool(substantive) and (text_characters >= 8 or any(item.get("semanticKind") in {"table", "chart", "pic"} for item in substantive))
        title = _concept_title(substantive, height)
        entry = {
            "sourceSlide": ordinal,
            "slidePart": slide["part"],
            "viable": viable,
            "reason": "substantive native content detected" if viable else "blank or chrome-only slide",
        }
        slide_inventory.append(entry)
        if not viable:
            continue
        model, tags, confidence = _composition_model(title, substantive, size, items)
        regions = []
        for item in substantive:
            geometry_value = item.get("geometry")
            if geometry_value is None:
                continue
            regions.append({
                "objectKey": item["objectKey"],
                "name": item["name"],
                "kind": item["semanticKind"],
                "text": _plain_text(item)[:240],
                "normalized": {
                    "left": round(geometry_value["xEmu"] / width, 6),
                    "top": round(geometry_value["yEmu"] / height, 6),
                    "width": round(geometry_value["widthEmu"] / width, 6),
                    "height": round(geometry_value["heightEmu"] / height, 6),
                },
            })
        item_count = _concept_item_count(model, title, regions, items, size)
        variant = _composition_variant(model, title, item_count, items, size)
        source_objects = []
        for item in items:
            geometry_value = item.get("geometry")
            if geometry_value is None:
                continue
            source_objects.append({
                "objectKey": item["objectKey"],
                "kind": item.get("semanticKind", "unknown"),
                "name": item.get("name", ""),
                "presetGeometry": item.get("presetGeometry", ""),
                "normalized": {
                    "left": round(geometry_value["xEmu"] / width, 6),
                    "top": round(geometry_value["yEmu"] / height, 6),
                    "width": round(geometry_value["widthEmu"] / width, 6),
                    "height": round(geometry_value["heightEmu"] / height, 6),
                },
                "fillKind": (item.get("fill") or {}).get("kind", "none"),
                "hasText": bool(_plain_text(item)),
                "styleFingerprint": item.get("styleFingerprint", ""),
            })
        density = "high" if text_characters >= 700 or len(substantive) >= 18 else "medium" if text_characters >= 260 or len(substantive) >= 8 else "low"
        object_counts = Counter(item.get("semanticKind", "unknown") for item in substantive)
        concept_basis = {
            "sourceSlide": ordinal,
            "slidePart": slide["part"],
            "title": title,
            "model": model,
            "variant": variant,
            "itemCount": item_count,
            "regions": regions,
        }
        concepts.append({
            "id": f"concept-{ordinal:02d}-{canonical_hash(concept_basis)[:10]}",
            "sourceSlide": ordinal,
            "slidePart": slide["part"],
            "sourceTitle": title,
            "communicationPurpose": _communication_purpose(model, title),
            "composition": {
                "model": model,
                "variant": variant,
                "itemCount": item_count,
                "hierarchy": "title-first" if title else "visual-first",
                "primaryFlow": "left-to-right" if model in {"process-flow", "comparison", "column-cards"} else "top-to-bottom",
                "regions": regions,
            },
            "objectTypes": dict(sorted(object_counts.items())),
            "spatialRelationships": {
                "regionCount": len(regions),
                "centralEmphasis": model in {"radial-diagram", "layered-diagram"},
                "parallelStructure": model in {"comparison", "column-cards", "table-matrix"},
            },
            "blueprint": {
                "variant": variant,
                "itemCount": item_count,
                "sourceObjects": source_objects,
                "sourceObjectCount": len(source_objects),
                "reconstructableWithNativeObjects": model not in {"image-editorial", "map-chart"},
            },
            "density": {"level": density, "textCharacters": text_characters, "substantiveObjects": len(substantive)},
            "emphasis": {"pattern": model, "titlePresent": bool(title)},
            "suitability": {
                "preferredContentTypes": tags,
                "minimumItems": item_count if item_count > 0 and model in {"comparison", "column-cards", "process-flow", "radial-diagram", "layered-diagram"} else (1 if model in {"cover", "statement", "chart-led", "image-editorial"} else 0),
                "maximumItems": item_count if item_count > 0 and model in {"comparison", "column-cards", "process-flow", "radial-diagram", "layered-diagram"} else max(1, min(12, len(regions))),
                "requiresMedia": model == "image-editorial",
            },
            "nativeEditable": True,
            "confidence": confidence,
            "tags": sorted(set([model, *tags])),
        })
    return {
        "schemaVersion": "slidewright-design-concept-inventory/v1",
        "slidesTotal": len(slides),
        "viableSlides": len(concepts),
        "nonviableSlides": len(slides) - len(concepts),
        "slideInventory": slide_inventory,
        "concepts": concepts,
    }


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
    guide_records = guides(parts)
    slides, archetype_values = archetypes(parts, objects)
    concept_inventory = semantic_concept_inventory(objects, slides, size)
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
            "fileName": path.name,
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
            "guides": guide_records,
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
        "designConceptInventory": concept_inventory,
        "symmetryContracts": contracts,
        "declaredAsymmetries": declarations,
        "warnings": [
            {
                "code": "SW_PROFILE_GRADIENT_FIDELITY",
                "severity": "warning",
                "objectKey": item["objectKey"],
                "message": item["fill"]["fidelityWarning"],
            }
            for item in objects
            if item.get("fill", {}).get("fidelityWarning")
        ] + [
            {
                "code": "SW_PROFILE_GUIDE_ROUNDED_TO_EMU",
                "severity": "warning",
                "guideOrder": guide["order"],
                "message": "PowerPoint guide position is not exactly representable in whole EMUs; the raw position is preserved and positionEmu is rounded to the nearest EMU.",
            }
            for guide in guide_records
            if guide.get("exactEmu") is False
        ],
        "unsupported": {
            "policy": "fail-closed-except-normalized-standard-gradients",
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
