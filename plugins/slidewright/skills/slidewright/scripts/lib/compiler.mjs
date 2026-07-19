import { createHash } from "node:crypto";
import {
  COMMON_FONT_SIZES_PT,
  DEFAULT_ARCHETYPES,
  DEFAULT_CANVAS,
  DEFAULT_ICON_GLYPHS,
  DEFAULT_ICON_ONTOLOGY,
  DEFAULT_INSET_TOKENS_PX,
  DEFAULT_LAYOUT,
  DEFAULT_MAX_INSET_PX,
  DEFAULT_PARAGRAPH_SPACING_PT,
  DEFAULT_TYPOGRAPHY_ROLES,
  mergeTheme,
} from "./tokens.mjs";
import { fitText, flattenParagraphs, normalizeParagraphs, textFromRuns } from "./typography.mjs";

const VERSION = "0.2";
const SUPPORTED_INPUT_VERSIONS = new Set(["0.1", VERSION]);
const REVIEW_RELATIONSHIPS = new Set([
  "comparison-selection",
  "crosswalk",
  "role-boundary",
  "sequence-handoff",
  "decision-ownership",
  "category-trigger",
  "application-trigger",
  "evidence-rule",
]);

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
  if (!SUPPORTED_INPUT_VERSIONS.has(spec.version)) throw new Error(`Unsupported deck specification version '${spec.version}'. Expected '0.1' or '${VERSION}'.`);
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
    if (!["hero", "two-column", "section", "continuation", "table", "icon-list"].includes(slide.layout)) throw new Error(`slides[${index}].layout must be 'hero', 'two-column', 'section', 'continuation', 'table', or 'icon-list'.`);
    if (slide.columnGap != null && (!Number.isFinite(slide.columnGap) || slide.columnGap < 16 || slide.columnGap > 96)) throw new Error(`slides[${index}].columnGap must be between 16 and 96.`);
    if (slide.headlineSplit != null && (!slide.headlineSplit || !["center", "two-thirds"].includes(slide.headlineSplit.ratio) || !["left", "right"].includes(slide.headlineSplit.side))) throw new Error(`slides[${index}].headlineSplit must declare ratio center|two-thirds and side left|right.`);
    if (slide.reviewIntent != null && (!slide.reviewIntent || !REVIEW_RELATIONSHIPS.has(slide.reviewIntent.relationship))) throw new Error(`slides[${index}].reviewIntent.relationship must be one of ${[...REVIEW_RELATIONSHIPS].join(" | ")}.`);
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
    } else if (slide.layout === "section") {
      assertText(slide.title, `slides[${index}].title`, true);
      assertText(slide.subtitle, `slides[${index}].subtitle`);
    } else if (slide.layout === "continuation") {
      assertString(slide.eyebrow, `slides[${index}].eyebrow`);
      assertText(slide.title, `slides[${index}].title`, true);
      assertText(slide.body, `slides[${index}].body`);
    } else if (slide.layout === "table") {
      assertText(slide.title, `slides[${index}].title`, true);
      if (!slide.table || !Array.isArray(slide.table.columns) || slide.table.columns.length < 2 || slide.table.columns.length > 6) throw new Error(`slides[${index}].table.columns must contain 2-6 strings.`);
      slide.table.columns.forEach((value, columnIndex) => assertString(value, `slides[${index}].table.columns[${columnIndex}]`));
      if (!Array.isArray(slide.table.rows) || slide.table.rows.length < 1 || slide.table.rows.length > 8) throw new Error(`slides[${index}].table.rows must contain 1-8 rows.`);
      slide.table.rows.forEach((row, rowIndex) => {
        if (!Array.isArray(row) || row.length !== slide.table.columns.length) throw new Error(`slides[${index}].table.rows[${rowIndex}] must contain exactly ${slide.table.columns.length} cells.`);
        row.forEach((value, columnIndex) => assertString(value, `slides[${index}].table.rows[${rowIndex}][${columnIndex}]`));
      });
    } else {
      assertText(slide.title, `slides[${index}].title`, true);
      if (!Array.isArray(slide.items) || slide.items.length < 2 || slide.items.length > 4) throw new Error(`slides[${index}].items must contain 2-4 semantic icon cards.`);
      const itemIds = [];
      slide.items.forEach((item, itemIndex) => {
        assertString(item?.id, `slides[${index}].items[${itemIndex}].id`);
        assertString(item?.label, `slides[${index}].items[${itemIndex}].label`);
        assertText(item?.body, `slides[${index}].items[${itemIndex}].body`);
        assertString(item?.conceptId, `slides[${index}].items[${itemIndex}].conceptId`);
        assertString(item?.icon, `slides[${index}].items[${itemIndex}].icon`);
        if (!DEFAULT_ICON_GLYPHS[item.icon]) throw new Error(`slides[${index}].items[${itemIndex}].icon '${item.icon}' is not in the native icon library.`);
        itemIds.push(item.id);
      });
      if (new Set(itemIds).size !== itemIds.length) throw new Error(`slides[${index}].items ids must be unique.`);
    }
  });
  return spec;
}

function textShape({ id, role, typographyRole, componentPattern, parentId, constraints, position, value, style, theme, defaultBold = false, fit }) {
  const normalized = normalizeParagraphs(value, defaultBold, {
    beforePt: 0,
    betweenPt: ["body", "callout", "subtitle"].includes(role) ? 6 : 0,
    afterPt: 0,
  });
  const runs = flattenParagraphs(normalized.paragraphs);
  const text = textFromRuns(runs);
  const resolvedFit = fitText({ text, width: position.width, height: position.height, paragraphs: normalized.paragraphs, ...fit });
  return {
    id,
    type: "text",
    role,
    typographyRole,
    styleTokenRefs: { typography: typographyRole, insets: "none", paragraphSpacing: "default" },
    ...(componentPattern ? { componentPattern } : {}),
    ...(parentId ? { parentId } : {}),
    ...(parentId ? { backingId: parentId } : {}),
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

function forceCommonTextSize(shapes, fontSizePt) {
  for (const shape of shapes) {
    const preferredSizePt = shape.fit.preferredSizePt;
    const minSizePt = shape.fit.minSizePt;
    const resolved = fitText({
      text: textFromRuns(shape.text.runs),
      paragraphs: shape.text.paragraphs,
      width: shape.position.width,
      height: shape.position.height,
      preferredSizePt: fontSizePt,
      minSizePt: fontSizePt,
      lineHeight: shape.style.lineHeight,
      insets: shape.style.insets,
      glyphFactor: shape.fit.glyphFactor,
      maxLines: shape.fit.maxLines,
    });
    shape.style.fontSizePt = fontSizePt;
    shape.fit = {
      ...resolved,
      preferredSizePt,
      minSizePt,
      autoSized: fontSizePt < preferredSizePt,
    };
  }
}

function surfaceShape({ id, position, fill, line, radius = 18, padding, role }) {
  return { id, type: "shape", ...(role ? { role } : {}), geometry: "roundRect", position, fill, line, radius, padding, editable: true };
}

function tableShape({ id, position, columns, rows, theme }) {
  const insets = { top: 8, right: 8, bottom: 8, left: 8 };
  const columnWidths = columns.map(() => position.width / columns.length);
  return {
    id,
    type: "table",
    role: "table",
    position,
    editable: true,
    table: {
      values: [columns, ...rows],
      headerRows: 1,
      columnWidths,
      styles: {
        header: { typographyRole: "table-header", typeface: theme.fontFamily, fontSizePt: 16, bold: true, color: "#FFFFFF", fill: theme.colors.text, lineHeight: 1.08, maximumLines: 2, insets: { ...insets } },
        body: { typographyRole: "table-body", typeface: theme.fontFamily, fontSizePt: 16, bold: false, color: theme.colors.text, fill: theme.colors.surface, lineHeight: 1.12, maximumLines: 3, insets: { ...insets } },
      },
      cells: [],
    },
    styleTokenRefs: { headerTypography: "table-header", bodyTypography: "table-body", insets: "compact" },
  };
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
    paragraphs: shape.text.paragraphs,
  });
  shape.fit = fit;
  shape.style.fontSizePt = fit.fontSizePt;
}

function compileHero(slide, index, frame, theme) {
  const shapes = [];
  shapes.push(textShape({
    id: `s${index + 1}-eyebrow`, role: "eyebrow", typographyRole: "eyebrow",
    position: { left: frame.left, top: frame.top, width: frame.width, height: 28 },
    value: slide.eyebrow.toUpperCase(), style: { color: theme.colors.accent }, theme, defaultBold: true,
    fit: { preferredSizePt: 14, minSizePt: 12, maxLines: 1, lineHeight: 1 },
  }));
  shapes.push(textShape({
    id: `s${index + 1}-title`, role: "title", typographyRole: "hero-title",
    constraints: { alignTo: { targetId: `s${index + 1}-eyebrow`, edge: "left" } },
    position: { left: frame.left, top: frame.top + 72, width: frame.width, height: 182 },
    value: slide.title, style: { color: theme.colors.text }, theme,
    fit: { preferredSizePt: 54, minSizePt: 28, maxLines: 2, lineHeight: 1.02, glyphFactor: 0.5 },
  }));
  shapes.push(textShape({
    id: `s${index + 1}-body`, role: "body", typographyRole: "body",
    constraints: { alignTo: { targetId: `s${index + 1}-title`, edge: "left" } },
    position: { left: frame.left, top: frame.top + 280, width: 800, height: 108 },
    value: slide.body, style: { color: theme.colors.muted }, theme,
    fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 5, lineHeight: 1.2 },
  }));

  const calloutPosition = { left: frame.left, top: frame.top + frame.height - 120, width: frame.width, height: 132 };
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  shapes.push(surfaceShape({ id: `s${index + 1}-callout-surface`, position: calloutPosition, fill: theme.colors.accentSoft, line: { color: theme.colors.accentSoft, width: 0 }, padding }));
  shapes.push(textShape({
    id: `s${index + 1}-callout`, role: "callout", typographyRole: "callout", parentId: `s${index + 1}-callout-surface`,
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
    id: `s${index + 1}-title`, role: "title", typographyRole: "slide-title", position: { left: frame.left, top: frame.top, width: frame.width, height: 132 },
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
      id: `s${index + 1}-${side}-heading`, role: "subheading", typographyRole: "component-heading",
      componentPattern: { familyId: "two-column-card", instanceId: side, slot: "heading", variantId: sideIndex === 0 ? "neutral" : "accent" }, parentId: `s${index + 1}-${side}-surface`,
      constraints: { alignTo: { targetId: `s${index + 1}-${side}-surface`, edge: "left", offset: padding.left } },
      position: { left: card.left + padding.left, top: card.top + padding.top, width: card.width - padding.left - padding.right, height: 76 },
      value: slide[side].heading, style: { color: sideIndex === 0 ? theme.colors.muted : theme.colors.accent }, theme, defaultBold: true,
      fit: { preferredSizePt: 20, minSizePt: 16, maxLines: 2, lineHeight: 1 },
    }));
    shapes.push(textShape({
      id: `s${index + 1}-${side}-body`, role: "body", typographyRole: "component-body",
      componentPattern: { familyId: "two-column-card", instanceId: side, slot: "body", variantId: sideIndex === 0 ? "neutral" : "accent" }, parentId: `s${index + 1}-${side}-surface`,
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
    id: titleId, role: "title", typographyRole: "section-title", parentId: surfaceId,
    constraints: { alignTo: { targetId: surfaceId, edge: "left", offset: padding.left } },
    position: { left: frame.left + padding.left, top: frame.top + padding.top, width: frame.width - padding.left - padding.right, height: 260 },
    value: slide.title, style: { color: theme.colors.text }, theme, defaultBold: true,
    fit: { preferredSizePt: 44, minSizePt: 28, maxLines: 3, lineHeight: 1.02, glyphFactor: 0.5 },
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
    id: `s${index + 1}-subtitle`, role: "subtitle", typographyRole: "subtitle",
    position: { left: frame.left, top: frame.top + surfaceHeight + 32, width: frame.width, height: 120 },
    value: slide.subtitle, style: { color: theme.colors.muted }, theme,
    fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 4, lineHeight: 1.2 },
  });
  return [surface, draft, subtitle];
}

function compileContinuation(slide, index, frame, theme) {
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  const surfacePosition = { left: frame.left, top: frame.top + 176, width: frame.width, height: frame.height - 176 };
  return [
    textShape({
      id: `s${index + 1}-eyebrow`, role: "eyebrow", typographyRole: "eyebrow",
      position: { left: frame.left, top: frame.top, width: frame.width, height: 28 },
      value: slide.eyebrow.toUpperCase(), style: { color: theme.colors.accent }, theme, defaultBold: true,
      fit: { preferredSizePt: 14, minSizePt: 12, maxLines: 1, lineHeight: 1 },
    }),
    textShape({
      id: `s${index + 1}-title`, role: "title", typographyRole: "slide-title",
      constraints: { alignTo: { targetId: `s${index + 1}-eyebrow`, edge: "left" } },
      position: { left: frame.left, top: frame.top + 48, width: frame.width, height: 104 },
      value: slide.title, style: { color: theme.colors.text }, theme, defaultBold: true,
      fit: { preferredSizePt: 36, minSizePt: 28, maxLines: 2, lineHeight: 1.02, glyphFactor: 0.5 },
    }),
    surfaceShape({
      id: `s${index + 1}-body-surface`, role: "text-backing", position: surfacePosition,
      fill: theme.colors.surface, line: { color: theme.colors.border, width: 1 }, padding,
    }),
    textShape({
      id: `s${index + 1}-body`, role: "body", typographyRole: "body", parentId: `s${index + 1}-body-surface`,
      constraints: { alignTo: { targetId: `s${index + 1}-body-surface`, edge: "left", offset: padding.left } },
      position: {
        left: surfacePosition.left + padding.left,
        top: surfacePosition.top + padding.top,
        width: surfacePosition.width - padding.left - padding.right,
        height: surfacePosition.height - padding.top - padding.bottom,
      },
      value: slide.body, style: { color: theme.colors.text, verticalAlignment: "middle" }, theme,
      fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 14, lineHeight: 1.2 },
    }),
  ];
}

function compileTable(slide, index, frame, theme) {
  return [
    textShape({
      id: `s${index + 1}-title`, role: "title", typographyRole: "slide-title",
      position: { left: frame.left, top: frame.top, width: frame.width, height: 96 },
      value: slide.title, style: { color: theme.colors.text }, theme, defaultBold: true,
      fit: { preferredSizePt: 36, minSizePt: 28, maxLines: 2, lineHeight: 1.02, glyphFactor: 0.5 },
    }),
    tableShape({
      id: `s${index + 1}-table`, position: { left: frame.left, top: frame.top + 144, width: frame.width, height: frame.height - 144 },
      columns: slide.table.columns, rows: slide.table.rows, theme,
    }),
  ];
}

function compileIconList(slide, index, frame, theme) {
  const shapes = [textShape({
    id: `s${index + 1}-title`, role: "title", typographyRole: "slide-title",
    position: { left: frame.left, top: frame.top, width: frame.width, height: 96 },
    value: slide.title, style: { color: theme.colors.text }, theme, defaultBold: true,
    fit: { preferredSizePt: 36, minSizePt: 28, maxLines: 2, lineHeight: 1.02, glyphFactor: 0.5 },
  })];
  const gap = 24;
  const cardTop = frame.top + 128;
  const cardWidth = (frame.width - gap * (slide.items.length - 1)) / slide.items.length;
  const cardHeight = frame.height - 128;
  const padding = { top: 24, right: 24, bottom: 24, left: 24 };
  const bodyShapes = [];
  slide.items.forEach((item, itemIndex) => {
    const card = { left: frame.left + itemIndex * (cardWidth + gap), top: cardTop, width: cardWidth, height: cardHeight };
    const surfaceId = `s${index + 1}-${item.id}-surface`;
    const labelId = `s${index + 1}-${item.id}-label`;
    shapes.push(surfaceShape({ id: surfaceId, role: "semantic-card", position: card, fill: theme.colors.surface, line: { color: theme.colors.border, width: 1 }, padding }));
    const icon = textShape({
      id: `s${index + 1}-${item.id}-icon`, role: "icon", typographyRole: "icon", parentId: surfaceId,
      position: { left: card.left + padding.left, top: card.top + padding.top, width: card.width - 2 * padding.left, height: 48 },
      value: DEFAULT_ICON_GLYPHS[item.icon], style: { color: theme.colors.accent, verticalAlignment: "middle" }, theme,
      fit: { preferredSizePt: 28, minSizePt: 20, maxLines: 1, lineHeight: 1 },
    });
    icon.semanticType = "icon";
    icon.icon = { name: item.icon, representation: "native-text-glyph" };
    icon.semanticBinding = { conceptId: item.conceptId, labelId, decorative: false };
    shapes.push(icon);
    const label = textShape({
      id: labelId, role: "subheading", typographyRole: "component-heading", parentId: surfaceId,
      componentPattern: { familyId: "semantic-card", instanceId: item.id, slot: "heading", variantId: "default" },
      position: { left: card.left + padding.left, top: card.top + 88, width: card.width - 2 * padding.left, height: 64 },
      value: item.label, style: { color: theme.colors.text }, theme, defaultBold: true,
      fit: { preferredSizePt: 20, minSizePt: 16, maxLines: 2, lineHeight: 1 },
    });
    label.semanticConceptId = item.conceptId;
    shapes.push(label);
    const body = textShape({
      id: `s${index + 1}-${item.id}-body`, role: "body", typographyRole: "component-body", parentId: surfaceId,
      componentPattern: { familyId: "semantic-card", instanceId: item.id, slot: "body", variantId: "default" },
      position: { left: card.left + padding.left, top: card.top + 176, width: card.width - 2 * padding.left, height: card.height - padding.bottom - 176 },
      value: item.body, style: { color: theme.colors.muted }, theme,
      fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 8, lineHeight: 1.22 },
    });
    bodyShapes.push(body);
    shapes.push(body);
  });
  // A repeated card family uses one shared body size. If one item needs a
  // smaller approved size, the whole family changes together; copy adaptation
  // can then split only the dense item without introducing style drift.
  forceCommonTextSize(bodyShapes, Math.min(...bodyShapes.map((shape) => shape.style.fontSizePt)));
  return shapes;
}

export function compileDeck(input) {
  const spec = validateDeckSpec(structuredClone(input));
  const canvas = { ...DEFAULT_CANVAS, ...(spec.canvas ?? {}) };
  const margin = spec.layout?.margin ?? DEFAULT_LAYOUT.margin;
  const frame = { left: margin, top: margin, width: canvas.width - 2 * margin, height: canvas.height - 2 * margin };
  const theme = mergeTheme(spec.theme);
  const designSystemId = spec.designSystem?.id ?? "slidewright-default-v1";
  const designMasterId = spec.designSystem?.designMasterId ?? "generated-logical-master";
  const designSystem = {
    schemaVersion: "slidewright-design-system/v1",
    id: designSystemId,
    logicalMaster: {
      id: designMasterId,
      kind: "generated-logical-master",
      nativePowerPointMasterClaimed: false,
      canvas: structuredClone(canvas),
      fontFamily: theme.fontFamily,
    },
    insetTokensPx: structuredClone(spec.designSystem?.insetTokensPx ?? DEFAULT_INSET_TOKENS_PX),
    maximumInsetPx: spec.designSystem?.maximumInsetPx ?? DEFAULT_MAX_INSET_PX,
    paragraphSpacingPt: structuredClone(spec.designSystem?.paragraphSpacingPt ?? DEFAULT_PARAGRAPH_SPACING_PT),
    typographyRoles: { ...structuredClone(DEFAULT_TYPOGRAPHY_ROLES), ...(structuredClone(spec.designSystem?.typographyRoles) ?? {}) },
    archetypes: { ...structuredClone(DEFAULT_ARCHETYPES), ...(structuredClone(spec.designSystem?.archetypes) ?? {}) },
    iconOntology: { ...structuredClone(DEFAULT_ICON_ONTOLOGY), ...(structuredClone(spec.designSystem?.iconOntology) ?? {}) },
  };
  const slides = spec.slides.map((slide, index) => {
    const shapes = slide.layout === "hero"
      ? compileHero(slide, index, frame, theme)
      : slide.layout === "two-column"
        ? compileTwoColumn(slide, index, frame, theme)
        : slide.layout === "section"
          ? compileSection(slide, index, frame, theme)
          : slide.layout === "continuation"
            ? compileContinuation(slide, index, frame, theme)
            : slide.layout === "table"
              ? compileTable(slide, index, frame, theme)
              : compileIconList(slide, index, frame, theme);
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
    for (const shape of shapes.filter((candidate) => candidate.type === "text" && ["title", "subheading"].includes(candidate.role))) {
      const role = designSystem.typographyRoles[shape.typographyRole];
      shape.headlinePolicy = {
        typographyRole: shape.typographyRole,
        maximumLines: role.maximumLines,
        maximumAutoSizeSteps: 1,
        languageMode: "line-capacity",
      };
    }
    return {
      id: slide.id ?? `slide-${index + 1}`,
      layout: slide.layout,
      archetypeId: slide.layout,
      designMasterId,
      pageRole: designSystem.archetypes[slide.layout].pageRole,
      typedExceptions: [],
      ...(slide.topicId ? { topicId: slide.topicId, coverageRole: slide.coverageRole } : {}),
      ...(slide.reviewIntent ? { reviewIntent: structuredClone(slide.reviewIntent) } : {}),
      layoutContract: {
        headline: { shapeId: headlineId, ...(titleSurfaceId ? { containerId: titleSurfaceId } : {}) },
        structuralSplits,
        fitSurfaces: titleSurfaceId ? [{ surfaceId: titleSurfaceId, childIds: [headlineId], minHeight: 128, exactBottom: true }] : [],
        backings: shapes.filter((shape) => shape.type === "text" && shape.backingId).map((shape) => ({ backingId: shape.backingId, contentIds: [shape.id] })),
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
    designSystem,
    ...(spec.coverage ? { coverage: { topics: structuredClone(spec.coverage.topics), requireDivider: true, requireSubstantive: true } } : {}),
    hygiene: { removedEmptyParagraphs },
    slides,
  };
  plan.build = { deterministicHash: stableHash(plan) };
  return plan;
}
