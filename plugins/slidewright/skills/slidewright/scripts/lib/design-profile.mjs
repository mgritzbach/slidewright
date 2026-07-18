import fs from "node:fs/promises";
import crypto from "node:crypto";

const HEX = /^#[0-9a-f]{6}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;
const STABLE_ID = /^[a-z0-9][a-z0-9-]*$/u;
const ORIENTATIONS = new Set(["landscape", "portrait", "square"]);
const SIDES = new Set(["left", "right", "top", "bottom"]);
const OPPOSITE_SIDE_PAIRS = new Set(["left:right", "right:left", "top:bottom", "bottom:top"]);
const PLACEHOLDER_TYPES = new Set(["title", "body", "subtitle", "footer", "date", "slide-number", "other"]);
const RIM_ROLES = new Set(["rim", "limiting", "orientation", "divider"]);
const DASHES = new Set(["solid", "dash", "dot", "dash-dot"]);

function fail(message) {
  throw new Error("Invalid design profile: " + message);
}

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function requireObject(value, label) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), label + " must be an object.");
  return value;
}

function requireString(value, label) {
  requireValue(typeof value === "string" && value.trim().length > 0, label + " must be a non-empty string.");
}

function requireStableId(value, label) {
  requireValue(typeof value === "string" && STABLE_ID.test(value), label + " must be a stable lowercase id.");
}

function requireFinite(value, label, options = {}) {
  const min = options.min ?? -Infinity;
  const max = options.max ?? Infinity;
  requireValue(Number.isFinite(value), label + " must be a finite number.");
  requireValue(value >= min && value <= max, label + " must be between " + min + " and " + max + ".");
  if (options.integer) requireValue(Number.isInteger(value), label + " must be an integer.");
}

function requireUnique(values, label) {
  requireValue(new Set(values).size === values.length, label + " values must be unique.");
}

function portableIntegrityProjection(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireValue(Number.isFinite(value), "extracted profile integrity numbers must be finite.");
    return { $number: String(value) };
  }
  if (Array.isArray(value)) return value.map(portableIntegrityProjection);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, portableIntegrityProjection(value[key])]));
  }
  fail("extracted profile contains an unsupported integrity value.");
}

export function portableProfileIntegrityHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(portableIntegrityProjection(value))).digest("hex");
}


function validateRimPair(pair, label) {
  requireObject(pair, label);
  requireStableId(pair.id, label + ".id");
  requireValue(RIM_ROLES.has(pair.role), label + ".role is invalid.");
  requireValue(["equal", "preserve-source-asymmetry"].includes(pair.symmetryPolicy), label + ".symmetryPolicy is invalid.");
  requireValue(Array.isArray(pair.members) && pair.members.length === 2, label + ".members must contain exactly two lines.");

  for (const [index, member] of pair.members.entries()) {
    const memberLabel = label + ".members[" + index + "]";
    requireObject(member, memberLabel);
    requireValue(SIDES.has(member.side), memberLabel + ".side is invalid.");
    requireString(member.shapeName, memberLabel + ".shapeName");
    requireFinite(member.widthPt, memberLabel + ".widthPt", { min: Number.EPSILON, max: 24 });
    requireFinite(member.insetPt, memberLabel + ".insetPt", { min: 0 });
    requireValue(HEX.test(member.color ?? ""), memberLabel + ".color must be a six-digit hex color.");
    requireValue(DASHES.has(member.dash), memberLabel + ".dash is invalid.");
  }

  const [first, second] = pair.members;
  requireValue(OPPOSITE_SIDE_PAIRS.has(first.side + ":" + second.side), label + ".members must describe opposite sides.");
  requireValue(first.shapeName !== second.shapeName, label + ".members must reference different source shapes.");

  if (pair.sourceContract !== undefined) {
    const source = requireObject(pair.sourceContract, label + ".sourceContract");
    for (const field of ["thicknessEmu", "oppositeEdgeOffsetsEmu"]) {
      requireValue(Array.isArray(source[field]) && source[field].length === 2, label + ".sourceContract." + field + " must contain two exact EMU integers.");
      source[field].forEach((value, index) => requireFinite(value, label + ".sourceContract." + field + "[" + index + "]", {
        min: field === "thicknessEmu" ? 1 : 0,
        integer: true,
      }));
    }
    requireValue(typeof source.equalAppearance === "boolean", label + ".sourceContract.equalAppearance must be boolean.");
    requireValue(typeof source.symmetric === "boolean", label + ".sourceContract.symmetric must be boolean.");
    const exactSymmetry = source.thicknessEmu[0] === source.thicknessEmu[1]
      && source.oppositeEdgeOffsetsEmu[0] === source.oppositeEdgeOffsetsEmu[1]
      && source.equalAppearance;
    requireValue(source.symmetric === exactSymmetry, label + ".sourceContract.symmetric conflicts with exact EMU/appearance fields.");
    requireValue((pair.symmetryPolicy === "equal") === exactSymmetry, label + ".symmetryPolicy conflicts with the exact source contract.");
  }

  if (pair.symmetryPolicy === "equal") {
    requireValue(first.widthPt === second.widthPt, label + " equal-width lines must use the same widthPt.");
    requireValue(first.insetPt === second.insetPt, label + " symmetric lines must use the same insetPt.");
    requireValue(first.color.toUpperCase() === second.color.toUpperCase(), label + " symmetric lines must use the same color.");
    requireValue(first.dash === second.dash, label + " symmetric lines must use the same dash style.");
    requireValue(pair.sourceAsymmetryReason === undefined, label + ".sourceAsymmetryReason is only valid for preserved source asymmetry.");
  } else {
    requireString(pair.sourceAsymmetryReason, label + ".sourceAsymmetryReason");
  }
}

function validatePlaceholder(placeholder, label) {
  requireObject(placeholder, label);
  requireStableId(placeholder.id, label + ".id");
  requireString(placeholder.shapeName, label + ".shapeName");
  requireValue(PLACEHOLDER_TYPES.has(placeholder.placeholderType), label + ".placeholderType is invalid.");
  requireFinite(placeholder.placeholderIndex, label + ".placeholderIndex", { min: 0, integer: true });
  requireValue(typeof placeholder.sourceText === "string", label + ".sourceText must be a string.");
  requireString(placeholder.sourceObjectKey, label + ".sourceObjectKey");
  requireValue(SHA256.test(placeholder.sourceObjectSha256 ?? ""), label + ".sourceObjectSha256 must be SHA-256.");
  requireString(placeholder.sourceShapeId, label + ".sourceShapeId");
  requireValue(typeof placeholder.sourceCreationId === "string", label + ".sourceCreationId must explicitly preserve the source value, including an empty value.");
  requireValue(Array.isArray(placeholder.sourceParagraphSha256s) && placeholder.sourceParagraphSha256s.length > 0
    && placeholder.sourceParagraphSha256s.every((value) => SHA256.test(value)), label + ".sourceParagraphSha256s must be a non-empty SHA-256 array.");
  requireValue(Array.isArray(placeholder.allowedEdits) && placeholder.allowedEdits.length > 0, label + ".allowedEdits must be non-empty.");
  requireUnique(placeholder.allowedEdits, label + ".allowedEdits");
  requireValue(placeholder.allowedEdits.every((operation) => operation === "text"), label + ".allowedEdits may only contain 'text' in g22-v1.");
  if (placeholder.required !== undefined) requireValue(typeof placeholder.required === "boolean", label + ".required must be a boolean.");
  if (placeholder.maxCharacters !== undefined) requireFinite(placeholder.maxCharacters, label + ".maxCharacters", { min: 1, integer: true });
  if (placeholder.maxLines !== undefined) requireFinite(placeholder.maxLines, label + ".maxLines", { min: 1, integer: true });
}

export function validateDesignProfile(input) {
  requireObject(input, "root");
  const profile = structuredClone(input);
  requireValue(profile.version === "g22-v1", "version must be 'g22-v1'.");
  requireStableId(profile.id, "id");

  const source = requireObject(profile.source, "source");
  requireValue(source.kind === "native-pptx", "source.kind must be 'native-pptx'.");
  requireString(source.fileName, "source.fileName");
  requireValue(SHA256.test(source.sha256 ?? ""), "source.sha256 must be a SHA-256 digest.");
  requireFinite(source.slideCount, "source.slideCount", { min: 1, integer: true });
  const canvas = requireObject(source.canvas, "source.canvas");
  requireFinite(canvas.widthEmu, "source.canvas.widthEmu", { min: 1, integer: true });
  requireFinite(canvas.heightEmu, "source.canvas.heightEmu", { min: 1, integer: true });
  requireValue(ORIENTATIONS.has(canvas.orientation), "source.canvas.orientation is invalid.");

  const policy = requireObject(profile.reusePolicy, "reusePolicy");
  requireValue(policy.mode === "clone-source-deck", "reusePolicy.mode must be 'clone-source-deck'.");
  requireValue(policy.preserveUndeclaredObjects === true, "reusePolicy.preserveUndeclaredObjects must be true.");
  requireValue(policy.allowArbitraryImport === false, "reusePolicy.allowArbitraryImport must be false in g22-v1.");

  const theme = requireObject(profile.theme, "theme");
  const fonts = requireObject(theme.fonts, "theme.fonts");
  requireString(fonts.major, "theme.fonts.major");
  requireString(fonts.minor, "theme.fonts.minor");
  requireValue(Array.isArray(fonts.families) && fonts.families.length > 0, "theme.fonts.families must be non-empty.");
  fonts.families.forEach((family, index) => requireString(family, "theme.fonts.families[" + index + "]"));
  requireUnique(fonts.families, "theme.fonts.families");

  const colors = requireObject(theme.colors, "theme.colors");
  requireValue(Object.keys(colors).length > 0, "theme.colors must be non-empty.");
  for (const [role, value] of Object.entries(colors)) {
    requireStableId(role, "theme.colors key '" + role + "'");
    requireValue(HEX.test(value ?? ""), "theme.colors." + role + " must be a six-digit hex color.");
    colors[role] = value.toUpperCase();
  }

  requireValue(Array.isArray(theme.commonFontSizesPt) && theme.commonFontSizesPt.length > 0, "theme.commonFontSizesPt must be non-empty.");
  theme.commonFontSizesPt.forEach((size, index) => requireFinite(size, "theme.commonFontSizesPt[" + index + "]", { min: 8, max: 96, integer: true }));
  requireUnique(theme.commonFontSizesPt, "theme.commonFontSizesPt");

  const logos = profile.logos ?? [];
  requireValue(Array.isArray(logos), "logos must be an array.");
  for (const [index, logo] of logos.entries()) {
    const label = "logos[" + index + "]";
    requireObject(logo, label);
    requireStableId(logo.id, label + ".id");
    requireString(logo.shapeName, label + ".shapeName");
    requireValue(SHA256.test(logo.sha256 ?? ""), label + ".sha256 must be a SHA-256 digest.");
    requireValue(Array.isArray(logo.slideNumbers) && logo.slideNumbers.length > 0, label + ".slideNumbers must be non-empty.");
    logo.slideNumbers.forEach((slide, slideIndex) => requireFinite(slide, label + ".slideNumbers[" + slideIndex + "]", { min: 1, max: source.slideCount, integer: true }));
    requireUnique(logo.slideNumbers, label + ".slideNumbers");
  }
  requireUnique(logos.map((logo) => logo.id), "logos.id");

  const guides = profile.guides ?? { verticalPt: [], horizontalPt: [] };
  requireObject(guides, "guides");
  for (const [axis, maximum] of [["verticalPt", canvas.widthEmu / 12700], ["horizontalPt", canvas.heightEmu / 12700]]) {
    requireValue(Array.isArray(guides[axis]), "guides." + axis + " must be an array.");
    guides[axis].forEach((value, index) => requireFinite(value, "guides." + axis + "[" + index + "]", { min: 0, max: maximum }));
    requireUnique(guides[axis], "guides." + axis);
  }

  requireValue(Array.isArray(profile.archetypes) && profile.archetypes.length > 0, "archetypes must be non-empty.");
  for (const [index, archetype] of profile.archetypes.entries()) {
    const label = "archetypes[" + index + "]";
    requireObject(archetype, label);
    requireStableId(archetype.id, label + ".id");
    requireFinite(archetype.sourceSlide, label + ".sourceSlide", { min: 1, max: source.slideCount, integer: true });
    requireString(archetype.sourceSlideId, label + ".sourceSlideId");
    requireValue(ORIENTATIONS.has(archetype.orientation), label + ".orientation is invalid.");
    requireValue(archetype.orientation === canvas.orientation, label + ".orientation must match the source canvas in g22-v1.");
    if (archetype.layoutName !== undefined) requireString(archetype.layoutName, label + ".layoutName");
    if (archetype.masterName !== undefined) requireString(archetype.masterName, label + ".masterName");
    if (archetype.tags !== undefined) {
      requireValue(Array.isArray(archetype.tags), label + ".tags must be an array.");
      archetype.tags.forEach((tag, tagIndex) => requireStableId(tag, label + ".tags[" + tagIndex + "]"));
      requireUnique(archetype.tags, label + ".tags");
    }

    requireValue(Array.isArray(archetype.placeholders) && archetype.placeholders.length > 0, label + ".placeholders must be non-empty.");
    archetype.placeholders.forEach((placeholder, placeholderIndex) => validatePlaceholder(placeholder, label + ".placeholders[" + placeholderIndex + "]"));
    requireUnique(archetype.placeholders.map((placeholder) => placeholder.id), label + ".placeholders.id");
    requireUnique(archetype.placeholders.map((placeholder) => placeholder.shapeName), label + ".placeholders.shapeName");

    const chrome = requireObject(archetype.chrome, label + ".chrome");
    requireValue(Array.isArray(chrome.preservedShapeNames), label + ".chrome.preservedShapeNames must be an array.");
    chrome.preservedShapeNames.forEach((name, nameIndex) => requireString(name, label + ".chrome.preservedShapeNames[" + nameIndex + "]"));
    requireUnique(chrome.preservedShapeNames, label + ".chrome.preservedShapeNames");
    requireValue(Array.isArray(chrome.rimPairs), label + ".chrome.rimPairs must be an array.");
    chrome.rimPairs.forEach((pair, pairIndex) => validateRimPair(pair, label + ".chrome.rimPairs[" + pairIndex + "]"));
    requireUnique(chrome.rimPairs.map((pair) => pair.id), label + ".chrome.rimPairs.id");
  }

  requireUnique(profile.archetypes.map((archetype) => archetype.id), "archetypes.id");
  requireUnique(profile.archetypes.map((archetype) => archetype.sourceSlide), "archetypes.sourceSlide");
  profile.logos = logos;
  profile.guides = guides;
  return profile;
}

export async function loadDesignProfile(input) {
  if (typeof input === "string" || input instanceof URL) {
    const text = await fs.readFile(input, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error("Invalid design profile JSON: " + error.message);
    }
    return validateDesignProfile(parsed);
  }
  return validateDesignProfile(input);
}

export function selectDesignArchetype(profileInput, selector = {}) {
  const profile = validateDesignProfile(profileInput);
  requireObject(selector, "archetype selector");
  let matches = profile.archetypes;
  if (selector.id !== undefined) matches = matches.filter((archetype) => archetype.id === selector.id);
  if (selector.orientation !== undefined) matches = matches.filter((archetype) => archetype.orientation === selector.orientation);
  if (selector.layoutName !== undefined) matches = matches.filter((archetype) => archetype.layoutName === selector.layoutName);
  if (selector.tags !== undefined) {
    requireValue(Array.isArray(selector.tags), "archetype selector.tags must be an array.");
    matches = matches.filter((archetype) => selector.tags.every((tag) => archetype.tags?.includes(tag)));
  }
  if (matches.length === 0) throw new Error("No design archetype matches the explicit selector.");
  if (matches.length > 1) throw new Error("Design archetype selector is ambiguous (" + matches.map((item) => item.id).join(", ") + "); specify id.");
  return structuredClone(matches[0]);
}


function slug(value, fallback = "item") {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return normalized || fallback;
}

function extractedColor(entry, fallback = "#000000") {
  const value = entry?.value;
  return typeof value === "string" && /^[0-9a-f]{6}$/iu.test(value) ? "#" + value.toUpperCase() : fallback;
}

export function contractToRimPair(contract) {
  const vertical = contract.orientation === "vertical";
  const firstAppearance = contract.appearance?.[0] ?? {};
  const secondAppearance = contract.appearance?.[1] ?? {};
  const firstColor = extractedColor(firstAppearance.fill?.color ?? firstAppearance.line?.fill?.color);
  const secondColor = extractedColor(secondAppearance.fill?.color ?? secondAppearance.line?.fill?.color);
  const dash = (appearance) => {
    const value = appearance?.line?.dash ?? "solid";
    return ["solid", "dash", "dot", "dash-dot"].includes(value) ? value : "solid";
  };
  const members = [
    {
      side: vertical ? "left" : "top",
      shapeName: contract.first,
      widthPt: contract.thicknessEmu[0] / 12700,
      insetPt: contract.oppositeEdgeOffsetsEmu[0] / 12700,
      color: firstColor,
      dash: dash(firstAppearance),
    },
    {
      side: vertical ? "right" : "bottom",
      shapeName: contract.second,
      widthPt: contract.thicknessEmu[1] / 12700,
      insetPt: contract.oppositeEdgeOffsetsEmu[1] / 12700,
      color: secondColor,
      dash: dash(secondAppearance),
    },
  ];
  const preservedAsymmetry = contract.symmetric !== true;
  const contractName = contract.first + " " + contract.second;
  const role = /limit/iu.test(contractName) ? "limiting"
    : (/divider|rule/iu.test(contractName) ? "divider" : "rim");
  return {
    id: slug(contract.first + "-" + contract.second),
    role,
    symmetryPolicy: preservedAsymmetry ? "preserve-source-asymmetry" : "equal",
    ...(preservedAsymmetry ? {
      sourceAsymmetryReason: contract.declaredAsymmetry?.reason ?? "Source-bound asymmetry declaration.",
    } : {}),
    sourceContract: {
      part: contract.part,
      orientation: contract.orientation,
      thicknessEmu: [...contract.thicknessEmu],
      oppositeEdgeOffsetsEmu: [...contract.oppositeEdgeOffsetsEmu],
      equalAppearance: contract.equalAppearance,
      symmetric: contract.symmetric,
      declaredAsymmetry: structuredClone(contract.declaredAsymmetry),
    },
    members,
  };
}

export function adaptExtractedProfile(rawInput, intentInput) {
  requireObject(rawInput, "extracted profile");
  requireObject(intentInput, "design intent");
  const raw = structuredClone(rawInput);
  const intent = structuredClone(intentInput);
  requireValue(raw.schemaVersion === "slidewright-design-profile/v1", "extracted profile schemaVersion is unsupported.");
  requireValue(SHA256.test(raw.source?.sha256 ?? ""), "extracted profile source.sha256 is invalid.");
  requireValue(SHA256.test(raw.profileSha256 ?? ""), "extracted profile profileSha256 is invalid.");
  requireValue(SHA256.test(raw.portableIntegritySha256 ?? ""), "extracted profile portableIntegritySha256 is invalid.");
  const suppliedPortableIntegrity = raw.portableIntegritySha256.toLowerCase();
  delete raw.portableIntegritySha256;
  requireValue(portableProfileIntegrityHash(raw) === suppliedPortableIntegrity, "extracted profile integrity check failed.");
  requireValue(Array.isArray(raw.slides) && raw.slides.length > 0, "extracted profile must contain slides.");
  requireValue(Array.isArray(raw.objects), "extracted profile objects must be an array.");
  requireValue(Array.isArray(raw.layouts), "extracted profile layouts must be an array.");
  requireValue(Array.isArray(raw.themes) && raw.themes.length > 0, "extracted profile must contain a theme.");

  const expected = requireObject(intent.expected, "design intent.expected");
  const size = raw.presentation?.slideSize ?? {};
  const orientation = size.widthEmu === size.heightEmu ? "square" : (size.widthEmu > size.heightEmu ? "landscape" : "portrait");
  const theme = raw.themes[0];
  const major = theme.fonts?.majorFont?.latin || "Arial";
  const minor = theme.fonts?.minorFont?.latin || major;
  const families = [...new Set([major, minor, ...Object.values(theme.fonts ?? {}).flatMap((family) => Object.values(family ?? {}))].filter(Boolean))];
  const colors = Object.fromEntries(Object.entries(theme.colors ?? {}).map(([role, value]) => [slug(role), extractedColor(value)]));
  const guides = {
    verticalPt: (raw.presentation?.guides ?? []).filter((guide) => guide.orientation === "vertical").map((guide) => guide.positionPt),
    horizontalPt: (raw.presentation?.guides ?? []).filter((guide) => guide.orientation === "horizontal").map((guide) => guide.positionPt),
  };
  const layouts = new Map(raw.layouts.map((layout) => [layout.part, layout]));
  const masterName = raw.masters?.[0]?.name || undefined;
  const editableNames = new Set(expected.editablePlaceholders ?? []);
  const globalChrome = (raw.chrome?.objects ?? []).filter((item) => /logo|rail|rim|limit|footer|slide number|accent/iu.test(item.name));
  const slideNumbers = raw.slides.map((_, index) => index + 1);
  const expectedLogoGroup = expected.logoGroup;
  const explicitLogoNames = new Set((raw.assets?.logos ?? []).map((logo) => logo.name));
  const logoGroups = (raw.assets?.groups ?? []).filter((group) => (
    group.name === expectedLogoGroup
    || explicitLogoNames.has(group.name)
    || /(?:^|[-_\s])(logo|brandmark|wordmark)(?:$|[-_\s])/iu.test(group.name)
  ));

  const archetypes = raw.slides.map((slide, index) => {
    const sourceSlide = index + 1;
    const layoutName = layouts.get(slide.layoutPart)?.name || slide.layoutPart;
    const slideObjects = raw.objects.filter((item) => item.part === slide.part);
    const placeholders = slideObjects
      .filter((item) => item.placeholder && item.text && (editableNames.size === 0 || editableNames.has(item.name)))
      .map((item) => {
        requireValue(typeof item.objectKey === "string" && item.objectKey.length > 0
          && SHA256.test(item.xmlSha256 ?? "") && typeof item.id === "string"
          && Object.hasOwn(item, "creationId") && typeof item.creationId === "string"
          && Array.isArray(item.text.paragraphs) && item.text.paragraphs.length > 0
          && item.text.paragraphs.every((paragraph) => SHA256.test(paragraph.xmlSha256 ?? "")),
        `source placeholder ${item.name} lacks complete object identity and paragraph hashes.`);
        return ({
        id: slug(item.name),
        shapeName: item.name,
        placeholderType: item.placeholder.type,
        placeholderIndex: item.placeholder.index,
        sourceText: item.text.plainText,
        sourceObjectKey: item.objectKey,
        sourceObjectSha256: item.xmlSha256,
        sourceShapeId: item.id,
        sourceCreationId: item.creationId ?? "",
        sourceParagraphSha256s: item.text.paragraphs.map((paragraph) => paragraph.xmlSha256),
        allowedEdits: ["text"],
        required: true,
        maxCharacters: item.placeholder.type === "title" ? 100 : 360,
        maxLines: item.placeholder.type === "title" ? 2 : 8,
        });
      });
    requireValue(placeholders.length > 0, "source slide " + sourceSlide + " has no declared editable placeholders.");
    const relevantParts = new Set([slide.layoutPart, ...(raw.masters ?? []).map((master) => master.part)]);
    const rimPairs = (raw.symmetryContracts ?? []).filter((contract) => relevantParts.has(contract.part)).map(contractToRimPair);
    return {
      id: slug(layoutName, "slide-" + sourceSlide),
      sourceSlide,
      sourceSlideId: slide.part,
      layoutName,
      ...(masterName ? { masterName } : {}),
      orientation,
      tags: [slug(layoutName)],
      placeholders,
      chrome: {
        preservedShapeNames: [...new Set(globalChrome.filter((item) => relevantParts.has(item.part)).map((item) => item.name))],
        rimPairs,
      },
    };
  });

  return validateDesignProfile({
    version: "g22-v1",
    id: "profile-" + raw.profileSha256.slice(0, 16),
    source: {
      kind: "native-pptx",
      fileName: intent.source,
      sha256: raw.source.sha256,
      slideCount: raw.slides.length,
      canvas: { widthEmu: size.widthEmu, heightEmu: size.heightEmu, orientation },
    },
    reusePolicy: { mode: "clone-source-deck", preserveUndeclaredObjects: true, allowArbitraryImport: false },
    theme: {
      fonts: { major, minor, families },
      colors,
      commonFontSizesPt: expected.integerFontSizes,
    },
    guides,
    logos: logoGroups.map((logo) => ({
      id: slug(logo.name),
      shapeName: logo.name,
      sha256: logo.xmlSha256,
      slideNumbers,
    })),
    archetypes,
  });
}
