import { createHash } from "node:crypto";
import {
  COMMON_FONT_SIZES_PT,
  DEFAULT_CANVAS,
  DEFAULT_LAYOUT,
  mergeTheme,
} from "./tokens.mjs";
import { fitText, flattenParagraphs, normalizeParagraphs, textFromRuns } from "./typography.mjs";

const VERSION = "0.1";

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function assertString(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
}

function assertText(value, path, defaultBold = false) {
  try {
    normalizeParagraphs(value, defaultBold);
  } catch (error) {
    throw new Error(`${path}: ${error.message}`, { cause: error });
  }
}

export function validateDeckSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("Deck specification must be a JSON object.");
  if (spec.version !== VERSION) throw new Error(`Unsupported deck specification version '${spec.version}'. Expected '${VERSION}'.`);
  assertString(spec.title, "title");
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) throw new Error("slides must be a non-empty array.");

  let declaredTopics = null;
  if (spec.coverage != null) {
    if (!spec.coverage || !Array.isArray(spec.coverage.topics) || !spec.coverage.topics.length) throw new Error("coverage.topics must be a non-empty array.");
    const ids = spec.coverage.topics.map((topic, index) => {
      assertString(topic?.id, `coverage.topics[${index}].id`);
      assertString(topic?.title, `coverage.topics[${index}].title`);
      return topic.id;
    });
    if (new Set(ids).size !== ids.length) throw new Error("coverage topic ids must be unique.");
    declaredTopics = new Set(ids);
  }

  spec.slides.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") throw new Error(`slides[${index}] must be an object.`);
    if (!["hero", "two-column", "section"].includes(slide.layout)) throw new Error(`slides[${index}].layout must be 'hero', 'two-column', or 'section'.`);
    if (slide.columnGap != null && (!Number.isFinite(slide.columnGap) || slide.columnGap < 16 || slide.columnGap > 96)) throw new Error(`slides[${index}].columnGap must be between 16 and 96.`);
    if (slide.headlineSplit != null && (!slide.headlineSplit || !["center", "two-thirds"].includes(slide.headlineSplit.ratio) || !["left", "right"].includes(slide.headlineSplit.side))) throw new Error(`slides[${index}].headlineSplit must declare ratio center|two-thirds and side left|right.`);
    if (declaredTopics) {
      assertString(slide.topicId, `slides[${index}].topicId`);
      if (!declaredTopics.has(slide.topicId)) throw new Error(`slides[${index}].topicId '${slide.topicId}' is not declared by coverage.topics.`);
      if (!["divider", "substantive"].includes(slide.coverageRole)) throw new Error(`slides[${index}].coverageRole must be 'divider' or 'substantive'.`);
    } else if (slide.topicId != null || slide.coverageRole != null) {
      throw new Error(`slides[${index}] cannot declare topic coverage without a deck coverage manifest.`);
    }
    if (slide.layout === "hero") {
      assertString(slide.eyebrow, `slides[${index}].eyebrow`);
      assertText(slide.title, `slides[${index}].title`);
      assertText(slide.body, `slides[${index}].body`);
      assertText(slide.callout, `slides[${index}].callout`);
    } else if (slide.layout === "two-column") {
      assertText(slide.title, `slides[${index}].title`, true);
      for (const side of ["left", "right"]) {
        assertString(slide[side]?.heading, `slides[${index}].${side}.heading`);
        assertText(slide[side]?.body, `slides[${index}].${side}.body`);
      }
    } else {
      assertText(slide.title, `slides[${index}].title`, true);
      assertText(slide.subtitle, `slides[${index}].subtitle`);
    }
  });
  return spec;
}

function textShape({ id, role, parentId, constraints, position, value, style, theme, defaultBold = false, fit }) {
  const normalized = normalizeParagraphs(value, defaultBold);
  const runs = flattenParagraphs(normalized.paragraphs);
  const text = textFromRuns(runs);
  const resolvedFit = fitText({ text, width: position.width, height: position.height, ...fit });
  return {
    id,
    type: "text",
    role,
    ...(parentId ? { parentId } : {}),
    ...(constraints ? { constraints } : {}),
    position,
    text: { runs, paragraphs: normalized.paragraphs },
    hygiene: { removedEmptyParagraphs: normalized.removedEmptyParagraphs },
    style: {
      typeface: theme.fontFamily,
      color: style.color,
      fontSizePt: resolvedFit.fontSizePt,
      lineHeight: fit.lineHeight ?? 1.16,
      alignment: style.alignment ?? "left",
      verticalAlignment: style.verticalAlignment ?? "top",
      insets: style.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
    },
    fit: resolvedFit,
    editable: true,
  };
}

function surfaceShape({ id, position, fill, line, radius = 18, padding, role }) {
  return { id, type: "shape", ...(role ? { role } : {}), geometry: "roundRect", position, fill, line, radius, padding, editable: true };
}

function refitTextShape(shape) {
  const fit = fitText({
    text: textFromRuns(shape.text.runs),
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

function compileHero(slide, index, frame, theme) {
  const shapes = [];
  shapes.push(textShape({
    id: `s${index + 1}-eyebrow`, role: "eyebrow",
    position: { left: frame.left, top: frame.top, width: frame.width, height: 28 },
    value: slide.eyebrow.toUpperCase(), style: { color: theme.colors.accent }, theme, defaultBold: true,
    fit: { preferredSizePt: 14, minSizePt: 12, maxLines: 1, lineHeight: 1 },
  }));
  shapes.push(textShape({
    id: `s${index + 1}-title`, role: "title",
    constraints: { alignTo: { targetId: `s${index + 1}-eyebrow`, edge: "left" } },
    position: { left: frame.left, top: frame.top + 72, width: frame.width, height: 182 },
    value: slide.title, style: { color: theme.colors.text }, theme,
    fit: { preferredSizePt: 54, minSizePt: 28, maxLines: 3, lineHeight: 1.02, glyphFactor: 0.5 },
  }));
  shapes.push(textShape({
    id: `s${index + 1}-body`, role: "body",
    constraints: { alignTo: { targetId: `s${index + 1}-title`, edge: "left" } },
    position: { left: frame.left, top: frame.top + 280, width: 800, height: 108 },
    value: slide.body, style: { color: theme.colors.muted }, theme,
    fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 5, lineHeight: 1.2 },
  }));

  const calloutPosition = { left: frame.left, top: frame.top + frame.height - 120, width: frame.width, height: 132 };
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  shapes.push(surfaceShape({ id: `s${index + 1}-callout-surface`, position: calloutPosition, fill: theme.colors.accentSoft, line: { color: theme.colors.accentSoft, width: 0 }, padding }));
  shapes.push(textShape({
    id: `s${index + 1}-callout`, role: "callout", parentId: `s${index + 1}-callout-surface`,
    constraints: { alignTo: { targetId: `s${index + 1}-callout-surface`, edge: "left", offset: padding.left } },
    position: { left: calloutPosition.left + padding.left, top: calloutPosition.top + padding.top, width: calloutPosition.width - padding.left - padding.right, height: calloutPosition.height - padding.top - padding.bottom },
    value: slide.callout, style: { color: theme.colors.text, verticalAlignment: "middle" }, theme, defaultBold: true,
    fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 2, lineHeight: 1.08 },
  }));
  return shapes;
}

function compileTwoColumn(slide, index, frame, theme) {
  const shapes = [];
  shapes.push(textShape({
    id: `s${index + 1}-title`, role: "title", position: { left: frame.left, top: frame.top, width: frame.width, height: 132 },
    value: slide.title, style: { color: theme.colors.text }, theme, defaultBold: true,
    fit: { preferredSizePt: 36, minSizePt: 28, maxLines: 2, lineHeight: 1.02 },
  }));
  const gap = slide.columnGap ?? 24;
  const cardTop = frame.top + 164;
  const cardWidth = (frame.width - gap) / 2;
  const cardHeight = frame.height - 164;
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  ["left", "right"].forEach((side, sideIndex) => {
    const cardLeft = frame.left + sideIndex * (cardWidth + gap);
    const card = { left: cardLeft, top: cardTop, width: cardWidth, height: cardHeight };
    shapes.push(surfaceShape({ id: `s${index + 1}-${side}-surface`, position: card, fill: sideIndex === 0 ? theme.colors.surface : theme.colors.accentSoft, line: { color: sideIndex === 0 ? theme.colors.border : theme.colors.accentSoft, width: 1 }, padding }));
    shapes.push(textShape({
      id: `s${index + 1}-${side}-heading`, role: "subheading", parentId: `s${index + 1}-${side}-surface`,
      constraints: { alignTo: { targetId: `s${index + 1}-${side}-surface`, edge: "left", offset: padding.left } },
      position: { left: card.left + padding.left, top: card.top + padding.top, width: card.width - padding.left - padding.right, height: 76 },
      value: slide[side].heading, style: { color: sideIndex === 0 ? theme.colors.muted : theme.colors.accent }, theme, defaultBold: true,
      fit: { preferredSizePt: 20, minSizePt: 16, maxLines: 2, lineHeight: 1 },
    }));
    shapes.push(textShape({
      id: `s${index + 1}-${side}-body`, role: "body", parentId: `s${index + 1}-${side}-surface`,
      constraints: { alignTo: { targetId: `s${index + 1}-${side}-heading`, edge: "left" } },
      position: { left: card.left + padding.left, top: card.top + padding.top + 100, width: card.width - padding.left - padding.right, height: card.height - padding.top - padding.bottom - 100 },
      value: slide[side].body, style: { color: theme.colors.text }, theme,
      fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 8, lineHeight: 1.22 },
    }));
  });
  return shapes;
}

function compileSection(slide, index, frame, theme) {
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  const surfaceId = `s${index + 1}-title-surface`;
  const titleId = `s${index + 1}-title`;
  const draft = textShape({
    id: titleId, role: "title", parentId: surfaceId,
    constraints: { alignTo: { targetId: surfaceId, edge: "left", offset: padding.left } },
    position: { left: frame.left + padding.left, top: frame.top + padding.top, width: frame.width - padding.left - padding.right, height: 260 },
    value: slide.title, style: { color: theme.colors.text }, theme, defaultBold: true,
    fit: { preferredSizePt: 44, minSizePt: 28, maxLines: 4, lineHeight: 1.02, glyphFactor: 0.5 },
  });
  draft.position.height = Math.ceil(draft.fit.estimatedHeight);
  draft.fit.availableHeight = draft.position.height;
  draft.fit.fits = draft.fit.lines <= draft.fit.maxLines;
  const surfaceHeight = Math.max(128, padding.top + draft.position.height + padding.bottom);
  const surface = surfaceShape({
    id: surfaceId, role: "text-backing", position: { left: frame.left, top: frame.top, width: frame.width, height: surfaceHeight },
    fill: theme.colors.surface, line: { color: theme.colors.border, width: 1 }, padding,
  });
  const subtitle = textShape({
    id: `s${index + 1}-subtitle`, role: "subtitle",
    position: { left: frame.left, top: frame.top + surfaceHeight + 32, width: frame.width, height: 120 },
    value: slide.subtitle, style: { color: theme.colors.muted }, theme,
    fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 4, lineHeight: 1.2 },
  });
  return [surface, draft, subtitle];
}

export function compileDeck(input) {
  const spec = validateDeckSpec(structuredClone(input));
  const canvas = { ...DEFAULT_CANVAS, ...(spec.canvas ?? {}) };
  const margin = spec.layout?.margin ?? DEFAULT_LAYOUT.margin;
  const frame = { left: margin, top: margin, width: canvas.width - 2 * margin, height: canvas.height - 2 * margin };
  const theme = mergeTheme(spec.theme);
  const slides = spec.slides.map((slide, index) => {
    const shapes = slide.layout === "hero" ? compileHero(slide, index, frame, theme) : slide.layout === "two-column" ? compileTwoColumn(slide, index, frame, theme) : compileSection(slide, index, frame, theme);
    const headlineId = `s${index + 1}-title`;
    const titleSurfaceId = slide.layout === "section" ? `s${index + 1}-title-surface` : null;
    const structuralSplits = [];
    if (slide.headlineSplit) {
      const headline = shapes.find((shape) => shape.id === headlineId);
      const ratio = slide.headlineSplit.ratio === "center" ? 0.5 : 2 / 3;
      const splitX = frame.left + frame.width * ratio;
      const splitId = `s${index + 1}-headline-${slide.headlineSplit.ratio}-split`;
      shapes.push({
        id: splitId, type: "shape", role: "structural-split", geometry: "rect",
        position: { left: splitX, top: headline.position.top, width: 1, height: headline.position.height },
        fill: theme.colors.border, line: { color: theme.colors.border, width: 0 }, editable: true,
      });
      if (slide.headlineSplit.side === "left") headline.position.width = splitX - headline.position.left;
      else {
        const right = frame.left + frame.width;
        headline.position.left = splitX + 1;
        headline.position.width = right - headline.position.left;
      }
      refitTextShape(headline);
      structuralSplits.push({ shapeId: splitId, ratio: slide.headlineSplit.ratio, side: slide.headlineSplit.side });
    }
    return {
      id: slide.id ?? `slide-${index + 1}`,
      layout: slide.layout,
      ...(slide.topicId ? { topicId: slide.topicId, coverageRole: slide.coverageRole } : {}),
      layoutContract: {
        headline: { shapeId: headlineId, ...(titleSurfaceId ? { containerId: titleSurfaceId } : {}) },
        structuralSplits,
        fitSurfaces: titleSurfaceId ? [{ surfaceId: titleSurfaceId, childIds: [headlineId], minHeight: 128, exactBottom: true }] : [],
        reservedRegionIds: [],
        ...(slide.layout === "two-column" ? { type: "two-column", columnGap: slide.columnGap ?? 24 } : {}),
      },
      background: theme.colors.background,
      frame,
      shapes,
    };
  });

  const removedEmptyParagraphs = slides.reduce((total, slide) => total + slide.shapes.reduce((count, shape) => count + Number(shape.hygiene?.removedEmptyParagraphs ?? 0), 0), 0);
  const plan = {
    schemaVersion: VERSION,
    generator: "slidewright",
    source: { title: spec.title },
    canvas,
    layout: { ...DEFAULT_LAYOUT, ...(spec.layout ?? {}), margin, approvedFontSizesPt: [...COMMON_FONT_SIZES_PT] },
    theme,
    ...(spec.coverage ? { coverage: { topics: structuredClone(spec.coverage.topics), requireDivider: true, requireSubstantive: true } } : {}),
    hygiene: { removedEmptyParagraphs },
    slides,
  };
  plan.build = { deterministicHash: stableHash(plan) };
  return plan;
}
