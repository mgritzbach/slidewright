const HEX = /^#[0-9a-f]{6}$/iu;
const ALIGNMENTS = new Set(["left", "center", "right"]);
const VERTICAL_ALIGNMENTS = new Set(["top", "middle", "bottom"]);
const GEOMETRIES = new Set(["rect", "ellipse", "line", "textbox"]);

function assert(condition, message) {
  if (!condition) throw new Error(`Invalid observed design: ${message}`);
}

function finite(value, label, { min = -Infinity, max = Infinity } = {}) {
  assert(Number.isFinite(value), `${label} must be a finite number.`);
  assert(value >= min && value <= max, `${label} must be between ${min} and ${max}.`);
}

function color(value, label, { allowNone = false } = {}) {
  assert((allowNone && value === "none") || HEX.test(value), `${label} must be a six-digit hex color${allowNone ? " or 'none'" : ""}.`);
}

function validateBbox(bbox, label) {
  assert(bbox && typeof bbox === "object", `${label} is required.`);
  assert(bbox.units === "normalized", `${label}.units must be 'normalized'.`);
  for (const key of ["left", "top", "width", "height"]) finite(bbox[key], `${label}.${key}`, { min: 0, max: 1 });
  assert(bbox.width > 0 && bbox.height > 0, `${label} must have positive width and height.`);
  assert(bbox.left + bbox.width <= 1.000001, `${label} exceeds the canvas horizontally.`);
  assert(bbox.top + bbox.height <= 1.000001, `${label} exceeds the canvas vertically.`);
}

function validateRuns(object) {
  const text = object.text;
  assert(text && typeof text === "object", `${object.id}.text is required.`);
  assert(typeof text.value === "string" && text.value.length > 0, `${object.id}.text.value must be non-empty.`);
  assert(Array.isArray(text.runs) && text.runs.length > 0, `${object.id}.text.runs must be non-empty.`);
  assert(text.runs.map((run) => run.text).join("") === text.value, `${object.id}.text.runs must exactly reconstruct text.value.`);
  assert(ALIGNMENTS.has(text.alignment), `${object.id}.text.alignment is invalid.`);
  assert(VERTICAL_ALIGNMENTS.has(text.verticalAlignment), `${object.id}.text.verticalAlignment is invalid.`);
  assert(typeof text.fontFamilyGuess === "string" && text.fontFamilyGuess.trim(), `${object.id}.text.fontFamilyGuess is required.`);
  finite(text.fontSizePtGuess, `${object.id}.text.fontSizePtGuess`, { min: 8, max: 96 });
  assert(Number.isInteger(text.fontSizePtGuess), `${object.id}.text.fontSizePtGuess must be an integer point size.`);
  color(text.color, `${object.id}.text.color`);
  finite(text.lineHeight ?? 1, `${object.id}.text.lineHeight`, { min: 0.8, max: 2 });
  const insets = text.insets ?? { left: 0, top: 0, right: 0, bottom: 0 };
  for (const key of ["left", "top", "right", "bottom"]) finite(insets[key], `${object.id}.text.insets.${key}`, { min: 0, max: 100 });
  for (const [index, run] of text.runs.entries()) {
    assert(typeof run.text === "string", `${object.id}.text.runs[${index}].text must be a string.`);
    const size = run.fontSizePtGuess ?? text.fontSizePtGuess;
    finite(size, `${object.id}.text.runs[${index}].fontSizePtGuess`, { min: 8, max: 96 });
    assert(Number.isInteger(size), `${object.id}.text.runs[${index}].fontSizePtGuess must be an integer point size.`);
    color(run.color ?? text.color, `${object.id}.text.runs[${index}].color`);
  }
}

export function validateObservedDesign(value) {
  assert(value && typeof value === "object", "root must be an object.");
  assert(value.version === "0.1", "version must be '0.1'.");
  assert(value.input && /^[0-9a-f]{64}$/iu.test(value.input.sha256), "input.sha256 must be a SHA-256 digest.");
  finite(value.input.widthPx, "input.widthPx", { min: 1 });
  finite(value.input.heightPx, "input.heightPx", { min: 1 });
  assert(value.canvas?.width === value.input.widthPx && value.canvas?.height === value.input.heightPx, "canvas dimensions must equal the observed input dimensions.");
  color(value.canvas.background, "canvas.background");
  assert(Array.isArray(value.objects) && value.objects.length >= 1, "objects must be non-empty.");
  const ids = new Set();
  for (const object of value.objects) {
    assert(typeof object.id === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(object.id), "every object needs a stable lowercase id.");
    assert(!ids.has(object.id), `duplicate object id '${object.id}'.`);
    ids.add(object.id);
    assert(["shape", "text"].includes(object.type), `${object.id}.type must be shape or text.`);
    validateBbox(object.bbox, `${object.id}.bbox`);
    finite(object.rotationDeg ?? 0, `${object.id}.rotationDeg`, { min: -360, max: 360 });
    assert(Number.isInteger(object.zIndex), `${object.id}.zIndex must be an integer.`);
    assert(object.editable === true, `${object.id}.editable must be true.`);
    assert(object.confidence && typeof object.confidence === "object" && !Array.isArray(object.confidence), `${object.id}.confidence must be an object.`);
    if (object.type === "shape") {
      assert(GEOMETRIES.has(object.shape?.geometry), `${object.id}.shape.geometry is invalid.`);
      color(object.shape.fill, `${object.id}.shape.fill`, { allowNone: true });
      color(object.shape.line?.color ?? "none", `${object.id}.shape.line.color`, { allowNone: true });
      finite(object.shape.line?.width ?? 0, `${object.id}.shape.line.width`, { min: 0, max: 24 });
      finite(object.shape.radiusPx ?? 0, `${object.id}.shape.radiusPx`, { min: 0, max: 100 });
    } else {
      validateRuns(object);
    }
    for (const key of ["text", "geometry", "style"]) {
      if (object.confidence?.[key] !== undefined) finite(object.confidence[key], `${object.id}.confidence.${key}`, { min: 0, max: 1 });
    }
  }
  const zIndexes = value.objects.map((object) => object.zIndex);
  assert(new Set(zIndexes).size === zIndexes.length, "zIndex values must be unique to preserve deterministic stacking order.");
  return value;
}

export function toArtifactPosition(bbox, canvas, rotationDeg = 0) {
  return {
    left: bbox.left * canvas.width,
    top: bbox.top * canvas.height,
    width: bbox.width * canvas.width,
    height: bbox.height * canvas.height,
    rotation: rotationDeg,
  };
}

export function toFontAuditPlan(design) {
  return {
    theme: { fontFamily: "Arial", fallbackFontFamily: "Arial" },
    slides: [{ shapes: design.objects.filter((object) => object.type === "text").map((object) => ({
      type: "text",
      style: { typeface: object.text.fontFamilyGuess },
      text: { runs: object.text.runs.map((run) => ({ typeface: run.fontFamilyGuess ?? object.text.fontFamilyGuess })) },
    })) }],
  };
}
