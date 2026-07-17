import { COMMON_FONT_SIZES_PT } from "./tokens.mjs";

const PT_TO_PX = 96 / 72;

function finiteSpacing(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${label} must be a finite nonnegative point value.`);
  return resolved;
}

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

export function normalizeParagraphs(value, defaultBold = false, spacing = {}) {
  if (!value || !Array.isArray(value.paragraphs)) {
    const runs = normalizeRuns(value, defaultBold);
    return {
      paragraphs: [{
        runs, bullet: false, level: 0,
        spaceBeforePt: finiteSpacing(undefined, spacing.beforePt ?? 0, "Paragraph spaceBeforePt"),
        spaceAfterPt: finiteSpacing(undefined, spacing.afterPt ?? 0, "Paragraph spaceAfterPt"),
      }],
      removedEmptyParagraphs: 0,
    };
  }
  const paragraphs = [];
  let removedEmptyParagraphs = 0;
  value.paragraphs.forEach((paragraph, index) => {
    if (!paragraph || !Array.isArray(paragraph.runs)) throw new Error(`Paragraph ${index} must contain a runs array.`);
    const runs = normalizeRuns({ runs: paragraph.runs }, defaultBold);
    if (textFromRuns(runs).replace(/[\u00a0\s]/gu, "") === "") {
      removedEmptyParagraphs += 1;
      return;
    }
    const level = paragraph.level ?? 0;
    if (!Number.isInteger(level) || level < 0 || level > 4) throw new Error(`Paragraph ${index} level must be an integer from 0 to 4.`);
    paragraphs.push({
      runs,
      bullet: paragraph.bullet === true,
      level,
      spaceBeforePt: finiteSpacing(paragraph.spaceBeforePt, spacing.beforePt ?? 0, `Paragraph ${index} spaceBeforePt`),
      spaceAfterPt: finiteSpacing(paragraph.spaceAfterPt, spacing.betweenPt ?? spacing.afterPt ?? 0, `Paragraph ${index} spaceAfterPt`),
      explicitSpaceAfter: paragraph.spaceAfterPt != null,
    });
  });
  if (!paragraphs.length) throw new Error("Text content cannot become empty after paragraph hygiene.");
  const last = paragraphs.at(-1);
  if (!last.explicitSpaceAfter) last.spaceAfterPt = finiteSpacing(undefined, spacing.afterPt ?? 0, "Final paragraph spaceAfterPt");
  for (const paragraph of paragraphs) delete paragraph.explicitSpaceAfter;
  return { paragraphs, removedEmptyParagraphs };
}

export function paragraphSpacingHeightPx(paragraphs = []) {
  return paragraphs.reduce(
    (total, paragraph) => total + (Number(paragraph.spaceBeforePt ?? 0) + Number(paragraph.spaceAfterPt ?? 0)) * PT_TO_PX,
    0,
  );
}

export function flattenParagraphs(paragraphs) {
  const runs = [];
  paragraphs.forEach((paragraph, index) => {
    if (index > 0) runs.push({ text: "\n", bold: false, italic: false });
    if (paragraph.bullet) runs.push({ text: `${"  ".repeat(paragraph.level)}\u2022 `, bold: false, italic: false });
    runs.push(...paragraph.runs);
  });
  return runs;
}

function estimateWrappedLines(text, availableWidthPx, fontSizePt, glyphFactor) {
  if (!text) return 0;
  const averageGlyphWidthPx = fontSizePt * PT_TO_PX * glyphFactor;
  const maxUnits = Math.max(1, Math.floor(availableWidthPx / averageGlyphWidthPx));
  return text.split(/\r?\n/u).reduce((total, explicitLine) => {
    let lines = 1;
    let used = 0;
    for (const rawWord of explicitLine.split(/\s+/u)) {
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
    return total + lines;
  }, 0);
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
  paragraphs,
}) {
  const availableWidth = Math.max(1, width - insets.left - insets.right);
  const availableHeight = Math.max(1, height - insets.top - insets.bottom);
  const lines = estimateWrappedLines(text, availableWidth, fontSizePt, glyphFactor);
  const lineHeightPx = fontSizePt * PT_TO_PX * lineHeight;
  const estimatedHeight = lines * lineHeightPx + paragraphSpacingHeightPx(paragraphs);
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
  paragraphs,
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
      paragraphs,
    });
    if (measurement.fits) {
      return { ...measurement, fontSizePt, minSizePt, preferredSizePt, maxLines, glyphFactor: glyphFactor ?? 0.52, autoSized: fontSizePt !== preferredSizePt };
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
      paragraphs,
    }),
    fontSizePt,
    minSizePt,
    preferredSizePt,
    maxLines,
    glyphFactor: glyphFactor ?? 0.52,
    autoSized: fontSizePt !== preferredSizePt,
  };
}
