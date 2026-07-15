import { COMMON_FONT_SIZES_PT } from "./tokens.mjs";

const PT_TO_PX = 96 / 72;

export function normalizeRuns(value, defaultBold = false) {
  if (typeof value === "string") {
    return [{ text: value, bold: defaultBold }];
  }
  if (!value || !Array.isArray(value.runs)) {
    throw new Error("Text must be a string or an object with a runs array.");
  }
  return value.runs.map((run, index) => {
    if (!run || typeof run.text !== "string") {
      throw new Error(`Text run ${index} must contain a string 'text' value.`);
    }
    return {
      text: run.text,
      bold: run.bold ?? defaultBold,
      italic: run.italic ?? false,
      color: run.color,
    };
  });
}

export function textFromRuns(runs) {
  return runs.map((run) => run.text).join("");
}

function estimateWrappedLines(text, availableWidthPx, fontSizePt, glyphFactor) {
  if (!text) return 0;
  const averageGlyphWidthPx = fontSizePt * PT_TO_PX * glyphFactor;
  const maxUnits = Math.max(1, Math.floor(availableWidthPx / averageGlyphWidthPx));
  let lines = 1;
  let used = 0;

  for (const rawWord of text.split(/\s+/u)) {
    const word = rawWord || " ";
    const units = word.length;
    if (units > maxUnits) {
      const remaining = Math.max(0, maxUnits - used);
      const overflow = Math.max(0, units - remaining);
      lines += Math.ceil(overflow / maxUnits);
      used = overflow % maxUnits;
      continue;
    }
    const required = units + (used > 0 ? 1 : 0);
    if (used + required > maxUnits) {
      lines += 1;
      used = units;
    } else {
      used += required;
    }
  }
  return lines;
}

export function measureText({
  text,
  width,
  height,
  fontSizePt,
  lineHeight = 1.16,
  insets = { top: 0, right: 0, bottom: 0, left: 0 },
  glyphFactor = 0.52,
  maxLines,
}) {
  const availableWidth = Math.max(1, width - insets.left - insets.right);
  const availableHeight = Math.max(1, height - insets.top - insets.bottom);
  const lines = estimateWrappedLines(text, availableWidth, fontSizePt, glyphFactor);
  const lineHeightPx = fontSizePt * PT_TO_PX * lineHeight;
  const estimatedHeight = lines * lineHeightPx;
  const heightFits = estimatedHeight <= availableHeight + 0.5;
  const lineCountFits = maxLines == null || lines <= maxLines;
  return {
    fits: heightFits && lineCountFits,
    lines,
    estimatedHeight: Number(estimatedHeight.toFixed(2)),
    availableHeight,
  };
}

export function fitText({
  text,
  width,
  height,
  preferredSizePt,
  minSizePt,
  allowedSizes = COMMON_FONT_SIZES_PT,
  lineHeight = 1.16,
  insets,
  glyphFactor,
  maxLines,
}) {
  const candidates = [...allowedSizes]
    .filter((size) => Number.isInteger(size) && size <= preferredSizePt && size >= minSizePt)
    .sort((a, b) => b - a);

  if (candidates.length === 0) {
    throw new Error(`No approved font sizes exist between ${minSizePt}pt and ${preferredSizePt}pt.`);
  }

  for (const fontSizePt of candidates) {
    const measurement = measureText({
      text,
      width,
      height,
      fontSizePt,
      lineHeight,
      insets,
      glyphFactor,
      maxLines,
    });
    if (measurement.fits) {
      return { ...measurement, fontSizePt, minSizePt, preferredSizePt, autoSized: fontSizePt !== preferredSizePt };
    }
  }

  const fontSizePt = candidates.at(-1);
  return {
    ...measureText({
      text,
      width,
      height,
      fontSizePt,
      lineHeight,
      insets,
      glyphFactor,
      maxLines,
    }),
    fontSizePt,
    minSizePt,
    preferredSizePt,
    autoSized: fontSizePt !== preferredSizePt,
  };
}
