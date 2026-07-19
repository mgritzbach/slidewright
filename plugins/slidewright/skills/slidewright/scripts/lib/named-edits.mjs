import { createHash } from "node:crypto";
import { fitText, textFromRuns } from "./typography.mjs";
import { lintPlan } from "./linter.mjs";

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}
export function planContentHash(plan) {
  const clone = structuredClone(plan);
  delete clone.build;
  return canonicalHash(clone);
}


function objectIndex(plan) {
  const index = new Map();
  for (const slide of plan.slides ?? []) {
    for (const shape of slide.shapes ?? []) {
      if (index.has(shape.id)) throw new Error(`Named object '${shape.id}' is not unique.`);
      index.set(shape.id, { slide, shape });
    }
  }
  return index;
}

export function fingerprintNamedObjects(plan) {
  return Object.fromEntries([...objectIndex(plan)].sort(([a], [b]) => a.localeCompare(b)).map(([id, entry]) => [id, canonicalHash(entry.shape)]));
}

function requireTarget(index, id, expectedType = null) {
  const entry = index.get(id);
  if (!entry) throw new Error(`Named edit target '${id}' does not exist.`);
  if (expectedType && entry.shape.type !== expectedType) throw new Error(`Named edit target '${id}' must be ${expectedType}, found ${entry.shape.type}.`);
  return entry;
}

function recomputeFit(shape) {
  const preferredSizePt = shape.fit?.preferredSizePt ?? shape.style.fontSizePt;
  const fit = fitText({
    text: textFromRuns(shape.text.runs),
    width: shape.position.width,
    height: shape.position.height,
    preferredSizePt,
    minSizePt: shape.fit?.minSizePt ?? preferredSizePt,
    maxLines: shape.fit?.maxLines ?? Number.POSITIVE_INFINITY,
    lineHeight: shape.style.lineHeight,
    glyphFactor: shape.fit?.glyphFactor,
  });
  shape.fit = fit;
  shape.style.fontSizePt = fit.fontSizePt;
}

function correspondingParagraphRun(shape, flatRunIndex) {
  let cursor = 0;
  for (const [paragraphIndex, paragraph] of (shape.text?.paragraphs ?? []).entries()) {
    if (paragraphIndex > 0) cursor += 1;
    if (paragraph.bullet === true) cursor += 1;
    for (const run of paragraph.runs ?? []) {
      if (cursor === flatRunIndex) return run;
      cursor += 1;
    }
  }
  return null;
}

function numericPatch(position, patch, id) {
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!["left", "top", "width", "height", "rotation"].includes(key) || !Number.isFinite(value)) throw new Error(`Invalid position patch '${key}' for '${id}'.`);
    position[key] = value;
  }
}
function applyTwoColumnGap(index, plan, edit) {
  const slide = plan.slides.find((candidate) => candidate.id === edit.slideId);
  if (!slide || slide.layoutContract?.type !== "two-column") throw new Error(`Layout edit slide '${edit.slideId}' is not a named two-column layout.`);
  const gap = Number(edit.columnGap);
  if (!Number.isFinite(gap) || gap < 16 || gap > 96) throw new Error("Two-column layout gap must be between 16 and 96 pixels.");
  const frame = slide.frame;
  const cardTop = frame.top + 164;
  const cardWidth = (frame.width - gap) / 2;
  const cardHeight = frame.height - 164;
  const changed = [];
  for (const [sideIndex, side] of ["left", "right"].entries()) {
    const prefix = `s${plan.slides.indexOf(slide) + 1}-${side}`;
    const surface = requireTarget(index, `${prefix}-surface`, "shape").shape;
    const heading = requireTarget(index, `${prefix}-heading`, "text").shape;
    const body = requireTarget(index, `${prefix}-body`, "text").shape;
    const padding = surface.padding;
    const left = frame.left + sideIndex * (cardWidth + gap);
    surface.position = { left, top: cardTop, width: cardWidth, height: cardHeight };
    heading.position = { left: left + padding.left, top: cardTop + padding.top, width: cardWidth - padding.left - padding.right, height: 76 };
    body.position = {
      left: left + padding.left,
      top: cardTop + padding.top + 100,
      width: cardWidth - padding.left - padding.right,
      height: cardHeight - padding.top - padding.bottom - 100,
    };
    recomputeFit(heading);
    recomputeFit(body);
    changed.push(surface.id, heading.id, body.id);
  }
  slide.layoutContract.columnGap = gap;
  return changed;
}

export function applyNamedEdits(inputPlan, edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("Named edits must be a non-empty array.");
  const plan = structuredClone(inputPlan);
  const index = objectIndex(plan);
  const changedIds = new Set();

  for (const edit of edits) {
    if (!edit || typeof edit !== "object") throw new Error("Each named edit must be an object.");
    if (edit.type === "text") {
      const { shape } = requireTarget(index, edit.targetId, "text");
      if (typeof edit.value !== "string" || !edit.value.trim()) throw new Error("Text edits require a non-empty value.");
      if (shape.text.runs.length !== 1) throw new Error(`Text edit target '${edit.targetId}' must have exactly one run in named-edits v1.`);
      shape.text.runs[0].text = edit.value;
      const paragraphRun = correspondingParagraphRun(shape, 0);
      if (paragraphRun) paragraphRun.text = edit.value;
      recomputeFit(shape);
      changedIds.add(shape.id);
      continue;
    }
    if (edit.type === "bold") {
      const { shape } = requireTarget(index, edit.targetId, "text");
      const runIndex = edit.runIndex ?? 0;
      if (!Number.isInteger(runIndex) || !shape.text.runs[runIndex]) throw new Error(`Bold edit run ${runIndex} does not exist on '${edit.targetId}'.`);
      if (typeof edit.value !== "boolean") throw new Error("Bold edits require a boolean value.");
      shape.text.runs[runIndex].bold = edit.value;
      const paragraphRun = correspondingParagraphRun(shape, runIndex);
      if (paragraphRun) paragraphRun.bold = edit.value;
      changedIds.add(shape.id);
      continue;
    }
    if (edit.type === "color") {
      const { shape } = requireTarget(index, edit.targetId);
      if (!/^#[0-9A-Fa-f]{6}$/u.test(edit.value ?? "")) throw new Error("Color edits require a six-digit hex value.");
      if (shape.type === "text") shape.style.color = edit.value.toUpperCase();
      else shape.fill = edit.value.toUpperCase();
      changedIds.add(shape.id);
      continue;
    }
    if (edit.type === "position") {
      const { shape } = requireTarget(index, edit.targetId);
      numericPatch(shape.position, edit.position, shape.id);
      if (shape.type === "text") recomputeFit(shape);
      changedIds.add(shape.id);
      continue;
    }
    if (edit.type === "chart") {
      const parent = requireTarget(index, edit.targetId, "shape").shape;
      if (parent.semanticType !== "chart-component") throw new Error(`Chart edit target '${edit.targetId}' must be a semantic chart component.`);
      const categories = parent.chart?.categories ?? [];
      const categoryIndex = categories.indexOf(edit.category);
      if (categoryIndex < 0) throw new Error(`Chart category '${edit.category}' does not exist on '${parent.id}'.`);
      const series = parent.chart?.series?.find((candidate) => candidate.id === edit.seriesId);
      if (!series || !Array.isArray(series.values) || series.values.length !== categories.length) throw new Error(`Chart series '${edit.seriesId}' is invalid on '${parent.id}'.`);
      const marks = [...index.values()].filter(({ shape }) => (
        shape.parentId === parent.id && shape.role === "chart-mark" && shape.chartSeriesId === series.id && shape.chartCategory === edit.category
      ));
      if (marks.length !== 1) throw new Error(`Chart category '${edit.category}' resolved to ${marks.length} named marks.`);
      const mark = marks[0].shape;
      const value = Number(edit.value);
      const maximum = Number(parent.chart.maximum);
      const extent = Number(parent.chart.plotExtentPx);
      if (!(value >= 0) || !(maximum > 0) || !(extent > 0) || value > maximum) throw new Error("Chart edits require 0 <= value <= maximum and a positive plotExtentPx.");
      series.values[categoryIndex] = value;
      if (parent.chart.orientation === "horizontal") {
        mark.position.width = Math.round((value / maximum) * extent);
      } else if (parent.chart.orientation === "vertical") {
        const bottom = mark.position.top + mark.position.height;
        mark.position.height = Math.round((value / maximum) * extent);
        mark.position.top = bottom - mark.position.height;
      } else {
        throw new Error(`Chart '${parent.id}' has no supported orientation.`);
      }
      mark.chartValue = value;
      changedIds.add(parent.id);
      changedIds.add(mark.id);
      continue;
    }
    if (edit.type === "layout") {
      const changed = applyTwoColumnGap(index, plan, edit);
      for (const id of changed) changedIds.add(id);
      continue;
    }
    throw new Error(`Unsupported named edit type '${edit.type}'.`);
  }

  const expectedChangedIds = [...changedIds].sort();
  const comparison = compareNamedFingerprints(inputPlan, plan, expectedChangedIds);
  if (!comparison.valid) throw new Error(`Named edit changed an unauthorized object or was a no-op: expected ${expectedChangedIds.join(", ")}; found ${comparison.actualChangedIds.join(", ")}.`);
  const quality = lintPlan(plan);
  if (!quality.valid) {
    const rules = [...new Set(quality.diagnostics.map((item) => item.ruleId))].sort();
    throw new Error(`Named edit violates the formatting contract: ${rules.join(", ")}.`);
  }
  plan.build = { deterministicHash: planContentHash(plan).slice(0, 16) };
  return { plan, changedIds: expectedChangedIds, comparison };
}

export function compareNamedFingerprints(beforePlan, afterPlan, expectedChangedIds) {
  const before = fingerprintNamedObjects(beforePlan);
  const after = fingerprintNamedObjects(afterPlan);
  const expected = [...new Set(expectedChangedIds)].sort();
  const beforeIds = Object.keys(before);
  const afterIds = Object.keys(after);
  if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) throw new Error("Named object inventory changed during an edit.");
  const changed = beforeIds.filter((id) => before[id] !== after[id]).sort();
  return {
    valid: JSON.stringify(changed) === JSON.stringify(expected),
    expectedChangedIds: expected,
    actualChangedIds: changed,
    unchangedCount: beforeIds.length - changed.length,
  };
}

export function applyNamedEditManifest(inputPlan, manifest) {
  if (manifest?.version !== "c16-v1" || !manifest.id || !manifest.edit) throw new Error("Named edit manifest must be a complete c16-v1 record.");
  const actualBaselineHash = planContentHash(inputPlan);
  if (manifest.baselinePlanHash !== actualBaselineHash) {
    throw new Error(`Stale baseline plan hash for '${manifest.id}': expected ${manifest.baselinePlanHash}, found ${actualBaselineHash}.`);
  }
  const result = applyNamedEdits(inputPlan, [manifest.edit]);
  return { ...result, manifestId: manifest.id, baselinePlanHash: actualBaselineHash };
}
