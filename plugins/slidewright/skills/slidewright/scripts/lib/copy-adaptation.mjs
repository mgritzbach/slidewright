import { createHash } from "node:crypto";
import { compileDeck } from "./compiler.mjs";
import { lintPlan } from "./linter.mjs";
import { fitText, flattenParagraphs, normalizeParagraphs, textFromRuns } from "./typography.mjs";

const SCHEMA_VERSION = "slidewright-copy-adaptation/v1";

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getPath(value, path) {
  return path.reduce((current, key) => current?.[key], value);
}

function setPath(value, path, replacement) {
  let current = value;
  for (const key of path.slice(0, -1)) current = current[key];
  current[path.at(-1)] = replacement;
}

function sameStyle(left, right) {
  return left.bold === right.bold
    && left.italic === right.italic
    && left.color === right.color;
}

function tokenizeText(value, defaultBold = false) {
  const normalized = normalizeParagraphs(value, defaultBold);
  const words = [];
  normalized.paragraphs.forEach((paragraph, paragraphIndex) => {
    for (const run of paragraph.runs) {
      for (const match of run.text.matchAll(/[^\s]+/gu)) {
        words.push({
          text: match[0],
          bold: run.bold === true,
          italic: run.italic === true,
          ...(run.color ? { color: run.color } : {}),
          paragraphIndex,
          bullet: paragraph.bullet === true,
          level: Number.isInteger(paragraph.level) ? paragraph.level : 0,
        });
      }
    }
  });
  if (!words.length) throw new Error("Adaptive copy cannot split empty text.");
  return { words };
}

function sliceText(model, start, end) {
  const selected = model.words.slice(start, end);
  if (!selected.length) throw new Error("Adaptive copy produced an empty chunk.");
  const paragraphs = [];
  let sourceParagraph = null;
  let outputParagraph = null;
  for (const word of selected) {
    if (word.paragraphIndex !== sourceParagraph) {
      sourceParagraph = word.paragraphIndex;
      outputParagraph = { runs: [], bullet: word.bullet, level: word.level };
      paragraphs.push(outputParagraph);
    }
    const style = { bold: word.bold, italic: word.italic, ...(word.color ? { color: word.color } : {}) };
    const previous = outputParagraph.runs.at(-1);
    const prefix = outputParagraph.runs.length ? " " : "";
    if (previous && sameStyle(previous, style)) previous.text += `${prefix}${word.text}`;
    else outputParagraph.runs.push({ text: `${prefix}${word.text}`, ...style });
  }
  return { paragraphs };
}

function textSignature(value, defaultBold = false) {
  const model = tokenizeText(value, defaultBold);
  return {
    wordCount: model.words.length,
    sha256: sha256(model.words.map((word) => ({
      text: word.text,
      bold: word.bold,
      italic: word.italic,
      color: word.color ?? null,
      paragraphIndex: word.paragraphIndex,
      bullet: word.bullet,
      level: word.level,
    }))),
  };
}

function normalizedWordRecords(value, defaultBold = false) {
  return tokenizeText(value, defaultBold).words.map((word) => ({
    text: word.text,
    bold: word.bold,
    italic: word.italic,
    color: word.color ?? null,
    bullet: word.bullet,
    level: word.level,
  }));
}

function valueFitsShape(value, shape, defaultBold) {
  const paragraphs = normalizeParagraphs(value, defaultBold).paragraphs;
  const measurement = fitText({
    text: textFromRuns(flattenParagraphs(paragraphs)),
    width: shape.position.width,
    height: shape.position.height,
    preferredSizePt: shape.fit.preferredSizePt,
    minSizePt: shape.fit.minSizePt,
    lineHeight: shape.style.lineHeight,
    insets: shape.style.insets,
    glyphFactor: shape.fit.glyphFactor,
    maxLines: shape.fit.maxLines,
  });
  return measurement.fits;
}

function maximumPrefix(model, start, shape, defaultBold) {
  let low = 1;
  let high = model.words.length - start;
  let best = 0;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const candidate = sliceText(model, start, start + size);
    if (valueFitsShape(candidate, shape, defaultBold)) {
      best = size;
      low = size + 1;
    } else {
      high = size - 1;
    }
  }
  if (best === 0) throw new Error(`Adaptive copy cannot fit the next word '${model.words[start].text}' above the configured quality floor.`);
  return best;
}

function splitForShapes(value, firstShape, continuationShape, defaultBold) {
  if (valueFitsShape(value, firstShape, defaultBold)) return [value];
  const model = tokenizeText(value, defaultBold);
  const greedy = [];
  let start = 0;
  let shape = firstShape;
  while (start < model.words.length) {
    const count = maximumPrefix(model, start, shape, defaultBold);
    greedy.push(sliceText(model, start, start + count));
    start += count;
    shape = continuationShape;
  }
  if (greedy.length < 2) return greedy;

  const balanced = [];
  start = 0;
  for (let index = 0; index < greedy.length; index += 1) {
    const targetShape = index === 0 ? firstShape : continuationShape;
    const chunksLeft = greedy.length - index;
    const wordsLeft = model.words.length - start;
    if (chunksLeft === 1) {
      const remainder = sliceText(model, start, model.words.length);
      if (!valueFitsShape(remainder, targetShape, defaultBold)) return greedy;
      balanced.push(remainder);
      break;
    }
    const maximum = maximumPrefix(model, start, targetShape, defaultBold);
    const evenShare = Math.ceil(wordsLeft / chunksLeft);
    const count = Math.min(maximum, evenShare);
    balanced.push(sliceText(model, start, start + count));
    start += count;
  }
  return balanced;
}

function descriptorsFor(slide) {
  if (slide.layout === "hero") return [
    { key: "body", label: "BODY", path: ["body"], shapeId: "s1-body", defaultBold: false },
    { key: "callout", label: "CALLOUT", path: ["callout"], shapeId: "s1-callout", defaultBold: true },
  ];
  if (slide.layout === "two-column") return [
    { key: "left-body", label: "LEFT COLUMN", path: ["left", "body"], shapeId: "s1-left-body", defaultBold: false },
    { key: "right-body", label: "RIGHT COLUMN", path: ["right", "body"], shapeId: "s1-right-body", defaultBold: false },
  ];
  if (slide.layout === "section") return [
    { key: "subtitle", label: "DETAIL", path: ["subtitle"], shapeId: "s1-subtitle", defaultBold: false },
  ];
  if (slide.layout === "icon-list") return (slide.items ?? []).map((item, index) => ({
    key: `item-${item.id ?? index + 1}`,
    label: `${item.label ?? "ITEM"}`.toUpperCase(),
    path: ["items", index, "body"],
    shapeId: `s1-${item.id ?? `item-${index + 1}`}-body`,
    defaultBold: false,
  }));
  if (["point-grid", "polygon-cycle"].includes(slide.layout)) return (slide.items ?? []).map((item, index) => ({
    key: `point-${item.id ?? index + 1}`,
    label: `${item.label ?? "POINT"}`.toUpperCase(),
    path: ["items", index, "body"],
    shapeId: `s1-${item.id ?? `point-${index + 1}`}-body`,
    defaultBold: false,
  }));
  if (slide.layout === "opposition") return [
    { key: "left-body", label: "LEFT POSITION", path: ["left", "body"], shapeId: "s1-left-body", defaultBold: false },
    { key: "right-body", label: "RIGHT POSITION", path: ["right", "body"], shapeId: "s1-right-body", defaultBold: false },
    ...(slide.synthesis == null ? [] : [{ key: "synthesis", label: "SYNTHESIS", path: ["synthesis"], shapeId: "s1-synthesis", defaultBold: true }]),
  ];
  // Table cells are validated cell-by-cell by the compiler and linter. They
  // cannot be moved into prose continuation slides without changing semantics.
  if (slide.layout === "table") return [];
  return [{ key: "body", label: "BODY", path: ["body"], shapeId: "s1-body", defaultBold: false }];
}

function singleSlideSpec(spec, slide) {
  return { ...structuredClone(spec), slides: [structuredClone(slide)] };
}

function continuationPrototype(spec, sourceSlide) {
  const slide = {
    id: "copy-adaptation-prototype",
    layout: "continuation",
    eyebrow: "CONTINUED",
    title: sourceSlide.title,
    body: "probe",
    ...(sourceSlide.topicId ? { topicId: sourceSlide.topicId, coverageRole: "substantive" } : {}),
  };
  const plan = compileDeck(singleSlideSpec(spec, slide));
  const title = plan.slides[0].shapes.find((shape) => shape.id === "s1-title");
  const body = plan.slides[0].shapes.find((shape) => shape.id === "s1-body");
  if (!title?.fit?.fits) throw new Error(`Slide '${sourceSlide.id ?? "<unnamed>"}' has a title that cannot fit a continuation slide above the quality floor.`);
  return body;
}

export function adaptDeckCopyToFit(input, { maxSlides = 200 } = {}) {
  if (!Number.isInteger(maxSlides) || maxSlides < 1) throw new Error("maxSlides must be a positive integer.");
  const source = structuredClone(input);
  compileDeck(source);
  const adapted = structuredClone(source);
  adapted.slides = [];
  const fields = [];

  source.slides.forEach((sourceSlide, sourceIndex) => {
    const sourceId = sourceSlide.id ?? `slide-${sourceIndex + 1}`;
    const originalPlan = compileDeck(singleSlideSpec(source, sourceSlide)).slides[0];
    const descriptors = descriptorsFor(sourceSlide);
    const flexibleShapeIds = new Set(descriptors.map((descriptor) => descriptor.shapeId));
    const blocked = originalPlan.shapes.filter((shape) => shape.type === "text" && shape.fit?.fits === false && !flexibleShapeIds.has(shape.id));
    if (blocked.length) throw new Error(`Slide '${sourceId}' has non-splittable text below the quality floor: ${blocked.map((shape) => shape.id).join(", ")}.`);
    const continuationShape = descriptors.length ? continuationPrototype(source, sourceSlide) : null;
    const original = structuredClone(sourceSlide);
    const continuations = [];

    for (const descriptor of descriptors) {
      const shape = originalPlan.shapes.find((candidate) => candidate.id === descriptor.shapeId);
      if (!shape) throw new Error(`Slide '${sourceId}' is missing adaptive target '${descriptor.shapeId}'.`);
      const sourceValue = getPath(sourceSlide, descriptor.path);
      const chunks = splitForShapes(sourceValue, shape, continuationShape, descriptor.defaultBold);
      if (chunks.length > 1) setPath(original, descriptor.path, chunks[0]);
      const locations = [{ slideId: sourceId, fieldPath: descriptor.path.join(".") }];
      chunks.slice(1).forEach((chunk, chunkIndex) => {
        const continuationId = `${sourceId}--${descriptor.key}-${chunkIndex + 1}`;
        continuations.push({
          id: continuationId,
          layout: "continuation",
          eyebrow: `CONTINUED · ${descriptor.label}`,
          title: sourceSlide.title,
          body: chunk,
          adaptation: { sourceSlideId: sourceId, sourceField: descriptor.path.join("."), chunkIndex: chunkIndex + 2, chunkCount: chunks.length },
          ...(sourceSlide.topicId ? { topicId: sourceSlide.topicId, coverageRole: "substantive" } : {}),
        });
        locations.push({ slideId: continuationId, fieldPath: "body" });
      });
      fields.push({
        sourceSlideId: sourceId,
        sourceField: descriptor.path.join("."),
        defaultBold: descriptor.defaultBold,
        ...textSignature(sourceValue, descriptor.defaultBold),
        chunkCount: chunks.length,
        locations,
      });
    }
    adapted.slides.push(original, ...continuations);
    if (adapted.slides.length > maxSlides) throw new Error(`Adaptive copy exceeded the ${maxSlides}-slide safety ceiling.`);
  });

  const plan = compileDeck(adapted);
  const lint = lintPlan(plan);
  if (!lint.valid) throw new Error(`Adaptive copy did not close the layout contract: ${lint.diagnostics.map((item) => `${item.ruleId} ${item.message}`).join("; ")}`);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    sourceSha256: sha256(source),
    adaptedSha256: sha256(adapted),
    sourceSlideCount: source.slides.length,
    adaptedSlideCount: adapted.slides.length,
    continuationSlideCount: adapted.slides.length - source.slides.length,
    maxSlides,
    fields,
  };
  return { spec: adapted, manifest, plan };
}

export function auditAdaptedDeckCopy(source, adapted, manifest, plan) {
  const diagnostics = [];
  const add = (code, message) => diagnostics.push({ code, message });
  let expected;
  try {
    expected = adaptDeckCopyToFit(source, { maxSlides: manifest?.maxSlides });
  } catch (error) {
    return { schemaVersion: "slidewright-copy-adaptation-audit/v1", valid: false, diagnostics: [{ code: "CA900", message: error.message }], lintRuleIds: [] };
  }
  if (manifest?.schemaVersion !== SCHEMA_VERSION) add("CA000", "Adaptation manifest schema is missing or unsupported.");
  if (!jsonEqual(adapted, expected.spec)) add("CA001", "Adapted specification does not match an independent deterministic recomputation.");
  if (!jsonEqual(manifest, expected.manifest)) add("CA002", "Adaptation manifest does not match source content and chunk ownership.");
  if (!jsonEqual(plan, expected.plan)) add("CA003", "Compiled plan does not match the independently recomputed adapted specification.");

  for (const field of expected.manifest.fields) {
    const sourceSlide = source.slides.find((slide, index) => (slide.id ?? `slide-${index + 1}`) === field.sourceSlideId);
    const sourceValue = sourceSlide ? getPath(sourceSlide, field.sourceField.split(".")) : null;
    const sourceWords = sourceValue == null ? [] : normalizedWordRecords(sourceValue, field.defaultBold);
    const adaptedWords = [];
    let complete = true;
    for (const location of field.locations) {
      const target = adapted.slides.find((slide) => slide.id === location.slideId);
      const value = target ? getPath(target, location.fieldPath.split(".")) : null;
      if (value == null) { complete = false; break; }
      adaptedWords.push(...normalizedWordRecords(value, field.defaultBold));
    }
    if (!complete || !jsonEqual(sourceWords, adaptedWords)) add("CA004", `Normalized word content or per-word formatting drifted for ${field.sourceSlideId}.${field.sourceField}.`);
  }
  const lint = lintPlan(plan);
  const lintRuleIds = [...new Set(lint.diagnostics.map((item) => item.ruleId))].sort();
  if (!lint.valid || lint.counts.warning !== 0) add("CA005", "Adapted plan does not close the zero-warning layout contract.");
  return {
    schemaVersion: "slidewright-copy-adaptation-audit/v1",
    valid: diagnostics.length === 0,
    diagnostics,
    lintRuleIds,
    sourceSha256: expected.manifest.sourceSha256,
    adaptedSha256: expected.manifest.adaptedSha256,
    sourceSlideCount: expected.manifest.sourceSlideCount,
    adaptedSlideCount: expected.manifest.adaptedSlideCount,
    continuationSlideCount: expected.manifest.continuationSlideCount,
    fieldCount: expected.manifest.fields.length,
    wordCount: expected.manifest.fields.reduce((sum, field) => sum + field.wordCount, 0),
  };
}

export { SCHEMA_VERSION as COPY_ADAPTATION_SCHEMA_VERSION, textSignature as copyTextSignature, normalizedWordRecords as copyWordRecords };
