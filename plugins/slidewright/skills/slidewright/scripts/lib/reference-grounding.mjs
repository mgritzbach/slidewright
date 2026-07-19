import { portableProfileIntegrityHash } from "./design-profile.mjs";
import { fitText, textFromRuns } from "./typography.mjs";

const SCHEMA_VERSION = "slidewright-design-provenance/v1";
const PROFILE_SCHEMA = "slidewright-design-profile/v1";
const CONCEPT_SCHEMA = "slidewright-design-concept-inventory/v1";
const SHA256 = /^[0-9a-f]{64}$/iu;

const COMPATIBILITY = Object.freeze({
  hero: ["statement"],
  section: ["statement", "process-flow"],
  table: ["table-matrix"],
  "two-column": ["comparison"],
  "icon-list": ["radial-diagram", "layered-diagram", "process-flow", "column-cards"],
  continuation: ["structured-content", "column-cards", "process-flow"],
});

const EXCLUDED_VARIANTS = Object.freeze({
  table: new Set(["gantt-grid", "logo-grid", "media-caption-grid"]),
});

function sourceHex(color) {
  // Office's default theme represents dk1/lt1 as system colors. The profile
  // extractor normalizes sysClr/@lastClr into `value`, while imported profile
  // producers may preserve the original `lastClr` field as well. Never use
  // the symbolic system name (for example `windowText`) as a hex token.
  const value = color?.kind === "srgbClr"
    ? color.value
    : color?.kind === "sysClr"
      ? (color.lastClr ?? color.value)
      : null;
  return /^[0-9a-f]{6}$/iu.test(value ?? "") ? `#${value.toUpperCase()}` : null;
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../gu).map((pair) => Number.parseInt(pair, 16) / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const [lighter, darker] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function firstContrasting(entries, against, minimum = 3) {
  if (!against) return entries.find(([, value]) => value) ?? [null, null];
  return entries.find(([, value]) => value && contrastRatio(value, against) >= minimum) ?? entries.find(([, value]) => value) ?? [null, null];
}

function dominantThemeBinding(profile) {
  const chains = profile.presentation?.inheritanceChains ?? [];
  const ranked = new Map();
  for (const [displayOrder, chain] of chains.entries()) {
    if (!chain?.themePart) continue;
    const current = ranked.get(chain.themePart) ?? { themePart: chain.themePart, inheritedSlides: 0, firstDisplayOrder: displayOrder, slideParts: [] };
    current.inheritedSlides += 1;
    current.slideParts.push(chain.slidePart);
    ranked.set(chain.themePart, current);
  }
  const selected = [...ranked.values()].sort((left, right) => right.inheritedSlides - left.inheritedSlides || left.firstDisplayOrder - right.firstDisplayOrder || left.themePart.localeCompare(right.themePart))[0];
  if (!selected) return null;
  const theme = (profile.themes ?? []).find((candidate) => candidate.part === selected.themePart);
  return theme ? { ...selected, theme } : null;
}

function sourceStructureProvenance(profile, dominant) {
  const chains = profile.presentation?.inheritanceChains ?? [];
  const masterParts = [...new Set(chains.map((item) => item.masterPart).filter(Boolean))];
  const layoutParts = [...new Set(chains.map((item) => item.layoutPart).filter(Boolean))];
  const chrome = profile.chrome?.objects ?? [];
  const logos = chrome.filter((item) => /(?:client\s+)?logo/iu.test(item.name ?? ""));
  return {
    inheritanceSelection: dominant ? {
      method: "most-inherited-theme-in-display-order; ties resolve to first displayed slide",
      themePart: dominant.themePart,
      inheritedSlides: dominant.inheritedSlides,
      firstDisplayOrder: dominant.firstDisplayOrder + 1,
      displayOrderSlideParts: dominant.slideParts,
    } : null,
    guides: stableClone(profile.presentation?.guides ?? []),
    masters: (profile.masters ?? []).filter((item) => masterParts.includes(item.part)).map((item) => ({ part: item.part, name: item.name ?? "", sha256: item.sha256, relationshipSha256: item.relationshipSha256 })),
    layouts: (profile.layouts ?? []).filter((item) => layoutParts.includes(item.part)).map((item) => ({ part: item.part, name: item.name ?? "", sha256: item.sha256, relationshipSha256: item.relationshipSha256 })),
    logos: logos.map((item) => ({ objectKey: item.objectKey, part: item.part, name: item.name, type: item.type, geometry: item.geometry, styleFingerprint: item.styleFingerprint, xmlSha256: item.xmlSha256 })),
    chrome: {
      objectCount: chrome.length,
      objectKeys: chrome.map((item) => item.objectKey),
      applicationStatus: "provenance-only",
      reason: "Reference grounding reconstructs approved native compositions; it does not silently import arbitrary source chrome or proprietary logo assets.",
    },
  };
}

function deriveReferenceTokens(profile) {
  const dominant = dominantThemeBinding(profile);
  const structure = sourceStructureProvenance(profile, dominant);
  if (!dominant) return { available: false, reason: "No display-order inheritance chain resolved to an extracted theme.", structure };
  const colors = dominant.theme.colors ?? {};
  const background = sourceHex(colors.lt1);
  const accent = sourceHex(colors.accent1);
  const [subtleKey, subtle] = firstContrasting([["accent3", sourceHex(colors.accent3)], ["dk2", sourceHex(colors.dk2)], ["dk1", sourceHex(colors.dk1)]], background);
  const [accentSoftKey, accentSoft] = firstContrasting([["accent2", sourceHex(colors.accent2)], ["accent4", sourceHex(colors.accent4)], ["lt2", sourceHex(colors.lt2)], ["lt1", background]], accent);
  const palette = {
    background,
    surface: sourceHex(colors.lt2) ?? sourceHex(colors.lt1),
    text: sourceHex(colors.dk1),
    muted: sourceHex(colors.dk2),
    subtle,
    accent,
    accentSoft,
    border: sourceHex(colors.accent4),
    success: sourceHex(colors.accent6) ?? sourceHex(colors.accent5),
  };
  const missingColors = Object.entries(palette).filter(([, value]) => !value).map(([key]) => key);
  const major = dominant.theme.fonts?.majorFont?.latin?.trim() || null;
  const minor = dominant.theme.fonts?.minorFont?.latin?.trim() || null;
  return {
    available: missingColors.length === 0 && Boolean(major && minor),
    reason: missingColors.length ? `Dominant theme lacks explicit sRGB tokens for: ${missingColors.join(", ")}.` : (!major || !minor ? "Dominant theme lacks explicit major/minor Latin font identities." : null),
    sourceTheme: {
      part: dominant.theme.part,
      name: dominant.theme.name ?? "",
      sha256: dominant.theme.sha256,
      inheritedSlides: dominant.inheritedSlides,
      firstDisplayOrder: dominant.firstDisplayOrder + 1,
    },
    sourceScheme: Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, { value: sourceHex(value), kind: value?.kind ?? null }])),
    colors: Object.fromEntries(Object.entries(palette).map(([token, value]) => [token, {
      value,
      sourceSchemeKey: ({ background: "lt1", surface: "lt2", text: "dk1", muted: "dk2", subtle: subtleKey, accent: "accent1", accentSoft: accentSoftKey, border: "accent4", success: colors.accent6 ? "accent6" : "accent5" })[token],
      sourceThemePart: dominant.theme.part,
    }])),
    fonts: {
      major: { value: major, sourceRole: "majorFont.latin", sourceThemePart: dominant.theme.part },
      minor: { value: minor, sourceRole: "minorFont.latin", sourceThemePart: dominant.theme.part },
      substitutionPolicy: "forbid",
    },
    structure,
  };
}

function replaceExactColors(value, replacements) {
  if (typeof value === "string") return replacements.get(value.toUpperCase()) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceExactColors(item, replacements));
  if (!value || typeof value !== "object") return value;
  for (const [key, child] of Object.entries(value)) value[key] = replaceExactColors(child, replacements);
  return value;
}

function applyReferenceTokens(plan, tokenRecord) {
  if (!tokenRecord.available) return { applied: false, reason: tokenRecord.reason };
  const oldColors = { ...plan.theme.colors };
  const newColors = Object.fromEntries(Object.entries(tokenRecord.colors).map(([key, item]) => [key, item.value]));
  const replacements = new Map(Object.keys(newColors).map((key) => [String(oldColors[key]).toUpperCase(), newColors[key]]));
  replaceExactColors(plan.slides, replacements);
  plan.theme.colors = newColors;
  // A generated logical master permits one explicit family. Select the
  // source theme's minor family rather than substituting an unrelated local
  // font when its display/major face is unavailable. The later font audit
  // still fails closed if this source-minor family is unavailable.
  const appliedFamily = tokenRecord.fonts.minor.value;
  plan.theme.fontFamily = appliedFamily;
  plan.theme.fallbackFontFamily = null;
  plan.theme.referenceFontRoles = {
    major: tokenRecord.fonts.major.value,
    minor: tokenRecord.fonts.minor.value,
    appliedMode: "source-minor-deck-binding",
    note: "The generated logical-master contract permits one explicit deck family. The source major display font remains provenance-bound; no unrelated local fallback is substituted.",
  };
  if (plan.designSystem?.logicalMaster) plan.designSystem.logicalMaster.fontFamily = appliedFamily;
  for (const slide of plan.slides) {
    for (const shape of slide.shapes ?? []) {
      if (shape.type === "text") shape.style.typeface = appliedFamily;
      if (shape.type === "table") for (const style of Object.values(shape.table?.styles ?? {})) style.typeface = appliedFamily;
    }
  }
  return {
    applied: true,
    fontApplication: {
      appliedFamily,
      appliedSourceRole: "minorFont.latin",
      majorFamilyPreservedInMetadata: tokenRecord.fonts.major.value,
      silentSubstitutionAllowed: false,
    },
  };
}

function fail(message) {
  throw new Error("Reference grounding failed: " + message);
}

function stableClone(value) {
  return structuredClone(value);
}

function textOf(shape) {
  if (shape.type === "table") return shape.table?.values?.flat().join(" ") ?? "";
  return (shape.text?.paragraphs ?? [])
    .flatMap((paragraph) => paragraph.runs ?? [])
    .map((run) => run.text ?? "")
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokens(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z0-9]{3,}/gu) ?? []);
}

function overlapScore(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((item) => b.has(item)).length / new Set([...a, ...b]).size;
}

function slideTitle(slide) {
  return textOf(slide.shapes.find((shape) => shape.role === "title") ?? slide.shapes[0] ?? {});
}

function slideDensity(slide) {
  const characters = slide.shapes.map(textOf).join(" ").length;
  return characters >= 700 ? "high" : characters >= 260 ? "medium" : "low";
}

function slideItemCount(slide) {
  if (slide.layout === "table") {
    const headers = slide.shapes.find((shape) => shape.type === "table")?.table?.values?.[0] ?? [];
    return Math.max(0, headers.length - (headers[0] === "#" ? 1 : 0));
  }
  if (slide.layout === "two-column") return 2;
  if (slide.layout === "icon-list") return cardSurfaces(slide).length;
  if (["hero", "section", "continuation"].includes(slide.layout)) return 1;
  return 0;
}

function validateProfile(input) {
  const profile = stableClone(input);
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) fail("profile must be an object.");
  if (profile.schemaVersion !== PROFILE_SCHEMA) fail(`profile schema must be '${PROFILE_SCHEMA}'.`);
  if (!SHA256.test(profile.profileSha256 ?? "") || !SHA256.test(profile.portableIntegritySha256 ?? "")) fail("profile hashes are invalid.");
  const supplied = profile.portableIntegritySha256.toLowerCase();
  delete profile.portableIntegritySha256;
  if (portableProfileIntegrityHash(profile) !== supplied) fail("profile portable-integrity hash does not match its contents.");
  profile.portableIntegritySha256 = supplied;
  const inventory = profile.designConceptInventory;
  if (inventory?.schemaVersion !== CONCEPT_SCHEMA || !Array.isArray(inventory.concepts)) fail("profile lacks the semantic design-concept inventory.");
  if (inventory.concepts.length !== inventory.viableSlides) fail("viable slide count does not match concept inventory.");
  if (inventory.slideInventory?.filter((item) => item.viable).length !== inventory.concepts.length) fail("slide viability inventory does not close.");
  return profile;
}

function compatibleConcepts(slide, concepts) {
  const allowed = COMPATIBILITY[slide.layout] ?? ["structured-content"];
  const itemCount = slideItemCount(slide);
  const excludedVariants = EXCLUDED_VARIANTS[slide.layout] ?? new Set();
  const exact = concepts.filter((concept) => {
    if (!allowed.includes(concept.composition?.model) || concept.suitability?.requiresMedia === true) return false;
    if (concept.blueprint?.reconstructableWithNativeObjects === false) return false;
    if (excludedVariants.has(concept.composition?.variant)) return false;
    if (!adapterSupport(slide, concept).supported) return false;
    if (slide.layout === "table") {
      const sourceColumns = Number(concept.composition?.itemCount ?? 0);
      return sourceColumns > 0 && sourceColumns === itemCount;
    }
    const minimum = Number(concept.suitability?.minimumItems ?? 0);
    const maximum = Number(concept.suitability?.maximumItems ?? 12);
    return itemCount === 0 || (itemCount >= minimum && itemCount <= maximum);
  });
  return exact.length ? { candidates: exact, fallback: false, allowed } : { candidates: concepts.filter((concept) => concept.suitability?.requiresMedia !== true), fallback: true, allowed };
}

function variantAffinity(slide, concept) {
  const variant = concept.composition?.variant;
  if (["hero", "section"].includes(slide.layout)) return variant === "centered-color-field" ? 35 : 0;
  if (slide.layout === "table") {
    const columns = slide.shapes.find((shape) => shape.type === "table")?.table?.values?.[0]?.length ?? 0;
    if (columns === 3 && variant === "numbered-three-column-grid") return 120;
    return variant === "option-matrix" ? 80 : variant === "banded-matrix" ? 40 : 0;
  }
  if (slide.layout === "two-column") return variant === "split-highlight" ? 42 : variant === "dual-rail" ? 38 : 0;
  if (slide.layout === "icon-list") {
    if (slideItemCount(slide) === 3) return variant === "triangular-cycle" ? 55 : variant === "hub-spoke" ? 48 : variant === "chevron-steps" ? 32 : 0;
    if (slideItemCount(slide) === 4) return variant === "four-callout-quadrant" ? 55 : variant === "stair-step" ? 48 : 0;
  }
  return 0;
}

function selectConcept(slide, concepts, usage, modelUsage) {
  const { candidates, fallback, allowed } = compatibleConcepts(slide, concepts);
  if (!candidates.length) return { concept: null, confidence: 0, fallback: true, score: 0 };
  const title = slideTitle(slide);
  const density = slideDensity(slide);
  const scored = candidates.map((concept) => {
    const model = concept.composition.model;
    const compatibility = allowed.includes(model) ? 90 - allowed.indexOf(model) * 6 : 10;
    const novelty = modelUsage.get(model) ? -modelUsage.get(model) * 18 : 34;
    const conceptNovelty = usage.get(concept.id) ? -usage.get(concept.id) * 50 : 16;
    const titleAffinity = overlapScore(title, `${concept.sourceTitle} ${(concept.tags ?? []).join(" ")}`) * 35;
    const densityAffinity = concept.density?.level === density ? 8 : 0;
    const topologyAffinity = concept.composition?.itemCount === slideItemCount(slide) ? 28 : 0;
    const blueprintAffinity = concept.blueprint?.reconstructableWithNativeObjects === true ? 12 : 0;
    const score = compatibility + novelty + conceptNovelty + titleAffinity + densityAffinity + topologyAffinity + blueprintAffinity + variantAffinity(slide, concept) + Number(concept.confidence ?? 0) * 5;
    return { concept, score };
  }).sort((left, right) => right.score - left.score || left.concept.sourceSlide - right.concept.sourceSlide || left.concept.id.localeCompare(right.concept.id));
  const selected = scored[0];
  usage.set(selected.concept.id, (usage.get(selected.concept.id) ?? 0) + 1);
  modelUsage.set(selected.concept.composition.model, (modelUsage.get(selected.concept.composition.model) ?? 0) + 1);
  return {
    concept: selected.concept,
    confidence: Math.max(0.5, Math.min(0.99, Number((selected.score / 200).toFixed(3)))),
    fallback,
    score: Number(selected.score.toFixed(3)),
  };
}

function descendants(slide, backingId) {
  return slide.shapes.filter((shape) => shape.parentId === backingId || shape.backingId === backingId);
}

function cardSurfaces(slide) {
  return slide.shapes.filter((shape) => shape.type === "shape" && (shape.role === "semantic-card" || /-(?:left|right)-surface$/u.test(shape.id)));
}

function adapterSupport(slide, concept) {
  const model = concept.composition?.model;
  const variant = concept.composition?.variant ?? concept.blueprint?.variant ?? model;
  const surfaces = cardSurfaces(slide);
  const table = slide.shapes.find((shape) => shape.type === "table");
  const titleSurface = slide.shapes.find((shape) => /title-surface/u.test(shape.id));
  if (model === "statement" && variant === "centered-color-field" && (slide.layout === "hero" || titleSurface)) return { supported: true, adapterId: "statement-color-field-v1" };
  if (model === "comparison" && surfaces.length === 2 && ["split-highlight", "dual-rail"].includes(variant)) return { supported: true, adapterId: `comparison-${variant}-v1` };
  if (variant === "triangular-cycle" && surfaces.length === 3) return { supported: true, adapterId: "triangular-cycle-v1" };
  if (variant === "four-callout-quadrant" && surfaces.length === 4) return { supported: true, adapterId: "four-callout-quadrant-v1" };
  if (variant === "stair-step" && surfaces.length === 4) return { supported: true, adapterId: "stair-step-v1" };
  if (variant === "hub-spoke" && [3, 4].includes(surfaces.length)) return { supported: true, adapterId: "hub-spoke-v1" };
  if (model === "process-flow" && variant === "chevron-steps" && surfaces.length >= 2) return { supported: true, adapterId: "chevron-steps-v1" };
  if (model === "column-cards" && ["parallel-cards", "three-column-cards", "four-column-cards"].includes(variant) && surfaces.length >= 2) return { supported: true, adapterId: `column-cards-${variant}-v1` };
  if (model === "structured-content" && variant === "stacked-content" && slide.layout === "continuation") return { supported: true, adapterId: "stacked-content-v1" };
  if (model === "table-matrix" && table) {
    const columns = table.table?.values?.[0]?.length ?? 0;
    if (variant === "banded-matrix") return { supported: true, adapterId: "banded-matrix-v1" };
    if (variant === "option-matrix" && columns >= 2) return { supported: true, adapterId: "option-matrix-v1" };
    if (variant === "numbered-three-column-grid" && (columns === 3 || (columns === 4 && table.table?.values?.[0]?.[0] === "#"))) return { supported: true, adapterId: "numbered-three-column-grid-v1" };
  }
  return { supported: false, adapterId: null };
}

function refitTextShape(shape) {
  if (shape.type !== "text" || !shape.fit) return;
  const fit = fitText({
    text: textFromRuns(shape.text.runs),
    paragraphs: shape.text.paragraphs,
    width: shape.position.width,
    height: shape.position.height,
    preferredSizePt: shape.fit.preferredSizePt,
    minSizePt: shape.fit.minSizePt,
    lineHeight: shape.style.lineHeight,
    insets: shape.style.insets,
    glyphFactor: shape.fit.glyphFactor,
    maxLines: shape.fit.maxLines,
  });
  shape.fit = fit;
  shape.style.fontSizePt = fit.fontSizePt;
}

function setCardLayout(slide, surface, position) {
  surface.position = { ...position };
  surface.padding = { top: 16, right: 16, bottom: 16, left: 16 };
  const children = descendants(slide, surface.id);
  const icon = children.find((shape) => shape.role === "icon");
  const heading = children.find((shape) => shape.role === "subheading");
  const body = children.find((shape) => shape.role === "body");
  if (icon) icon.position = { left: position.left + 16, top: position.top + 16, width: 64, height: 40 };
  if (heading) heading.position = { left: position.left + 88, top: position.top + 16, width: position.width - 104, height: 56 };
  if (body) body.position = { left: position.left + 16, top: position.top + 84, width: position.width - 32, height: position.height - 100 };
  children.forEach(refitTextShape);
}

function addNativeDiagramShape(slide, shape) {
  if (!slide.shapes.some((candidate) => candidate.id === shape.id)) slide.shapes.push({ ...shape, editable: true });
}

function applyTriangularCycle(slide, surfaces, theme) {
  const positions = [
    { left: 64, top: 200, width: 360, height: 208 },
    { left: 856, top: 264, width: 360, height: 208 },
    { left: 460, top: 448, width: 360, height: 208 },
  ];
  surfaces.slice(0, 3).forEach((surface, index) => {
    surface.geometry = "roundRect";
    surface.radius = 18;
    surface.fill = theme.colors.background;
    surface.line = { color: theme.colors.accent, width: 2 };
    setCardLayout(slide, surface, positions[index]);
  });
  addNativeDiagramShape(slide, {
    id: `${slide.id}-reference-triangle`, type: "shape", role: "reference-diagram", geometry: "triangle",
    position: { left: 472, top: 214, width: 336, height: 222 }, fill: theme.colors.accentSoft,
    line: { color: theme.colors.accent, width: 3 }, radius: 0,
  });
}

function applyFourCalloutQuadrant(slide, surfaces, theme) {
  const positions = [
    { left: 64, top: 200, width: 340, height: 208 },
    { left: 876, top: 200, width: 340, height: 208 },
    { left: 64, top: 448, width: 340, height: 208 },
    { left: 876, top: 448, width: 340, height: 208 },
  ];
  surfaces.slice(0, 4).forEach((surface, index) => {
    surface.geometry = "rect";
    surface.radius = 0;
    surface.fill = theme.colors.background;
    surface.line = { color: theme.colors.accent, width: 1 };
    setCardLayout(slide, surface, positions[index]);
  });
  const squares = [
    { left: 456, top: 252 }, { left: 642, top: 252 },
    { left: 456, top: 378 }, { left: 642, top: 378 },
  ];
  squares.forEach((position, index) => {
    const squareId = `${slide.id}-reference-quadrant-${index + 1}`;
    addNativeDiagramShape(slide, {
      id: squareId, type: "shape", role: "reference-diagram", geometry: "rect",
      position: { ...position, width: 174, height: 114 }, fill: index === 3 ? theme.colors.accent : theme.colors.accentSoft,
      line: { color: theme.colors.background, width: 2 }, radius: 0,
      padding: { top: 16, right: 16, bottom: 16, left: 16 },
    });
    const icon = descendants(slide, surfaces[index].id).find((shape) => shape.role === "icon");
    const heading = descendants(slide, surfaces[index].id).find((shape) => shape.role === "subheading");
    if (heading) {
      heading.position.left = surfaces[index].position.left + 16;
      heading.position.width = surfaces[index].position.width - 32;
      refitTextShape(heading);
    }
    if (!icon) return;
    icon.parentId = squareId;
    icon.backingId = squareId;
    icon.position = { left: position.left + 55, top: position.top + 33, width: 64, height: 48 };
    if (index === 3) icon.style.color = theme.colors.background;
    refitTextShape(icon);
    const backing = slide.layoutContract?.backings?.find((contract) => contract.contentIds?.includes(icon.id));
    if (backing) backing.backingId = squareId;
    slide.shapes.splice(slide.shapes.indexOf(icon), 1);
    slide.shapes.push(icon);
  });
}

function applyHubSpoke(slide, surfaces, theme) {
  const positions = surfaces.length === 4 ? [
    { left: 510, top: 184, width: 260, height: 168 },
    { left: 64, top: 352, width: 260, height: 168 },
    { left: 956, top: 352, width: 260, height: 168 },
    { left: 510, top: 468, width: 260, height: 168 },
  ] : [
    { left: 92, top: 218, width: 300, height: 180 },
    { left: 888, top: 218, width: 300, height: 180 },
    { left: 490, top: 484, width: 300, height: 172 },
  ];
  surfaces.forEach((surface, index) => {
    surface.geometry = "roundRect";
    surface.radius = 24;
    surface.fill = theme.colors.background;
    surface.line = { color: theme.colors.accent, width: 2 };
    setCardLayout(slide, surface, positions[index]);
  });
  for (const role of ["subheading", "body"]) {
    const peers = surfaces.map((surface) => descendants(slide, surface.id).find((shape) => shape.role === role)).filter(Boolean);
    const commonSize = Math.min(...peers.map((shape) => shape.style.fontSizePt));
    for (const peer of peers) {
      peer.style.fontSizePt = commonSize;
      if (peer.fit) peer.fit.fontSizePt = commonSize;
    }
  }
  const hub = { left: 526, top: 364, width: 228, height: 92 };
  const spokePositions = surfaces.length === 4 ? [
    { left: 636, top: 350, width: 8, height: 16 },
    { left: 324, top: 406, width: 204, height: 8 },
    { left: 752, top: 406, width: 204, height: 8 },
    { left: 636, top: 454, width: 8, height: 16 },
  ] : [
    { left: 390, top: 402, width: 138, height: 8 },
    { left: 752, top: 402, width: 138, height: 8 },
    { left: 636, top: 462, width: 8, height: 24 },
  ];
  const hubId = `${slide.id}-reference-hub`;
  spokePositions.forEach((position, index) => {
    const spokeId = `${slide.id}-reference-spoke-${index + 1}`;
    addNativeDiagramShape(slide, {
      id: spokeId, type: "shape", role: "reference-connector", geometry: "rect",
      position, fill: theme.colors.accent, line: { color: theme.colors.accent, width: 0 }, radius: 0,
      constraints: { allowOverlapWith: [hubId, ...slide.shapes.map((shape) => shape.id)] },
    });
    slide.layoutContract.structuralSplits.push({ shapeId: spokeId, orientation: position.width >= position.height ? "horizontal" : "vertical" });
  });
  addNativeDiagramShape(slide, {
    id: hubId, type: "shape", role: "reference-diagram", geometry: "ellipse",
    position: hub, fill: theme.colors.accent, line: { color: theme.colors.background, width: 2 }, radius: 0,
    constraints: { allowOverlapWith: spokePositions.map((_, index) => `${slide.id}-reference-spoke-${index + 1}`) },
  });
}

function applyStairStep(slide, surfaces, theme) {
  surfaces.forEach((surface, index) => {
    const position = { left: 64 + index * 294, top: 272 - index * 28, width: 270, height: 384 + index * 28 };
    surface.geometry = "rect";
    surface.radius = 0;
    surface.fill = theme.colors.background;
    surface.line = { color: theme.colors.accent, width: 1 };
    setCardLayout(slide, surface, position);
    addNativeDiagramShape(slide, {
      id: `${slide.id}-reference-step-${index + 1}`, type: "shape", role: "reference-diagram", geometry: "rect",
      position: { left: position.left + 16, top: position.top + 16, width: position.width - 32, height: 18 + index * 18 },
      fill: index === surfaces.length - 2 ? theme.colors.accent : theme.colors.border,
      line: { color: index === surfaces.length - 2 ? theme.colors.accent : theme.colors.border, width: 0 }, radius: 0,
      parentId: surface.id,
    });
    const children = descendants(slide, surface.id).filter((shape) => shape.type === "text");
    for (const child of children) {
      child.position.top += 40 + index * 18;
      child.position.height = Math.max(36, child.position.height - 40 - index * 18);
      refitTextShape(child);
    }
  });
}

function applyComparison(slide, surfaces, variant, theme) {
  surfaces.slice(0, 2).forEach((surface, index) => {
    surface.geometry = "rect";
    surface.radius = 0;
    surface.padding = { top: 24, right: 24, bottom: 24, left: 24 };
    surface.fill = variant === "split-highlight" && index === 0 ? theme.colors.accentSoft : theme.colors.background;
    surface.line = { color: theme.colors.accent, width: 2 };
    const children = descendants(slide, surface.id).filter((shape) => shape.type === "text");
    for (const child of children) refitTextShape(child);
    if (variant === "dual-rail") addNativeDiagramShape(slide, {
      id: `${surface.id}-reference-rail`, type: "shape", role: "reference-diagram", geometry: "rect", parentId: surface.id,
      position: { left: index === 0 ? surface.position.left + 24 : surface.position.left + surface.position.width - 32, top: surface.position.top + 24, width: 8, height: surface.position.height - 48 },
      fill: index === 0 ? theme.colors.accentSoft : theme.colors.accent,
      line: { color: theme.colors.accent, width: 0 }, radius: 0,
    });
  });
}

function applyConceptVisual(slide, concept, theme) {
  const model = concept.composition.model;
  const variant = concept.composition.variant ?? concept.blueprint?.variant ?? model;
  const support = adapterSupport(slide, concept);
  const surfaces = cardSurfaces(slide);
  const titleSurface = slide.shapes.find((shape) => /title-surface/u.test(shape.id));
  const adaptations = [`adapted the native ${slide.layout} archetype to the reference ${model}/${variant} composition`, "retained all visible copy as native editable PowerPoint text"];
  if (model === "comparison" && surfaces.length >= 2) {
    applyComparison(slide, surfaces, variant, theme);
    adaptations.push(variant === "dual-rail" ? "reconstructed the paired feature rails with native editable panels" : "reconstructed the strong filled-versus-open split comparison");
  } else if (variant === "triangular-cycle" && surfaces.length === 3) {
    applyTriangularCycle(slide, surfaces, theme);
    adaptations.push("reconstructed the three-node triangular topology with an editable native triangle and three bounded callouts");
  } else if (variant === "four-callout-quadrant" && surfaces.length === 4) {
    applyFourCalloutQuadrant(slide, surfaces, theme);
    adaptations.push("reconstructed the four outer callouts and central two-by-two native-shape quadrant");
  } else if (variant === "stair-step" && surfaces.length === 4) {
    applyStairStep(slide, surfaces, theme);
    adaptations.push("reconstructed the four-step ascending bar and column rhythm with editable native objects");
  } else if (variant === "hub-spoke" && [3, 4].includes(surfaces.length)) {
    applyHubSpoke(slide, surfaces, theme);
    adaptations.push("reconstructed an observable native hub-and-spoke topology with a central hub, explicit spokes, and bounded outer nodes");
  } else if (model === "process-flow" && surfaces.length) {
    surfaces.forEach((surface, index) => {
      surface.geometry = "chevron";
      surface.radius = 0;
      surface.fill = index === surfaces.length - 1 ? theme.colors.accentSoft : theme.colors.surface;
      surface.line = { color: theme.colors.accent, width: 1 };
    });
    adaptations.push("converted the peer components into a directional native chevron sequence");
  } else if (model === "process-flow" && titleSurface) {
    titleSurface.geometry = "chevron";
    titleSurface.radius = 0;
    titleSurface.fill = theme.colors.accentSoft;
    titleSurface.line = { color: theme.colors.accent, width: 2 };
    adaptations.push("converted the section band into a directional native chevron transition");
  } else if (model === "layered-diagram" && surfaces.length) {
    surfaces.forEach((surface, index) => {
      const verticalOffset = index * 10;
      surface.geometry = "rect";
      surface.radius = 0;
      surface.fill = index === surfaces.length - 1 ? theme.colors.accentSoft : theme.colors.surface;
      surface.line = { color: theme.colors.accent, width: 1 };
      surface.position.top += verticalOffset;
      for (const child of descendants(slide, surface.id)) child.position.top += verticalOffset;
    });
    adaptations.push("retained the layered native-shape hierarchy through stepped editable panels without allowing text to cross the panel boundary");
  } else if (model === "column-cards" && surfaces.length) {
    surfaces.forEach((surface, index) => {
      surface.geometry = "rect";
      surface.radius = 0;
      surface.fill = index % 2 === 0 ? theme.colors.background : theme.colors.accentSoft;
      surface.line = { color: theme.colors.accent, width: index === 0 ? 2 : 1 };
    });
    adaptations.push("retained the aligned modular column-card system");
  } else if (model === "structured-content" && variant === "stacked-content" && slide.layout === "continuation") {
    const railId = `${slide.id}-reference-stack-rail`;
    addNativeDiagramShape(slide, {
      id: railId, type: "shape", role: "reference-diagram", geometry: "rect",
      position: { left: slide.frame.left, top: slide.frame.top + 80, width: 8, height: slide.frame.height - 96 },
      fill: theme.colors.accent, line: { color: theme.colors.accent, width: 0 }, radius: 0,
      constraints: { allowOverlapWith: slide.shapes.map((shape) => shape.id) },
    });
    slide.layoutContract.structuralSplits.push({ shapeId: railId, orientation: "vertical" });
    adaptations.push("reconstructed the stacked-content hierarchy with an observable native alignment rail");
  } else if (["table-matrix", "chart-led"].includes(model)) {
    const table = slide.shapes.find((shape) => shape.type === "table");
    if (table) {
      if (variant === "numbered-three-column-grid" && table.table.values[0]?.length === 3) {
        table.table.values = table.table.values.map((row, index) => [index === 0 ? "#" : String(index), ...row]);
        const numberWidth = 72;
        table.table.columnWidths = [numberWidth, ...Array(3).fill((table.position.width - numberWidth) / 3)];
        table.table.styles.header.fill = theme.colors.background;
        table.table.styles.header.color = theme.colors.accent;
        table.table.styles.body.fill = theme.colors.background;
        addNativeDiagramShape(slide, {
          id: `${slide.id}-reference-grid-arrow`, type: "shape", role: "reference-diagram", geometry: "rightArrow",
          position: { left: table.position.left, top: table.position.top - 20, width: table.position.width, height: 8 },
          fill: theme.colors.accent, line: { color: theme.colors.accent, width: 0 }, radius: 0,
        });
        adaptations.push("reconstructed the source's numbered three-column executive grid and directional header rule with native table and shape objects");
      } else if (variant === "option-matrix") {
        table.table.styles.header.fill = theme.colors.background;
        table.table.styles.header.color = theme.colors.accent;
        table.table.styles.body.fill = theme.colors.background;
        const columnWidths = table.table.columnWidths;
        const highlightedIndex = Math.max(0, columnWidths.length - 1);
        addNativeDiagramShape(slide, {
          id: `${slide.id}-reference-option-highlight`, type: "shape", role: "reference-diagram", geometry: "rect",
          position: {
            left: table.position.left + columnWidths.slice(0, highlightedIndex).reduce((sum, width) => sum + width, 0),
            top: table.position.top,
            width: columnWidths[highlightedIndex],
            height: table.position.height,
          },
          fill: "none", line: { color: theme.colors.accent, width: 3 }, radius: 0,
          constraints: { allowOverlapWith: [table.id] },
        });
        adaptations.push("reconstructed the source's option-comparison matrix with a native emphasized decision column");
      } else {
        table.table.styles.header.fill = theme.colors.accent;
        table.table.styles.header.color = theme.colors.background;
        table.table.styles.body.fill = theme.colors.background;
        adaptations.push("retained the reference matrix hierarchy with an emphasized native header band");
      }
    }
  } else if (model === "statement") {
    const title = slide.shapes.find((shape) => shape.role === "title");
    if (slide.layout === "hero") {
      slide.background = theme.colors.accent;
      for (const text of slide.shapes.filter((shape) => shape.type === "text")) text.style.color = theme.colors.background;
      const callout = slide.shapes.find((shape) => /callout-surface/u.test(shape.id));
      if (callout) {
        callout.geometry = "rect";
        callout.radius = 0;
        callout.fill = theme.colors.text;
        callout.line = { color: theme.colors.background, width: 2 };
      }
      adaptations.push("reconstructed the source's full color-field statement treatment with white native text");
    } else if (titleSurface) {
      titleSurface.geometry = "rect";
      titleSurface.radius = 0;
      titleSurface.fill = theme.colors.accent;
      titleSurface.line = { color: theme.colors.accent, width: 0 };
      if (title) title.style.color = theme.colors.background;
      adaptations.push("translated the source statement into an editable section color band while retaining the sparse hierarchy");
    }
  } else {
    adaptations.push("preserved the reference concept hierarchy without introducing an ungrounded fallback layout");
  }
  const observableShapeIds = [...new Set([
    ...surfaces.map((surface) => surface.id),
    ...slide.shapes.filter((shape) => /^.+-reference-/u.test(shape.id)).map((shape) => shape.id),
    ...slide.shapes.filter((shape) => shape.type === "table").map((shape) => shape.id),
    ...(model === "statement" ? slide.shapes.filter((shape) => shape.role === "title" || /title-surface|callout-surface/u.test(shape.id)).map((shape) => shape.id) : []),
  ])];
  return {
    adaptations,
    adapter: {
      adapterId: support.adapterId,
      supported: support.supported,
      compositionVariant: variant,
      observableShapeIds,
      nativeEditable: observableShapeIds.every((id) => slide.shapes.find((shape) => shape.id === id)?.editable !== false),
    },
  };
}

export function groundPlanWithReference(planInput, profileInput) {
  const plan = stableClone(planInput);
  const profile = validateProfile(profileInput);
  if (!Array.isArray(plan.slides) || !plan.slides.length) fail("compiled plan has no slides.");
  const referenceTokens = deriveReferenceTokens(profile);
  const tokenApplication = applyReferenceTokens(plan, referenceTokens);
  const concepts = profile.designConceptInventory.concepts;
  const usage = new Map();
  const modelUsage = new Map();
  const mappings = [];
  for (const [index, slide] of plan.slides.entries()) {
    const selection = selectConcept(slide, concepts, usage, modelUsage);
    if (!selection.concept) {
      mappings.push({
        generatedSlide: index + 1,
        generatedSlideId: slide.id,
        substantive: slide.coverageRole === "substantive",
        communicationGoal: slideTitle(slide),
        status: "generic-fallback",
        referenceSlides: [],
        selectedConcept: null,
        adaptations: ["No compatible viable reference concept was available."],
        confidence: 0,
      });
      continue;
    }
    const sourceInheritance = (profile.presentation?.inheritanceChains ?? []).find((item) => item.slidePart === selection.concept.slidePart) ?? null;
    const generatedItemCount = slideItemCount(slide);
    const visual = selection.fallback
      ? {
        adaptations: ["The selected source concept was recorded as a fallback because no verified native adapter matched the generated topology."],
        adapter: { adapterId: null, supported: false, compositionVariant: selection.concept.composition?.variant ?? null, observableShapeIds: [], nativeEditable: true },
      }
      : applyConceptVisual(slide, selection.concept, plan.theme);
    const mapping = {
      generatedSlide: index + 1,
      generatedSlideId: slide.id,
      substantive: slide.coverageRole === "substantive",
      communicationGoal: slideTitle(slide),
      status: selection.fallback ? "generic-fallback" : "reference-derived",
      referenceSlides: [selection.concept.sourceSlide],
      conceptId: selection.concept.id,
      selectedConcept: selection.concept.sourceTitle || selection.concept.communicationPurpose,
      compositionModel: selection.concept.composition.model,
      compositionVariant: selection.concept.composition.variant ?? selection.concept.blueprint?.variant ?? null,
      sourceItemCount: selection.concept.composition.itemCount ?? selection.concept.blueprint?.itemCount ?? null,
      generatedItemCount,
      blueprintSourceObjectCount: selection.concept.blueprint?.sourceObjectCount ?? null,
      sourceCommunicationPurpose: selection.concept.communicationPurpose,
      adaptations: visual.adaptations,
      nativeAdapter: visual.adapter,
      sourceInheritance: sourceInheritance ? {
        slidePart: sourceInheritance.slidePart,
        layoutPart: sourceInheritance.layoutPart,
        masterPart: sourceInheritance.masterPart,
        themePart: sourceInheritance.themePart,
      } : null,
      confidence: selection.confidence,
      matchScore: selection.score,
    };
    slide.designProvenance = stableClone(mapping);
    mappings.push(mapping);
  }
  const substantive = mappings.filter((item) => item.substantive);
  const groundedMappings = mappings.filter((item) => item.status === "reference-derived");
  const groundedSubstantive = groundedMappings.filter((item) => item.substantive);
  const fallbackCount = mappings.filter((item) => item.status !== "reference-derived").length;
  const provenance = {
    schemaVersion: SCHEMA_VERSION,
    referenceDeck: profile.source?.fileName ?? null,
    referenceDeckSha256: profile.source.sha256,
    referenceProfileSha256: profile.profileSha256,
    conceptsExtracted: concepts.length,
    viableReferenceSlides: profile.designConceptInventory.viableSlides,
    referenceTokens: stableClone(referenceTokens),
    tokenApplication: stableClone(tokenApplication),
    sourceStructure: stableClone(referenceTokens.structure),
    generatedSlides: mappings.length,
    substantiveGeneratedSlides: substantive.length,
    mappedSubstantiveSlides: groundedSubstantive.length,
    substantiveMappingRate: substantive.length ? Number((groundedSubstantive.length / substantive.length).toFixed(4)) : 1,
    genericFallbackSlides: fallbackCount,
    distinctReferenceConcepts: new Set(groundedMappings.map((item) => item.conceptId).filter(Boolean)).size,
    distinctCompositionModels: [...new Set(groundedMappings.map((item) => item.compositionModel).filter(Boolean))].sort(),
    distinctCompositionVariants: [...new Set(groundedMappings.map((item) => item.compositionVariant).filter(Boolean))].sort(),
    requirements: {
      minimumSubstantiveMappingRate: 0.75,
      maximumGenericFallbackSlides: 2,
      minimumDistinctReferenceConcepts: mappings.length >= 6 ? 6 : 0,
    },
    slides: mappings,
  };
  provenance.valid = provenance.substantiveMappingRate >= provenance.requirements.minimumSubstantiveMappingRate
    && provenance.genericFallbackSlides <= provenance.requirements.maximumGenericFallbackSlides
    && provenance.distinctReferenceConcepts >= provenance.requirements.minimumDistinctReferenceConcepts;
  if (!provenance.valid) {
    const fallbackSlides = mappings.filter((item) => item.status !== "reference-derived").map((item) => item.generatedSlideId).join(",");
    fail(`provenance coverage did not satisfy the reference-grounding contract (mapping=${provenance.substantiveMappingRate}, fallbacks=${provenance.genericFallbackSlides} [${fallbackSlides}], concepts=${provenance.distinctReferenceConcepts}/${provenance.requirements.minimumDistinctReferenceConcepts}).`);
  }
  plan.referenceDesign = {
    schemaVersion: SCHEMA_VERSION,
    profileSha256: profile.profileSha256,
    sourceSha256: profile.source.sha256,
    conceptsExtracted: concepts.length,
    distinctReferenceConcepts: provenance.distinctReferenceConcepts,
    distinctCompositionModels: provenance.distinctCompositionModels,
    distinctCompositionVariants: provenance.distinctCompositionVariants,
    tokens: stableClone(referenceTokens),
    tokenApplication: stableClone(tokenApplication),
    sourceStructure: stableClone(referenceTokens.structure),
  };
  return { plan, provenance };
}

export function validateDesignProvenance(provenance, plan, profileInput) {
  const profile = validateProfile(profileInput);
  const diagnostics = [];
  const expectedTokens = deriveReferenceTokens(profile);
  if (provenance?.schemaVersion !== SCHEMA_VERSION) diagnostics.push("schemaVersion");
  if (provenance?.referenceDeckSha256 !== profile.source.sha256 || provenance?.referenceProfileSha256 !== profile.profileSha256) diagnostics.push("reference-binding");
  if (JSON.stringify(provenance?.referenceTokens) !== JSON.stringify(expectedTokens)) diagnostics.push("reference-token-binding");
  if (JSON.stringify(provenance?.sourceStructure) !== JSON.stringify(expectedTokens.structure)) diagnostics.push("source-structure-binding");
  if (expectedTokens.available) {
    const expectedColors = Object.fromEntries(Object.entries(expectedTokens.colors).map(([key, item]) => [key, item.value]));
    if (JSON.stringify(plan.theme?.colors) !== JSON.stringify(expectedColors)) diagnostics.push("applied-color-tokens");
    if (plan.theme?.fontFamily !== expectedTokens.fonts.minor.value || plan.theme?.fallbackFontFamily !== null) diagnostics.push("applied-font-token");
    if (provenance?.tokenApplication?.fontApplication?.silentSubstitutionAllowed !== false) diagnostics.push("font-substitution-policy");
  }
  if (provenance?.generatedSlides !== plan.slides?.length || provenance?.slides?.length !== plan.slides?.length) diagnostics.push("slide-count");
  for (const [index, mapping] of (provenance?.slides ?? []).entries()) {
    const slide = plan.slides?.[index];
    if (mapping.generatedSlide !== index + 1 || mapping.generatedSlideId !== slide?.id) diagnostics.push(`slide-${index + 1}-identity`);
    if (mapping.substantive !== (slide?.coverageRole === "substantive")) diagnostics.push(`slide-${index + 1}-substantive-binding`);
    if (mapping.status === "reference-derived" && !profile.designConceptInventory.concepts.some((concept) => concept.id === mapping.conceptId && concept.sourceSlide === mapping.referenceSlides?.[0])) diagnostics.push(`slide-${index + 1}-concept`);
    if (mapping.status === "reference-derived") {
      const concept = profile.designConceptInventory.concepts.find((candidate) => candidate.id === mapping.conceptId);
      const support = concept && slide ? adapterSupport(slide, concept) : { supported: false, adapterId: null };
      if (mapping.sourceItemCount !== concept?.composition?.itemCount || mapping.generatedItemCount !== slideItemCount(slide)) diagnostics.push(`slide-${index + 1}-item-topology`);
      if (!support.supported || mapping.nativeAdapter?.supported !== true || mapping.nativeAdapter?.adapterId !== support.adapterId) diagnostics.push(`slide-${index + 1}-native-adapter`);
      if (mapping.nativeAdapter?.compositionVariant !== mapping.compositionVariant) diagnostics.push(`slide-${index + 1}-adapter-variant`);
      if (!mapping.nativeAdapter?.observableShapeIds?.length || mapping.nativeAdapter.observableShapeIds.some((id) => !slide?.shapes?.some((shape) => shape.id === id && shape.editable !== false))) diagnostics.push(`slide-${index + 1}-adapter-evidence`);
      const expectedInheritance = (profile.presentation?.inheritanceChains ?? []).find((item) => item.slidePart === concept?.slidePart) ?? null;
      const normalizedInheritance = expectedInheritance ? { slidePart: expectedInheritance.slidePart, layoutPart: expectedInheritance.layoutPart, masterPart: expectedInheritance.masterPart, themePart: expectedInheritance.themePart } : null;
      if (JSON.stringify(mapping.sourceInheritance) !== JSON.stringify(normalizedInheritance)) diagnostics.push(`slide-${index + 1}-inheritance`);
    }
    if (slide?.designProvenance?.conceptId !== mapping.conceptId) diagnostics.push(`slide-${index + 1}-plan-binding`);
  }
  const mappings = provenance?.slides ?? [];
  const substantive = mappings.filter((item) => item.substantive);
  const groundedMappings = mappings.filter((item) => item.status === "reference-derived");
  const groundedSubstantive = groundedMappings.filter((item) => item.substantive);
  const recomputed = {
    generatedSlides: mappings.length,
    substantiveGeneratedSlides: substantive.length,
    mappedSubstantiveSlides: groundedSubstantive.length,
    substantiveMappingRate: substantive.length ? Number((groundedSubstantive.length / substantive.length).toFixed(4)) : 1,
    genericFallbackSlides: mappings.filter((item) => item.status !== "reference-derived").length,
    distinctReferenceConcepts: new Set(groundedMappings.map((item) => item.conceptId).filter(Boolean)).size,
    distinctCompositionModels: [...new Set(groundedMappings.map((item) => item.compositionModel).filter(Boolean))].sort(),
    distinctCompositionVariants: [...new Set(groundedMappings.map((item) => item.compositionVariant).filter(Boolean))].sort(),
  };
  for (const [key, value] of Object.entries(recomputed)) if (JSON.stringify(provenance?.[key]) !== JSON.stringify(value)) diagnostics.push(`aggregate-${key}`);
  const recomputedValid = recomputed.substantiveMappingRate >= Number(provenance?.requirements?.minimumSubstantiveMappingRate)
    && recomputed.genericFallbackSlides <= Number(provenance?.requirements?.maximumGenericFallbackSlides)
    && recomputed.distinctReferenceConcepts >= Number(provenance?.requirements?.minimumDistinctReferenceConcepts);
  if (provenance?.valid !== recomputedValid) diagnostics.push("aggregate-valid");
  if (provenance?.substantiveMappingRate < 0.75) diagnostics.push("mapping-rate");
  if (provenance?.genericFallbackSlides > 2) diagnostics.push("fallback-count");
  if (provenance?.distinctReferenceConcepts < ((plan.slides?.length ?? 0) >= 6 ? 6 : 0)) diagnostics.push("concept-diversity");
  return { schemaVersion: "slidewright-design-provenance-validation/v1", valid: diagnostics.length === 0, diagnostics };
}

export { SCHEMA_VERSION as DESIGN_PROVENANCE_SCHEMA_VERSION };
