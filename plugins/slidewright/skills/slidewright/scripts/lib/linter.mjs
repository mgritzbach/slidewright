import { measureText, textFromRuns } from "./typography.mjs";
import { fitSurfaceExpectation, headlineSafeInterval, positiveIntersection, shapeRect } from "./layout-contract.mjs";
import {
  DEFAULT_ARCHETYPES,
  DEFAULT_ICON_ONTOLOGY,
  DEFAULT_INSET_TOKENS_PX,
  DEFAULT_MAX_INSET_PX,
  DEFAULT_PARAGRAPH_SPACING_PT,
  DEFAULT_TYPOGRAPHY_ROLES,
} from "./tokens.mjs";

export const QUALITY_THRESHOLDS = Object.freeze({
  geometryTolerancePx: 1,
  normalTextContrast: 4.5,
  largeTextContrast: 3,
  maximumOccupancyRatio: 0.94,
  maximumTopLevelObjects: 12,
  minimumPeerGapPx: 12,
  minimumChartFramePx: Object.freeze([240, 160]),
  minimumChartLabelPt: 12,
  minimumChartMarkThicknessPx: 8,
  maximumChartCategories: 12,
  maximumChartSeries: 6,
});

function diagnostic(ruleId, severity, slideId, objectId, message, suggestion) {
  return { ruleId, severity, slideId, objectId, message, suggestion };
}

function nearlyEqual(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

function rect(shape) {
  const { left, top, width, height } = shape.position;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function contains(outer, inner, tolerance = 0) {
  return outer.left <= inner.left + tolerance
    && outer.top <= inner.top + tolerance
    && outer.right >= inner.right - tolerance
    && outer.bottom >= inner.bottom - tolerance;
}

function overlapArea(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function unionArea(rectangles) {
  const xs = [...new Set(rectangles.flatMap((item) => [item.left, item.right]))].sort((a, b) => a - b);
  let area = 0;
  for (let index = 0; index < xs.length - 1; index += 1) {
    const left = xs[index];
    const right = xs[index + 1];
    if (right <= left) continue;
    const intervals = rectangles
      .filter((item) => item.left < right && item.right > left)
      .map((item) => [item.top, item.bottom])
      .sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let start = null;
    let end = null;
    for (const [nextStart, nextEnd] of intervals) {
      if (start == null) {
        start = nextStart;
        end = nextEnd;
      } else if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        covered += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    if (start != null) covered += end - start;
    area += (right - left) * covered;
  }
  return area;
}

function parseHexColor(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((item) => `${item}${item}`).join("") : match[1];
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function relativeLuminance(color) {
  const rgb = parseHexColor(color);
  if (!rgb) return null;
  const channels = rgb.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  if (a == null || b == null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function fillColor(shape) {
  return typeof shape.fill === "string" ? shape.fill : shape.fill?.color;
}

function boldProfile(shape) {
  const runs = (shape.text?.runs ?? []).filter((run) => run.text?.trim());
  if (!runs.length) return "empty";
  if (runs.every((run) => run.bold === true)) return "bold";
  if (runs.every((run) => run.bold !== true)) return "regular";
  return "mixed";
}

function styleSignature(shape) {
  return JSON.stringify({
    typographyRole: shape.typographyRole,
    typeface: shape.style?.typeface,
    color: shape.style?.color,
    fontSizePt: shape.style?.fontSizePt,
    lineHeight: shape.style?.lineHeight,
    alignment: shape.style?.alignment,
    verticalAlignment: shape.style?.verticalAlignment,
    insets: shape.style?.insets,
    weight: boldProfile(shape),
    paragraphSpacing: (shape.text?.paragraphs ?? []).map((paragraph) => [paragraph.spaceBeforePt ?? 0, paragraph.spaceAfterPt ?? 0]),
  });
}

function insetRecords(shape) {
  const records = [];
  if (shape.padding) records.push({ label: "component padding", value: shape.padding });
  if (shape.type === "text" && shape.style?.insets) records.push({ label: "text inset", value: shape.style.insets });
  for (const [styleName, style] of Object.entries(shape.table?.styles ?? {})) {
    if (style.insets) records.push({ label: `table ${styleName} cell inset`, value: style.insets });
  }
  for (const [index, cell] of (shape.table?.cells ?? []).entries()) {
    if (cell.insets) records.push({ label: `table cell ${index + 1} inset`, value: cell.insets });
  }
  return records;
}

function validateDesignSystem(plan, diagnostics, tolerance) {
  const design = plan.designSystem;
  if (!design || design.schemaVersion !== "slidewright-design-system/v1") {
    diagnostics.push(diagnostic("SW029", "error", null, null, "Deck has no valid versioned design system.", "Resolve a logical master, page archetypes, typography roles, and spacing tokens before compiling slides."));
    return;
  }
  const globalReasons = [];
  if (!design.id || design.logicalMaster?.kind !== "generated-logical-master" || design.logicalMaster?.nativePowerPointMasterClaimed !== false) globalReasons.push("logical master identity is invalid or overclaims a native PowerPoint master");
  if (JSON.stringify(design.logicalMaster?.canvas) !== JSON.stringify(plan.canvas) || design.logicalMaster?.fontFamily !== plan.theme?.fontFamily) globalReasons.push("logical master canvas or font binding differs from the compiled deck");
  if (JSON.stringify(design.insetTokensPx) !== JSON.stringify(DEFAULT_INSET_TOKENS_PX) || design.maximumInsetPx !== DEFAULT_MAX_INSET_PX) globalReasons.push("generated-deck inset token scale differs from the immutable 0/8/12/16/24/32px contract");
  if (JSON.stringify(design.paragraphSpacingPt) !== JSON.stringify(DEFAULT_PARAGRAPH_SPACING_PT)) globalReasons.push("generated-deck paragraph spacing differs from the immutable 0/6/12pt contract");
  if (!design.typographyRoles || !design.archetypes) globalReasons.push("typography roles or archetypes are missing");
  if (JSON.stringify(Object.keys(design.typographyRoles ?? {}).sort()) !== JSON.stringify(Object.keys(DEFAULT_TYPOGRAPHY_ROLES).sort())) globalReasons.push("generated decks cannot inject custom typography roles");
  if (JSON.stringify(Object.keys(design.archetypes ?? {}).sort()) !== JSON.stringify(Object.keys(DEFAULT_ARCHETYPES).sort())) globalReasons.push("generated decks cannot inject custom page archetypes");
  if (JSON.stringify(Object.keys(design.iconOntology ?? {}).sort()) !== JSON.stringify(Object.keys(DEFAULT_ICON_ONTOLOGY).sort())) globalReasons.push("generated decks cannot inject custom icon concepts");
  for (const [roleId, required] of Object.entries(DEFAULT_TYPOGRAPHY_ROLES)) {
    if (JSON.stringify(design.typographyRoles?.[roleId]) !== JSON.stringify(required)) globalReasons.push(`built-in typography role '${roleId}' differs from its immutable contract`);
  }
  for (const [archetypeId, required] of Object.entries(DEFAULT_ARCHETYPES)) {
    if (JSON.stringify(design.archetypes?.[archetypeId]) !== JSON.stringify(required)) globalReasons.push(`built-in archetype '${archetypeId}' differs from its immutable contract`);
  }
  for (const [conceptId, required] of Object.entries(DEFAULT_ICON_ONTOLOGY)) {
    if (JSON.stringify(design.iconOntology?.[conceptId]) !== JSON.stringify(required)) globalReasons.push(`built-in icon concept '${conceptId}' differs from its immutable ontology`);
  }
  if (globalReasons.length) diagnostics.push(diagnostic("SW029", "error", null, null, `Deck design system failed: ${globalReasons.join("; ")}.`, "Repair the versioned logical-master contract before building any slide."));

  for (const slide of plan.slides ?? []) {
    const archetype = design.archetypes?.[slide.archetypeId];
    const reasons = [];
    if (!archetype) reasons.push(`unknown archetype '${slide.archetypeId}'`);
    if (slide.archetypeId !== slide.layout) reasons.push("slide layout cannot be rebound to another archetype");
    if (slide.designMasterId !== design.logicalMaster?.id) reasons.push("slide design-master binding drifted");
    if (archetype && slide.pageRole !== archetype.pageRole) reasons.push("slide page role differs from its archetype");
    if (Array.isArray(slide.typedExceptions) && slide.typedExceptions.length) reasons.push("unresolved typed exceptions remain; model them as a declared archetype or role variant");
    const semanticIcons = (slide.shapes ?? []).filter((shape) => shape.role === "icon" || shape.semanticType === "icon");
    if (archetype?.requiresSemanticIcons && semanticIcons.length < Number(archetype.minimumSemanticIcons ?? 1)) reasons.push(`semantic icon count is below ${archetype.minimumSemanticIcons ?? 1}`);
    const styleRoles = new Set((slide.shapes ?? []).flatMap((shape) => [
      ...(shape.type === "text" ? [shape.typographyRole] : []),
      ...Object.values(shape.table?.styles ?? {}).map((style) => style.typographyRole),
    ]).filter(Boolean));
    for (const required of archetype?.requiredStyleRoles ?? []) if (!styleRoles.has(required)) reasons.push(`required typography role '${required}' is missing`);
    if (reasons.length) diagnostics.push(diagnostic("SW029", "error", slide.id, null, `Archetype/master contract failed: ${reasons.join("; ")}.`, "Bind the slide to one declared page archetype and resolve every required role without generic rule waivers."));

    for (const shape of (slide.shapes ?? []).filter((candidate) => candidate.type === "text")) {
      const role = DEFAULT_TYPOGRAPHY_ROLES[shape.typographyRole] ?? design.typographyRoles?.[shape.typographyRole];
      const roleReasons = [];
      if (!role) roleReasons.push(`unknown typography role '${shape.typographyRole}'`);
      else {
        if (shape.fit?.preferredSizePt !== role.preferredSizePt) roleReasons.push(`preferred size must be ${role.preferredSizePt}pt`);
        if (shape.fit?.minSizePt !== role.minimumSizePt) roleReasons.push(`minimum size must be ${role.minimumSizePt}pt`);
        if (shape.fit?.maxLines > role.maximumLines) roleReasons.push(`line budget exceeds ${role.maximumLines}`);
        if (!nearlyEqual(shape.style?.lineHeight, role.lineHeight, tolerance / 100)) roleReasons.push(`line height must be ${role.lineHeight}`);
        if (shape.style?.typeface !== design.logicalMaster?.fontFamily) roleReasons.push(`typeface must use logical-master family '${design.logicalMaster?.fontFamily}'`);
        const weight = boldProfile(shape);
        if (role.baseWeight === "bold" && weight !== "bold") roleReasons.push("base weight must be bold");
        if (role.baseWeight === "regular" && weight !== "regular") roleReasons.push("base weight must be regular");
        if (role.baseWeight === "regular-with-emphasis" && weight === "bold") roleReasons.push("body copy cannot become uniformly bold");
      }
      if (["title", "subheading"].includes(shape.role) && !shape.headlinePolicy) roleReasons.push("constrained headline policy is missing");
      if (roleReasons.length) diagnostics.push(diagnostic("SW029", "error", slide.id, shape.id, `Typography-role contract failed: ${roleReasons.join("; ")}.`, "Use the declared deck-wide role token or create a narrow named role variant."));
    }
    for (const shape of (slide.shapes ?? []).filter((candidate) => candidate.type === "table")) {
      for (const [styleName, style] of Object.entries(shape.table?.styles ?? {})) {
        const role = DEFAULT_TYPOGRAPHY_ROLES[style.typographyRole] ?? design.typographyRoles?.[style.typographyRole];
        const roleReasons = [];
        if (!role) roleReasons.push(`unknown typography role '${style.typographyRole}'`);
        else {
          if (style.fontSizePt !== role.preferredSizePt) roleReasons.push(`font size must be ${role.preferredSizePt}pt`);
          if (style.typeface !== design.logicalMaster?.fontFamily) roleReasons.push(`typeface must use logical-master family '${design.logicalMaster?.fontFamily}'`);
          if (!nearlyEqual(style.lineHeight, role.lineHeight, tolerance / 100)) roleReasons.push(`line height must be ${role.lineHeight}`);
          if (style.maximumLines !== role.maximumLines) roleReasons.push(`line budget must be ${role.maximumLines}`);
          if (role.baseWeight === "bold" && style.bold !== true) roleReasons.push("base weight must be bold");
          if (role.baseWeight === "regular-with-emphasis" && style.bold === true) roleReasons.push("body cells cannot become uniformly bold");
        }
        if (roleReasons.length) diagnostics.push(diagnostic("SW029", "error", slide.id, shape.id, `Table ${styleName} role contract failed: ${roleReasons.join("; ")}.`, "Use the declared table typography token rather than one-off cell formatting."));
      }
    }
  }
}

function lintComponentFamilies(plan, diagnostics) {
  const groups = new Map();
  for (const slide of plan.slides ?? []) {
    const requiredFamilies = (DEFAULT_ARCHETYPES[slide.archetypeId] ?? plan.designSystem?.archetypes?.[slide.archetypeId])?.componentFamilies ?? {};
    for (const [familyId, contract] of Object.entries(requiredFamilies)) {
      const members = (slide.shapes ?? []).filter((shape) => shape.componentPattern?.familyId === familyId);
      const instances = new Map();
      for (const member of members) {
        const instanceId = member.componentPattern?.instanceId;
        if (!instances.has(instanceId)) instances.set(instanceId, []);
        instances.get(instanceId).push(member);
      }
      const reasons = [];
      if (instances.size < Number(contract.minimumInstances ?? 1)) reasons.push(`requires at least ${contract.minimumInstances ?? 1} instances, found ${instances.size}`);
      for (const [instanceId, instanceMembers] of instances) {
        const slots = instanceMembers.map((member) => member.componentPattern?.slot);
        for (const requiredSlot of contract.requiredSlots ?? []) if (slots.filter((slot) => slot === requiredSlot).length !== 1) reasons.push(`instance '${instanceId}' requires exactly one '${requiredSlot}' slot`);
        for (const member of instanceMembers) if (!(contract.allowedVariants ?? []).includes(member.componentPattern?.variantId)) reasons.push(`instance '${instanceId}' uses undeclared variant '${member.componentPattern?.variantId}'`);
      }
      if (reasons.length) diagnostics.push(diagnostic(
        "SW025", "error", slide.id, null,
        `Required repeated component family '${familyId}' is incomplete: ${reasons.join("; ")}.`,
        "Restore every archetype-required instance and slot; removing component metadata cannot waive deck-wide consistency.",
      ));
    }
    for (const shape of slide.shapes ?? []) {
      const pattern = shape.componentPattern;
      if (!pattern) continue;
      if (![pattern.familyId, pattern.instanceId, pattern.slot, pattern.variantId].every((value) => typeof value === "string" && value.length)) {
        diagnostics.push(diagnostic("SW025", "error", slide.id, shape.id, "Repeated component has an incomplete family/instance/slot/variant binding.", "Bind every repeated component slot to a stable family and declared variant."));
        continue;
      }
      const key = [slide.designMasterId, slide.archetypeId, pattern.familyId, pattern.slot, pattern.variantId].join("|");
      const signature = styleSignature(shape);
      const baseline = groups.get(key);
      if (!baseline) groups.set(key, { signature, slideId: slide.id, objectId: shape.id });
      else if (baseline.signature !== signature) diagnostics.push(diagnostic(
        "SW025", "error", slide.id, shape.id,
        `Repeated '${pattern.familyId}' ${pattern.slot} formatting differs from '${baseline.objectId}' on slide '${baseline.slideId}'.`,
        "Use the same named style token for every equivalent component slot; shorten or relayout copy instead of changing one instance.",
      ));
    }
  }
}

function effectiveTextBackground(slide, shapes, textIndex, tolerance) {
  const textRect = rect(shapes[textIndex]);
  const containers = shapes
    .slice(0, textIndex)
    .filter((candidate) => candidate.type === "shape" && parseHexColor(fillColor(candidate)) && contains(rect(candidate), textRect, tolerance))
    .sort((a, b) => (a.position.width * a.position.height) - (b.position.width * b.position.height));
  return containers.length ? fillColor(containers[0]) : slide.background;
}

function alignmentValue(position, edge) {
  if (edge === "left" || edge === "top") return position[edge];
  if (edge === "right") return position.left + position.width;
  if (edge === "bottom") return position.top + position.height;
  if (edge === "centerX") return position.left + position.width / 2;
  if (edge === "centerY") return position.top + position.height / 2;
  return Number.NaN;
}

function chartReadabilityFailures(shape, shapes, tolerance) {
  const chart = shape.chart ?? {};
  const failures = [];
  const labels = shapes.filter((candidate) => candidate.parentId === shape.id && candidate.role === "chart-label");
  const marks = shapes.filter((candidate) => candidate.parentId === shape.id && candidate.role === "chart-mark");
  const [minimumWidth, minimumHeight] = QUALITY_THRESHOLDS.minimumChartFramePx;
  if (shape.position.width < minimumWidth || shape.position.height < minimumHeight) failures.push(`plot area is smaller than ${minimumWidth}×${minimumHeight} px`);
  if (!labels.length || labels.some((label) => !Number.isInteger(label.style?.fontSizePt) || label.style.fontSizePt < QUALITY_THRESHOLDS.minimumChartLabelPt)) failures.push(`labels must use an integer size of at least ${QUALITY_THRESHOLDS.minimumChartLabelPt}pt`);
  if (!marks.length || labels.length !== marks.length || marks.length > QUALITY_THRESHOLDS.maximumChartCategories) failures.push(`derived category count must be between 1 and ${QUALITY_THRESHOLDS.maximumChartCategories} with one label per mark`);
  const seriesCount = new Set(marks.map((mark) => mark.chartSeriesId ?? "series-1")).size;
  if (!marks.length || seriesCount > QUALITY_THRESHOLDS.maximumChartSeries) failures.push(`derived series count must be between 1 and ${QUALITY_THRESHOLDS.maximumChartSeries}`);
  if (!["horizontal", "vertical"].includes(chart.orientation)) failures.push("orientation must be horizontal or vertical");
  const minimumThickness = marks.length ? Math.min(...marks.map((mark) => chart.orientation === "horizontal" ? mark.position.height : mark.position.width)) : 0;
  if (minimumThickness < QUALITY_THRESHOLDS.minimumChartMarkThicknessPx) failures.push(`derived mark thickness must be at least ${QUALITY_THRESHOLDS.minimumChartMarkThicknessPx} px`);
  const wrongDirection = marks.some((mark) => chart.orientation === "horizontal" ? mark.position.width < mark.position.height : mark.position.height < mark.position.width);
  if (wrongDirection) failures.push("mark geometry does not match the declared orientation");
  let labelCollision = false;
  for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
      if (overlapArea(rect(labels[leftIndex]), rect(labels[rightIndex])) > tolerance * tolerance) labelCollision = true;
    }
  }
  if (labelCollision) failures.push("derived label geometry collides");
  if (labels.some((label) => !contains(rect(shape), rect(label), tolerance))) failures.push("derived labels escape chart bounds");
  const background = fillColor(shape);
  if (labels.some((label) => {
    const ratio = contrastRatio(label.style?.color, background);
    return ratio == null || ratio < QUALITY_THRESHOLDS.normalTextContrast;
  })) failures.push(`derived label contrast must be at least ${QUALITY_THRESHOLDS.normalTextContrast}:1`);
  if (marks.some((mark) => {
    const ratio = contrastRatio(fillColor(mark), background);
    return ratio == null || ratio < QUALITY_THRESHOLDS.largeTextContrast;
  })) failures.push(`derived mark contrast must be at least ${QUALITY_THRESHOLDS.largeTextContrast}:1`);
  return failures;
}

export function lintPlan(plan) {
  const diagnostics = [];
  const tolerance = plan.layout?.geometryTolerance ?? QUALITY_THRESHOLDS.geometryTolerancePx;
  const approved = new Set(plan.layout?.approvedFontSizesPt ?? []);

  validateDesignSystem(plan, diagnostics, tolerance);
  lintComponentFamilies(plan, diagnostics);

  if (plan.coverage) {
    const topics = plan.coverage.topics ?? [];
    const topicIds = topics.map((topic) => topic.id);
    const reasons = [];
    if (!topics.length) reasons.push("coverage manifest has no topics");
    if (new Set(topicIds).size !== topicIds.length) reasons.push("coverage manifest contains duplicate topic ids");
    const slides = plan.slides ?? [];
    for (const slide of slides) if (!topicIds.includes(slide.topicId) || !["divider", "substantive"].includes(slide.coverageRole)) reasons.push(`slide '${slide.id}' has invalid topic ownership or role`);
    let previousDivider = -1;
    for (const topic of topics) {
      const owned = slides.map((slide, index) => ({ slide, index })).filter((item) => item.slide.topicId === topic.id);
      const dividers = owned.filter((item) => item.slide.coverageRole === "divider");
      const substantive = owned.filter((item) => item.slide.coverageRole === "substantive");
      if (dividers.length !== 1) reasons.push(`topic '${topic.id}' requires exactly one divider, found ${dividers.length}`);
      if (!substantive.length) reasons.push(`topic '${topic.id}' requires at least one substantive slide`);
      if (dividers.length === 1 && substantive.some((item) => item.index < dividers[0].index)) reasons.push(`topic '${topic.id}' has substantive content before its divider`);
      if (dividers.length === 1 && dividers[0].index <= previousDivider) reasons.push(`topic '${topic.id}' is out of manifest order`);
      if (dividers.length === 1) previousDivider = dividers[0].index;
    }
    if (reasons.length) diagnostics.push(diagnostic(
      "SW021", "error", null, null,
      `Topic coverage failed: ${[...new Set(reasons)].join("; ")}.`,
      "Give every declared topic one ordered divider and at least one uniquely owned substantive slide.",
    ));
  }

  for (const slide of plan.slides ?? []) {
    const shapes = slide.shapes ?? [];
    const byId = new Map(shapes.map((shape) => [shape.id, shape]));
    const insetTokens = new Set(plan.designSystem?.insetTokensPx ?? []);
    const maximumInset = Number(plan.designSystem?.maximumInsetPx);
    const paragraphSpacing = new Set(plan.designSystem?.paragraphSpacingPt ?? []);

    for (const shape of shapes) {
      for (const record of insetRecords(shape)) {
        const keys = ["top", "right", "bottom", "left"];
        const values = keys.map((key) => Number(record.value?.[key]));
        const valid = values.every((value) => Number.isFinite(value) && value >= 0 && value <= maximumInset && insetTokens.has(value));
        const symmetric = values.every((value) => nearlyEqual(value, values[0], tolerance));
        if (!valid || !symmetric) diagnostics.push(diagnostic(
          "SW023", "error", slide.id, shape.id,
          `${record.label} must use one uniform bounded token on all four sides; received ${JSON.stringify(record.value)}.`,
          "Use a declared compact/default inset token on every side, or model a narrow source-template role variant with evidence.",
        ));
      }
    }

    const backingContracts = slide.layoutContract?.backings ?? [];
    const backingCompletenessReasons = [];
    const requiredBackedRoles = (DEFAULT_ARCHETYPES[slide.archetypeId] ?? plan.designSystem?.archetypes?.[slide.archetypeId])?.requiredBackedRoles ?? {};
    // parentId is also used for semantic ownership (for example chart labels).
    // A text object participates in the backing contract only when it declares
    // a backing, is named by a backing contract, or occupies a role that the
    // archetype itself requires to be backed. This still detects deleted
    // metadata without misclassifying chart ownership as card containment.
    const backedTexts = shapes.filter((shape) => shape.type === "text" && (
      shape.backingId
      || backingContracts.some((contract) => (contract.contentIds ?? []).includes(shape.id))
      || Object.hasOwn(requiredBackedRoles, shape.role)
    ));
    const contractFor = (shape) => backingContracts.find((contract) => contract.backingId === shape.backingId && (contract.contentIds ?? []).includes(shape.id));
    for (const shape of backedTexts) if (!shape.parentId || shape.parentId !== shape.backingId || !contractFor(shape)) backingCompletenessReasons.push(`'${shape.id}' has incomplete parent/backing/contract linkage`);
    for (const [role, minimum] of Object.entries(requiredBackedRoles)) {
      const count = backedTexts.filter((shape) => shape.role === role && shape.parentId === shape.backingId && contractFor(shape)).length;
      if (count < Number(minimum)) backingCompletenessReasons.push(`role '${role}' requires ${minimum} backed object(s), found ${count}`);
    }
    if (backingCompletenessReasons.length) diagnostics.push(diagnostic(
      "SW024", "error", slide.id, null,
      `Backing-contract coverage is incomplete: ${backingCompletenessReasons.join("; ")}.`,
      "Restore every compiler-declared text/backing relationship; deleting containment metadata cannot waive zero-spill behavior.",
    ));

    for (const contract of backingContracts) {
      const backing = byId.get(contract.backingId);
      const padding = backing?.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
      const outer = backing ? rect(backing) : null;
      const inner = outer ? {
        left: outer.left + Number(padding.left ?? 0), top: outer.top + Number(padding.top ?? 0),
        right: outer.right - Number(padding.right ?? 0), bottom: outer.bottom - Number(padding.bottom ?? 0),
      } : null;
      for (const contentId of contract.contentIds ?? []) {
        const content = byId.get(contentId);
        if (!backing || !content || content.backingId !== backing.id || !contains(inner, rect(content), 1e-6)) diagnostics.push(diagnostic(
          "SW024", "error", slide.id, contentId ?? contract.backingId,
          `Text content '${contentId}' is not fully contained by backing '${contract.backingId}' and its padding.`,
          "Grow the backing, shorten the text, or select another archetype; visible text may never spill beyond its covering block.",
        ));
      }
    }
    const safeHeadline = headlineSafeInterval(slide, byId);
    if (safeHeadline) {
      const headline = byId.get(slide.layoutContract?.headline?.shapeId);
      const position = headline?.position;
      const actualRight = position ? position.left + position.width : Number.NaN;
      if (safeHeadline.error || !position || !nearlyEqual(position.left, safeHeadline.left, 1e-6) || !nearlyEqual(actualRight, safeHeadline.right, 1e-6)) diagnostics.push(
        diagnostic(
          "SW019", "error", slide.id, slide.layoutContract?.headline?.shapeId ?? null,
          safeHeadline.error ?? `Headline does not use its full ${safeHeadline.split} safe interval [${safeHeadline.left}, ${safeHeadline.right}].`,
          "Extend the headline to both safe edges unless an active center or two-thirds structural split reserves the adjacent region.",
        ),
      );
    }
    for (const contract of slide.layoutContract?.fitSurfaces ?? []) {
      const expectation = fitSurfaceExpectation(byId, contract);
      if (expectation.error || !nearlyEqual(expectation.actualBottom, expectation.expectedBottom, 1e-6)) diagnostics.push(
        diagnostic(
          "SW020", "error", slide.id, contract.surfaceId,
          expectation.error ?? `Text backing ends at ${expectation.actualBottom}px but content and symmetric padding require ${expectation.expectedBottom}px.`,
          "Grow the backing region with its text and preserve symmetric padding before positioning downstream content.",
        ),
      );
    }
    const outer = {
      left: slide.frame.left,
      top: slide.frame.top,
      right: plan.canvas.width - slide.frame.left - slide.frame.width,
      bottom: plan.canvas.height - slide.frame.top - slide.frame.height,
    };
    if (!nearlyEqual(outer.left, outer.right, tolerance) || !nearlyEqual(outer.top, outer.bottom, tolerance)) {
      diagnostics.push(
        diagnostic(
          "SW006",
          "error",
          slide.id,
          null,
          `Outer margins are asymmetric: ${JSON.stringify(outer)}.`,
          "Use equal left/right and top/bottom margins or declare an intentional exception.",
        ),
      );
    }

    for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
      const shape = shapes[shapeIndex];
      const p = shape.position;
      if (p.left < 0 || p.top < 0 || p.left + p.width > plan.canvas.width || p.top + p.height > plan.canvas.height) {
        diagnostics.push(
          diagnostic("SW001", "error", slide.id, shape.id, "Object extends outside the slide canvas.", "Move or resize the object inside the canvas."),
        );
      }
      if (shape.editable !== true) {
        diagnostics.push(
          diagnostic("SW005", "error", slide.id, shape.id, "Object is not marked editable.", "Render semantic content as a native PowerPoint object."),
        );
      }
      if (shape.padding) {
        const values = Object.values(shape.padding);
        if (!values.every((value) => nearlyEqual(value, values[0], tolerance))) {
          diagnostics.push(
            diagnostic("SW007", "error", slide.id, shape.id, `Component padding is asymmetric: ${JSON.stringify(shape.padding)}.`, "Use uniform padding or declare an intentional exception."),
          );
        }
      }
      if (shape.parentId) {
        const parent = byId.get(shape.parentId);
        const padding = parent?.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
        const parentRect = parent ? rect(parent) : null;
        const inner = parentRect ? {
          left: parentRect.left + padding.left,
          top: parentRect.top + padding.top,
          right: parentRect.right - padding.right,
          bottom: parentRect.bottom - padding.bottom,
        } : null;
        if (!inner || !contains(inner, rect(shape), tolerance)) diagnostics.push(
          diagnostic("SW016", "error", slide.id, shape.id, `Child object is clipped by or escapes parent '${shape.parentId}'.`, "Keep the child inside the parent's padded inner bounds or correct the parent relationship."),
        );
      }
      const alignments = Array.isArray(shape.constraints?.alignTo)
        ? shape.constraints.alignTo
        : shape.constraints?.alignTo ? [shape.constraints.alignTo] : [];
      for (const alignment of alignments) {
        const target = byId.get(alignment.targetId);
        const edge = alignment.edge;
        const alignmentTolerance = alignment.tolerance ?? tolerance;
        const actual = alignmentValue(shape.position, edge);
        const expected = target ? alignmentValue(target.position, alignment.targetEdge ?? edge) + (alignment.offset ?? 0) : Number.NaN;
        if (!target || !Number.isFinite(actual) || !Number.isFinite(expected) || !nearlyEqual(actual, expected, alignmentTolerance)) {
          diagnostics.push(
            diagnostic("SW012", "error", slide.id, shape.id, `Alignment constraint failed for ${edge} against '${alignment.targetId}'.`, "Align the declared edges/centers or update the explicit alignment constraint."),
          );
        }
      }
      if (shape.semanticType === "chart-component") {
        const failures = chartReadabilityFailures(shape, shapes, tolerance);
        if (failures.length) diagnostics.push(
          diagnostic("SW015", "error", slide.id, shape.id, `Chart readability failed: ${failures.join("; ")}.`, "Increase plot/label size, reduce series or categories, thicken marks, and restore label contrast."),
        );
      }
      if (shape.type === "table") {
        const values = shape.table?.values;
        const columnCount = values?.[0]?.length ?? 0;
        const validGrid = Array.isArray(values) && values.length >= 2 && columnCount >= 2
          && values.every((row) => Array.isArray(row) && row.length === columnCount && row.every((cell) => typeof cell === "string" && cell.trim()));
        const styles = shape.table?.styles ?? {};
        const validStyles = [styles.header, styles.body].every((style) => style && Number.isInteger(style.fontSizePt) && approved.has(style.fontSizePt));
        if (!validGrid || !validStyles) diagnostics.push(diagnostic(
          "SW029", "error", slide.id, shape.id,
          "Native table has an invalid cell grid or undeclared header/body typography.",
          "Use a rectangular non-empty grid and the declared table-header/table-body roles.",
        ));
        if (validGrid && validStyles) {
          const columnWidths = shape.table.columnWidths ?? values[0].map(() => shape.position.width / columnCount);
          const rowHeight = shape.position.height / values.length;
          values.forEach((row, rowIndex) => row.forEach((cell, columnIndex) => {
            const style = rowIndex < Number(shape.table.headerRows ?? 1) ? styles.header : styles.body;
            const fit = measureText({
              text: cell,
              width: Number(columnWidths[columnIndex]),
              height: rowHeight,
              fontSizePt: style.fontSizePt,
              lineHeight: style.lineHeight,
              insets: style.insets,
              maxLines: style.maximumLines,
            });
            if (!fit.fits) diagnostics.push(diagnostic(
              "SW004", "error", slide.id, shape.id,
              `Table cell r${rowIndex + 1}c${columnIndex + 1} does not fit at ${style.fontSizePt}pt within its native cell (${fit.lines} lines, ${fit.estimatedHeight}px high).`,
              "Shorten the cell copy, widen the column, reduce rows, or choose another archetype before rendering; never rely on native table overflow.",
            ));
          }));
        }
        continue;
      }
      if (shape.type !== "text") continue;

      const paragraphs = shape.text?.paragraphs ?? [{ spaceBeforePt: 0, spaceAfterPt: 0 }];
      let previousAfter = 0;
      for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
        const before = Number(paragraph.spaceBeforePt ?? 0);
        const after = Number(paragraph.spaceAfterPt ?? 0);
        if (!paragraphSpacing.has(before) || !paragraphSpacing.has(after) || (paragraphIndex > 0 && previousAfter > 0 && before > 0)) diagnostics.push(diagnostic(
          "SW028", "error", slide.id, shape.id,
          `Paragraph ${paragraphIndex + 1} spacing must use 0pt, 6pt, or 12pt on only one side of a paragraph boundary; received before=${before}pt after=${after}pt.`,
          "Use the deck spacing scale and reduce spacing before shrinking text or allowing content to escape its frame.",
        ));
        previousAfter = after;
      }

      if (shape.headlinePolicy) {
        const lines = Number(shape.fit?.lines);
        const preferred = Number(shape.fit?.preferredSizePt);
        const actual = Number(shape.style?.fontSizePt);
        const ordered = [...approved].filter((size) => size <= preferred).sort((a, b) => b - a);
        const steps = ordered.indexOf(actual);
        const role = DEFAULT_TYPOGRAPHY_ROLES[shape.typographyRole] ?? plan.designSystem?.typographyRoles?.[shape.typographyRole];
        const policyDrift = shape.headlinePolicy.typographyRole !== shape.typographyRole
          || shape.headlinePolicy.maximumLines !== role?.maximumLines
          || shape.headlinePolicy.maximumAutoSizeSteps !== 1
          || shape.headlinePolicy.languageMode !== "line-capacity";
        if (policyDrift || !Number.isFinite(lines) || lines > shape.headlinePolicy.maximumLines || steps < 0 || steps > shape.headlinePolicy.maximumAutoSizeSteps) diagnostics.push(diagnostic(
          "SW027", "error", slide.id, shape.id,
          `Constrained headline exceeds its editorial budget: ${lines} line(s), ${steps < 0 ? "unknown" : steps} auto-size step(s).`,
          "Boil down the headline or choose a roomier declared archetype; do not solve limited space with many lines or aggressive shrinking.",
        ));
      }

      const size = shape.style?.fontSizePt;
      if (!Number.isInteger(size)) {
        diagnostics.push(
          diagnostic("SW003", "error", slide.id, shape.id, `Font size ${size}pt is fractional.`, "Select a whole point value from the approved scale."),
        );
      } else if (!approved.has(size)) {
        diagnostics.push(
          diagnostic("SW002", "error", slide.id, shape.id, `Font size ${size}pt is outside the approved scale.`, "Select the closest approved size that fits."),
        );
      }
      if (Number.isFinite(shape.fit?.minSizePt) && size < shape.fit.minSizePt) {
        diagnostics.push(
          diagnostic("SW009", "error", slide.id, shape.id, `Font size ${size}pt is below the configured ${shape.fit.minSizePt}pt minimum.`, "Shorten the copy or choose a less dense layout; never bypass the minimum type size."),
        );
      }
      const measuredFit = measureText({
        text: textFromRuns(shape.text?.runs ?? []),
        width: shape.position.width,
        height: shape.position.height,
        fontSizePt: size,
        lineHeight: shape.style?.lineHeight,
        insets: shape.style?.insets,
        glyphFactor: shape.fit?.glyphFactor,
        maxLines: shape.fit?.maxLines,
        paragraphs,
      });
      if (!shape.fit?.fits || !measuredFit.fits) {
        diagnostics.push(
          diagnostic("SW004", "error", slide.id, shape.id, `Text does not fit at the configured size (recomputed ${measuredFit.lines} lines, ${measuredFit.estimatedHeight}px high).`, "Shorten the copy, enlarge the frame, or select a less dense layout."),
        );
      }
      if (Number.isFinite(shape.fit?.maxLines) && Number(shape.fit?.lines) > Number(shape.fit.maxLines)) {
        diagnostics.push(
          diagnostic("SW013", "error", slide.id, shape.id, `Text wraps to ${shape.fit.lines} lines but the contract allows ${shape.fit.maxLines}.`, "Shorten the copy, widen the text frame, or choose a layout that explicitly permits more lines."),
        );
      }
      const background = effectiveTextBackground(slide, shapes, shapeIndex, tolerance);
      const colors = new Set([shape.style?.color, ...(shape.text?.runs ?? []).map((run) => run.color)].filter(Boolean));
      const allBold = (shape.text?.runs ?? []).filter((run) => run.text?.trim()).every((run) => run.bold === true);
      const threshold = size >= 18 || (size >= 14 && allBold) ? QUALITY_THRESHOLDS.largeTextContrast : QUALITY_THRESHOLDS.normalTextContrast;
      for (const color of colors) {
        const ratio = contrastRatio(color, background);
        if (ratio == null || ratio < threshold) diagnostics.push(
          diagnostic("SW011", "error", slide.id, shape.id, `Text contrast ${ratio == null ? "is unknown" : `${ratio.toFixed(2)}:1`} for ${color} on ${background}; minimum is ${threshold}:1.`, "Use a foreground/background pair that meets the large- or normal-text contrast threshold."),
        );
      }
      if (!shape.text?.runs?.length || textFromRuns(shape.text.runs).trim() === "") {
        diagnostics.push(
          diagnostic("SW008", "error", slide.id, shape.id, "Text object is empty.", "Remove the object or provide audience-facing copy."),
        );
      }
      const emptyParagraph = (shape.text?.paragraphs ?? []).some((paragraph) => textFromRuns(paragraph.runs ?? []).replace(/[\u00a0\s]/gu, "") === "");
      if (emptyParagraph) diagnostics.push(
        diagnostic("SW022", "error", slide.id, shape.id, "Text object contains an empty inherited paragraph.", "Strip empty inherited paragraphs before fitting so they cannot emit blank bullets or consume layout space."),
      );
    }

    for (const shape of shapes.filter((candidate) => candidate.role === "icon" || candidate.semanticType === "icon")) {
      const binding = shape.semanticBinding;
      const label = binding?.labelId ? byId.get(binding.labelId) : null;
      const ontology = binding?.conceptId ? (DEFAULT_ICON_ONTOLOGY[binding.conceptId] ?? plan.designSystem?.iconOntology?.[binding.conceptId]) : null;
      const allowedIcons = Array.isArray(ontology) ? ontology : ontology?.icons;
      const iconName = shape.icon?.name;
      const requiresSemanticIcons = (DEFAULT_ARCHETYPES[slide.archetypeId] ?? plan.designSystem?.archetypes?.[slide.archetypeId])?.requiresSemanticIcons === true;
      const validDecorative = !requiresSemanticIcons && binding?.decorative === true && !binding.labelId;
      const validSemantic = binding?.decorative === false && label?.type === "text" && label.semanticConceptId === binding.conceptId
        && Array.isArray(allowedIcons) && allowedIcons.includes(iconName);
      if (!validDecorative && !validSemantic) diagnostics.push(diagnostic(
        "SW026", "error", slide.id, shape.id,
        `Icon '${iconName ?? "unknown"}' is not semantically bound to its accompanying label.`,
        "Choose an icon from the declared concept vocabulary (for example, target for Goal) and bind it to the exact label, or mark a truly decorative icon as decorative.",
      ));
    }

    for (let leftIndex = 0; leftIndex < shapes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < shapes.length; rightIndex += 1) {
        const leftShape = shapes[leftIndex];
        const rightShape = shapes[rightIndex];
        const leftRect = shapeRect(leftShape);
        const rightRect = shapeRect(rightShape);
        const exactIntersection = positiveIntersection(leftRect, rightRect);
        if (!exactIntersection) continue;
        const reservedIds = new Set(slide.layoutContract?.reservedRegionIds ?? []);
        const chartLabelPair = leftShape.role === "chart-label" && rightShape.role === "chart-label" && leftShape.parentId === rightShape.parentId;
        const textText = leftShape.type === "text" && rightShape.type === "text" && !chartLabelPair;
        const textReserved = (leftShape.type === "text" && (reservedIds.has(rightShape.id) || rightShape.type === "image" || rightShape.role === "reserved-region"))
          || (rightShape.type === "text" && (reservedIds.has(leftShape.id) || leftShape.type === "image" || leftShape.role === "reserved-region"));
        if (textText || textReserved) {
          diagnostics.push(diagnostic(
            "SW018", "error", slide.id, `${leftShape.id}|${rightShape.id}`,
            textText ? `Text boxes '${leftShape.id}' and '${rightShape.id}' intersect.` : `Text intersects reserved region in '${leftShape.id}|${rightShape.id}'.`,
            "Relayout the slide; text-to-text and text-to-reserved-region intersections can never be waived.",
          ));
          continue;
        }
        if (overlapArea(leftRect, rightRect) <= tolerance * tolerance) continue;
        const allowedByContract = leftShape.constraints?.allowOverlapWith?.includes(rightShape.id)
          || rightShape.constraints?.allowOverlapWith?.includes(leftShape.id)
          || leftShape.parentId === rightShape.id
          || rightShape.parentId === leftShape.id;
        if (!allowedByContract) diagnostics.push(
          diagnostic("SW010", "error", slide.id, `${leftShape.id}|${rightShape.id}`, `Undeclared overlap between '${leftShape.id}' and '${rightShape.id}'.`, "Move the objects apart or declare the intentional overlap explicitly on one object."),
        );
      }
    }

    const frameRect = { left: slide.frame.left, top: slide.frame.top, right: slide.frame.left + slide.frame.width, bottom: slide.frame.top + slide.frame.height };
    const topLevelShapes = shapes
      .filter((shape, index) => !shapes.some((candidate, candidateIndex) => candidateIndex !== index && candidate.type === "shape" && contains(rect(candidate), rect(shape), tolerance)));
    const topLevelRects = topLevelShapes
      .map((shape) => rect(shape))
      .map((item) => ({
        left: Math.max(item.left, frameRect.left),
        top: Math.max(item.top, frameRect.top),
        right: Math.min(item.right, frameRect.right),
        bottom: Math.min(item.bottom, frameRect.bottom),
      }))
      .filter((item) => item.right > item.left && item.bottom > item.top);
    const occupancy = unionArea(topLevelRects) / (slide.frame.width * slide.frame.height);
    const maximumOccupancy = slide.quality?.maximumOccupancyRatio ?? QUALITY_THRESHOLDS.maximumOccupancyRatio;
    const maximumObjects = slide.quality?.maximumTopLevelObjects ?? QUALITY_THRESHOLDS.maximumTopLevelObjects;
    const minimumGap = slide.quality?.minimumPeerGapPx ?? QUALITY_THRESHOLDS.minimumPeerGapPx;
    let smallestGap = Number.POSITIVE_INFINITY;
    for (let leftIndex = 0; leftIndex < topLevelShapes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < topLevelShapes.length; rightIndex += 1) {
        const leftPeer = topLevelShapes[leftIndex];
        const rightPeer = topLevelShapes[rightIndex];
        const structuralSplitIds = new Set((slide.layoutContract?.structuralSplits ?? []).map((split) => split.shapeId));
        if (structuralSplitIds.has(leftPeer.id) || structuralSplitIds.has(rightPeer.id)) continue;
        const a = rect(leftPeer);
        const b = rect(rightPeer);
        if (overlapArea(a, b) > tolerance * tolerance) continue;
        const dx = Math.max(0, a.left - b.right, b.left - a.right);
        const dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
        smallestGap = Math.min(smallestGap, Math.hypot(dx, dy));
      }
    }
    const crowdingReasons = [];
    if (occupancy > maximumOccupancy + 0.0001) crowdingReasons.push(`${(occupancy * 100).toFixed(1)}% occupancy exceeds ${(maximumOccupancy * 100).toFixed(1)}%`);
    if (topLevelShapes.length > maximumObjects) crowdingReasons.push(`${topLevelShapes.length} top-level objects exceed ${maximumObjects}`);
    if (Number.isFinite(smallestGap) && smallestGap + tolerance < minimumGap) crowdingReasons.push(`${smallestGap.toFixed(1)}px peer gap is below ${minimumGap}px`);
    if (crowdingReasons.length) diagnostics.push(
      diagnostic("SW014", "error", slide.id, null, `Crowded layout: ${crowdingReasons.join("; ")}.`, "Remove, split, or relayout content to restore the declared whitespace, object-count, and peer-gap budgets."),
    );
  }

  const counts = diagnostics.reduce(
    (acc, item) => ({ ...acc, [item.severity]: (acc[item.severity] ?? 0) + 1 }),
    { error: 0, warning: 0 },
  );
  return {
    valid: diagnostics.length === 0,
    counts,
    diagnostics,
    planHash: plan.build?.deterministicHash ?? null,
  };
}
