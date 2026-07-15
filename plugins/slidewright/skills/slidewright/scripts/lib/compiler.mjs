import { createHash } from "node:crypto";
import {
  COMMON_FONT_SIZES_PT,
  DEFAULT_CANVAS,
  DEFAULT_LAYOUT,
  mergeTheme,
} from "./tokens.mjs";
import { fitText, normalizeRuns, textFromRuns } from "./typography.mjs";

const VERSION = "0.1";

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function assertString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

export function validateDeckSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("Deck specification must be a JSON object.");
  }
  if (spec.version !== VERSION) {
    throw new Error(`Unsupported deck specification version '${spec.version}'. Expected '${VERSION}'.`);
  }
  assertString(spec.title, "title");
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) {
    throw new Error("slides must be a non-empty array.");
  }
  spec.slides.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") throw new Error(`slides[${index}] must be an object.`);
    if (!["hero", "two-column"].includes(slide.layout)) {
      throw new Error(`slides[${index}].layout must be 'hero' or 'two-column'.`);
    }
    if (slide.layout === "hero") {
      assertString(slide.eyebrow, `slides[${index}].eyebrow`);
      normalizeRuns(slide.title);
      assertString(slide.body, `slides[${index}].body`);
      assertString(slide.callout, `slides[${index}].callout`);
    } else {
      normalizeRuns(slide.title, true);
      for (const side of ["left", "right"]) {
        assertString(slide[side]?.heading, `slides[${index}].${side}.heading`);
        assertString(slide[side]?.body, `slides[${index}].${side}.body`);
      }
    }
  });
  return spec;
}

function textShape({ id, role, position, value, style, theme, defaultBold = false, fit }) {
  const runs = normalizeRuns(value, defaultBold);
  const text = textFromRuns(runs);
  const resolvedFit = fitText({ text, width: position.width, height: position.height, ...fit });
  return {
    id,
    type: "text",
    role,
    position,
    text: { runs },
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

function surfaceShape({ id, position, fill, line, radius = 18, padding }) {
  return {
    id,
    type: "shape",
    geometry: "roundRect",
    position,
    fill,
    line,
    radius,
    padding,
    editable: true,
  };
}

function compileHero(slide, index, frame, theme) {
  const shapes = [];
  shapes.push(
    textShape({
      id: `s${index + 1}-eyebrow`,
      role: "eyebrow",
      position: { left: frame.left, top: frame.top, width: frame.width, height: 28 },
      value: slide.eyebrow.toUpperCase(),
      style: { color: theme.colors.accent },
      theme,
      defaultBold: true,
      fit: { preferredSizePt: 14, minSizePt: 12, maxLines: 1, lineHeight: 1 },
    }),
  );
  shapes.push(
    textShape({
      id: `s${index + 1}-title`,
      role: "title",
      position: { left: frame.left, top: frame.top + 72, width: 900, height: 182 },
      value: slide.title,
      style: { color: theme.colors.text },
      theme,
      fit: { preferredSizePt: 54, minSizePt: 28, maxLines: 3, lineHeight: 1.02, glyphFactor: 0.5 },
    }),
  );
  shapes.push(
    textShape({
      id: `s${index + 1}-body`,
      role: "body",
      position: { left: frame.left, top: frame.top + 280, width: 780, height: 108 },
      value: slide.body,
      style: { color: theme.colors.muted },
      theme,
      fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 4, lineHeight: 1.2 },
    }),
  );

  const calloutPosition = {
    left: frame.left,
    top: frame.top + frame.height - 120,
    width: frame.width,
    height: 120,
  };
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  shapes.push(
    surfaceShape({
      id: `s${index + 1}-callout-surface`,
      position: calloutPosition,
      fill: theme.colors.accentSoft,
      line: { color: theme.colors.accentSoft, width: 0 },
      padding,
    }),
  );
  shapes.push(
    textShape({
      id: `s${index + 1}-callout`,
      role: "callout",
      position: {
        left: calloutPosition.left + padding.left,
        top: calloutPosition.top + padding.top,
        width: calloutPosition.width - padding.left - padding.right,
        height: calloutPosition.height - padding.top - padding.bottom,
      },
      value: slide.callout,
      style: { color: theme.colors.text, verticalAlignment: "middle" },
      theme,
      defaultBold: true,
      fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 2, lineHeight: 1.08 },
    }),
  );
  return shapes;
}

function compileTwoColumn(slide, index, frame, theme) {
  const shapes = [];
  shapes.push(
    textShape({
      id: `s${index + 1}-title`,
      role: "title",
      position: { left: frame.left, top: frame.top, width: frame.width, height: 88 },
      value: slide.title,
      style: { color: theme.colors.text },
      theme,
      defaultBold: true,
      fit: { preferredSizePt: 40, minSizePt: 28, maxLines: 2, lineHeight: 1.02 },
    }),
  );

  const gap = 40;
  const cardTop = frame.top + 124;
  const cardWidth = (frame.width - gap) / 2;
  const cardHeight = frame.height - 124;
  const padding = { top: 32, right: 32, bottom: 32, left: 32 };
  ["left", "right"].forEach((side, sideIndex) => {
    const cardLeft = frame.left + sideIndex * (cardWidth + gap);
    const card = { left: cardLeft, top: cardTop, width: cardWidth, height: cardHeight };
    shapes.push(
      surfaceShape({
        id: `s${index + 1}-${side}-surface`,
        position: card,
        fill: sideIndex === 0 ? theme.colors.surface : theme.colors.accentSoft,
        line: { color: sideIndex === 0 ? theme.colors.border : theme.colors.accentSoft, width: 1 },
        padding,
      }),
    );
    shapes.push(
      textShape({
        id: `s${index + 1}-${side}-heading`,
        role: "subheading",
        position: {
          left: card.left + padding.left,
          top: card.top + padding.top,
          width: card.width - padding.left - padding.right,
          height: 76,
        },
        value: slide[side].heading,
        style: { color: sideIndex === 0 ? theme.colors.muted : theme.colors.accent },
        theme,
        defaultBold: true,
        fit: { preferredSizePt: 20, minSizePt: 16, maxLines: 2, lineHeight: 1 },
      }),
    );
    shapes.push(
      textShape({
        id: `s${index + 1}-${side}-body`,
        role: "body",
        position: {
          left: card.left + padding.left,
          top: card.top + padding.top + 100,
          width: card.width - padding.left - padding.right,
          height: card.height - padding.top - padding.bottom - 100,
        },
        value: slide[side].body,
        style: { color: theme.colors.text },
        theme,
        fit: { preferredSizePt: 24, minSizePt: 16, maxLines: 8, lineHeight: 1.22 },
      }),
    );
  });
  return shapes;
}

export function compileDeck(input) {
  const spec = validateDeckSpec(structuredClone(input));
  const canvas = { ...DEFAULT_CANVAS, ...(spec.canvas ?? {}) };
  const margin = spec.layout?.margin ?? DEFAULT_LAYOUT.margin;
  const frame = {
    left: margin,
    top: margin,
    width: canvas.width - 2 * margin,
    height: canvas.height - 2 * margin,
  };
  const theme = mergeTheme(spec.theme);
  const slides = spec.slides.map((slide, index) => ({
    id: slide.id ?? `slide-${index + 1}`,
    layout: slide.layout,
    background: theme.colors.background,
    frame,
    shapes:
      slide.layout === "hero"
        ? compileHero(slide, index, frame, theme)
        : compileTwoColumn(slide, index, frame, theme),
  }));

  const plan = {
    schemaVersion: VERSION,
    generator: "slidewright",
    source: { title: spec.title },
    canvas,
    layout: {
      ...DEFAULT_LAYOUT,
      ...(spec.layout ?? {}),
      margin,
      approvedFontSizesPt: [...COMMON_FONT_SIZES_PT],
    },
    theme,
    slides,
  };
  plan.build = { deterministicHash: stableHash(plan) };
  return plan;
}
