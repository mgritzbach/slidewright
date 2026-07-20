import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateDeckSpec } from "./compiler.mjs";

const CATALOG_PATH = fileURLToPath(new URL("../../assets/pattern-catalog/v1/catalog.json", import.meta.url));
const CATALOG_SCHEMA_VERSION = "slidewright-pattern-catalog/v1";
const ALLOWED_ARCHETYPES = new Set([
  "hero", "two-column", "section", "continuation", "table", "icon-list",
  "point-grid", "polygon-cycle", "opposition", "quadrant-focus", "chevron-flow", "icon-network",
]);
const STYLE_CLASSES = new Set(["classic-analytical", "contemporary-geometric", "bold-narrative"]);
const IMPLEMENTATION_LEVELS = new Set(["reviewed-release-candidate", "engine-backed-recipe", "structural-blueprint"]);
const REVIEW_STATUSES = new Set(["pass", "revise", "veto"]);
const ARCHETYPE_SEMANTIC_MARKS = Object.freeze({
  opposition: Object.freeze(["opposed-fields", "matched-dimensions", "synthesis-band"]),
  "polygon-cycle": Object.freeze(["regular-polygon", "central-outcome", "external-callouts", "single-focus"]),
});
const ALLOWED_VARIANT_KEYS = new Set(["arrangement", "relationship", "emphasisIndex"]);
const ALLOWED_CONTENT_KEYS = new Set([
  "title", "eyebrow", "body", "callout", "subtitle", "items", "left", "right",
  "synthesis", "center", "takeaway", "axisLabel", "table", "itemCount",
]);
const ICONS = [
  { conceptId: "goal", icon: "target" },
  { conceptId: "context", icon: "globe" },
  { conceptId: "constraints", icon: "shield" },
  { conceptId: "completion", icon: "check" },
];
const THEMES = Object.freeze({
  slate: Object.freeze({
    fontFamily: "Arial",
    colors: Object.freeze({
      background: "#FFFFFF", surface: "#FFFFFF", text: "#172033", muted: "#465166",
      subtle: "#8B95A7", accent: "#B71833", accentSoft: "#FBE9ED", border: "#D8DCE4", success: "#157347",
    }),
  }),
  midnight: Object.freeze({
    fontFamily: "Arial",
    colors: Object.freeze({
      background: "#F7F8FA", surface: "#FFFFFF", text: "#132238", muted: "#526074",
      subtle: "#97A1B1", accent: "#0E7490", accentSoft: "#E2F3F6", border: "#D6DCE5", success: "#18794E",
    }),
  }),
});

function fail(message) {
  throw new Error(`Pattern catalog: ${message}`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
}

function assertString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string.`);
}

function rejectCoordinates(value, label) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["x", "y", "left", "right", "top", "bottom", "width", "height", "position", "coordinates"].includes(key)) {
      fail(`${label} cannot inject coordinate key '${key}'.`);
    }
    rejectCoordinates(child, `${label}.${key}`);
  }
}

export function patternSemanticCoverage(pattern) {
  const required = pattern?.semanticSignature?.requiredMarks ?? [];
  const provided = new Set(ARCHETYPE_SEMANTIC_MARKS[pattern?.archetype] ?? []);
  const missing = required.filter((mark) => !provided.has(mark));
  return deepFreeze({
    required: [...required],
    provided: [...provided],
    missing,
    complete: missing.length === 0,
  });
}

export function validatePatternCatalog(catalog) {
  assertPlainObject(catalog, "catalog");
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) fail(`schemaVersion must be '${CATALOG_SCHEMA_VERSION}'.`);
  assertString(catalog.catalogVersion, "catalogVersion");
  if (!Array.isArray(catalog.patterns) || catalog.patterns.length !== 100) fail("catalog must contain exactly 100 patterns.");
  const ids = new Set();
  const ordinals = new Set();
  const styleCounts = { "classic-analytical": 0, "contemporary-geometric": 0, "bold-narrative": 0 };
  for (const [index, pattern] of catalog.patterns.entries()) {
    assertPlainObject(pattern, `patterns[${index}]`);
    assertString(pattern.id, `patterns[${index}].id`);
    if (!/^c\d{3}-[a-z0-9-]+$/u.test(pattern.id)) fail(`patterns[${index}].id is not stable.`);
    if (ids.has(pattern.id)) fail(`duplicate pattern id '${pattern.id}'.`);
    ids.add(pattern.id);
    if (!Number.isInteger(pattern.ordinal) || pattern.ordinal < 1 || pattern.ordinal > 100 || ordinals.has(pattern.ordinal)) fail(`patterns[${index}].ordinal must be unique in 1-100.`);
    ordinals.add(pattern.ordinal);
    assertString(pattern.name, `${pattern.id}.name`);
    assertString(pattern.family, `${pattern.id}.family`);
    if (!ALLOWED_ARCHETYPES.has(pattern.archetype)) fail(`${pattern.id}.archetype '${pattern.archetype}' is not an existing compiler engine.`);
    if (!IMPLEMENTATION_LEVELS.has(pattern.implementationLevel)) fail(`${pattern.id}.implementationLevel is invalid.`);
    assertPlainObject(pattern.selector, `${pattern.id}.selector`);
    const range = pattern.selector.itemCountRange;
    if (!range || !Number.isInteger(range.minimum) || !Number.isInteger(range.maximum) || range.minimum > range.maximum) fail(`${pattern.id}.selector.itemCountRange is invalid.`);
    assertPlainObject(pattern.variantParams, `${pattern.id}.variantParams`);
    for (const key of Object.keys(pattern.variantParams)) if (!ALLOWED_VARIANT_KEYS.has(key)) fail(`${pattern.id}.variantParams contains unsupported key '${key}'.`);
    rejectCoordinates(pattern.variantParams, `${pattern.id}.variantParams`);
    assertPlainObject(pattern.designContract, `${pattern.id}.designContract`);
    for (const field of ["intent", "argumentSchema", "gridAndSafeZones", "focusRule", "connectorPolicy", "geometryConstraints", "nativeEditabilityContract", "overflowFallback"]) {
      assertString(pattern.designContract[field], `${pattern.id}.designContract.${field}`);
    }
    if (!Array.isArray(pattern.designContract.renderTests) || !pattern.designContract.renderTests.includes("full-size-review")) fail(`${pattern.id} must require full-size rendered review.`);
    if (!Array.isArray(pattern.designContract.ooxmlTests) || !pattern.designContract.ooxmlTests.includes("run-level-emphasis")) fail(`${pattern.id} must require OOXML rich-text proof.`);
    if (!pattern.semanticSignature || !Array.isArray(pattern.semanticSignature.requiredMarks) || pattern.semanticSignature.requiredMarks.length < 2 || pattern.semanticSignature.fallbackForbidden !== true) fail(`${pattern.id} must declare fail-closed semantic marks.`);
    if (!pattern.visualReview || !REVIEW_STATUSES.has(pattern.visualReview.status) || pattern.visualReview.reviewedAtFullSize !== true || pattern.visualReview.threshold !== 92) fail(`${pattern.id} visual review contract is invalid.`);
    if (pattern.visualReview.status === "pass" && pattern.implementationLevel !== "reviewed-release-candidate") fail(`${pattern.id} passed review but is not a release candidate.`);
    if (pattern.visualReview.status !== "pass" && pattern.implementationLevel === "reviewed-release-candidate") fail(`${pattern.id} cannot be a release candidate without a passing review.`);
    if (pattern.implementationLevel === "reviewed-release-candidate" && !patternSemanticCoverage(pattern).complete) {
      fail(`${pattern.id} is missing required semantic marks: ${patternSemanticCoverage(pattern).missing.join(", ")}.`);
    }
    if (!STYLE_CLASSES.has(pattern.styleClass)) fail(`${pattern.id}.styleClass is invalid.`);
    styleCounts[pattern.styleClass] += 1;
  }
  if (styleCounts["classic-analytical"] !== 60 || styleCounts["contemporary-geometric"] !== 30 || styleCounts["bold-narrative"] !== 10) {
    fail(`portfolio mix must be 60/30/10, found ${stableStringify(styleCounts)}.`);
  }
  return catalog;
}

let cachedCatalog;
export async function loadPatternCatalog() {
  if (!cachedCatalog) cachedCatalog = deepFreeze(validatePatternCatalog(JSON.parse(await fs.readFile(CATALOG_PATH, "utf8"))));
  return cachedCatalog;
}

export async function listPatterns(filters = {}) {
  const catalog = await loadPatternCatalog();
  return catalog.patterns.filter((pattern) => (
    (filters.family == null || pattern.family === filters.family)
    && (filters.archetype == null || pattern.archetype === filters.archetype)
    && (filters.styleClass == null || pattern.styleClass === filters.styleClass)
  ));
}

export async function getPattern(id) {
  const catalog = await loadPatternCatalog();
  const pattern = catalog.patterns.find((candidate) => candidate.id === id);
  if (!pattern) fail(`unknown pattern id '${id}'.`);
  return pattern;
}

function scorePattern(pattern, intent) {
  let score = 0;
  const reasons = [];
  const semantic = [
    ["purpose", "purposes", 32],
    ["relationship", "relationships", 24],
  ];
  for (const [intentKey, selectorKey, weight] of semantic) {
    if (intent[intentKey] == null) continue;
    if (pattern.selector[selectorKey].includes(intent[intentKey])) {
      score += weight;
      reasons.push(`${intentKey}:exact`);
    } else score -= Math.floor(weight / 2);
  }
  if (Number.isInteger(intent.itemCount)) {
    const { minimum, maximum } = pattern.selector.itemCountRange;
    if (intent.itemCount >= minimum && intent.itemCount <= maximum) {
      score += 20;
      reasons.push("item-count:compatible");
    } else score -= Math.min(20, Math.min(Math.abs(intent.itemCount - minimum), Math.abs(intent.itemCount - maximum)) * 4);
  }
  for (const key of ["density", "sequence", "overlap", "hierarchy", "dataMode"]) {
    if (intent[key] == null) continue;
    if (pattern.selector[key] === intent[key]) {
      score += key === "density" ? 10 : 8;
      reasons.push(`${key}:exact`);
    } else score -= 3;
  }
  if (intent.styleClass && pattern.styleClass === intent.styleClass) {
    score += 6;
    reasons.push("style-class:exact");
  }
  return { id: pattern.id, score, reasons, reviewStatus: pattern.visualReview.status, implementationLevel: pattern.implementationLevel };
}

export async function selectPattern(intent = {}) {
  assertPlainObject(intent, "selector intent");
  rejectCoordinates(intent, "selector intent");
  const catalog = await loadPatternCatalog();
  const candidates = catalog.patterns.map((pattern) => scorePattern(pattern, intent))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return deepFreeze({
    catalogVersion: catalog.catalogVersion,
    catalogSha256: sha256(catalog),
    intentSha256: sha256(intent),
    candidates: candidates.slice(0, 10),
    selectedId: candidates[0].id,
  });
}

function actionTitle(pattern) {
  const endings = ["clarifies the decision", "makes the trade-off explicit", "focuses the next move", "reveals the implication", "keeps ownership visible"];
  if (pattern.archetype === "chevron-flow") return `${pattern.name.split(" ").slice(0, 2).join(" ")} drives action`;
  if (pattern.archetype === "polygon-cycle") return `${pattern.name.split(" ").slice(0, 2).join(" ")} shows the system`;
  if (pattern.archetype === "table") return `${pattern.name.split(" ").slice(0, 2).join(" ")} reveals the signal`;
  return `${pattern.name.split(" ").slice(0, 2).join(" ")} ${endings[(pattern.ordinal - 1) % endings.length]}`;
}

function genericItems(pattern, count) {
  const labels = ["Aim", "Proof", "Choice", "Action", "Value", "Risk", "Owner", "Pace", "Learn", "Scale", "Trust", "Result"];
  const bodies = [
    "Set scope.", "Use facts.", "Choose.",
    "Act.", "Track.", "Test.",
    "Own.", "Review.", "Learn.",
    "Scale.", "Verify.", "Decide.",
  ];
  return Array.from({ length: count }, (_, index) => ({
    id: `${pattern.id}-item-${index + 1}`,
    label: labels[index % labels.length],
    body: { runs: [{ text: "Rule - ", bold: true }, { text: bodies[index % bodies.length], bold: false }] },
    ...(index === pattern.variantParams.emphasisIndex ? { emphasis: true } : {}),
  }));
}

function semanticItems(pattern, count) {
  return genericItems(pattern, count).map((item, index) => ({ ...item, ...ICONS[index % ICONS.length] }));
}

function normalizedCount(pattern, requested) {
  const { minimum, maximum } = pattern.selector.itemCountRange;
  const value = requested ?? Math.min(maximum, Math.max(minimum, 4));
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`${pattern.id} itemCount must be within ${minimum}-${maximum}.`);
  if (pattern.archetype === "quadrant-focus") return 4;
  if (pattern.archetype === "chevron-flow") return Math.max(3, Math.min(5, value));
  if (pattern.archetype === "point-grid") return Math.max(2, Math.min(9, value));
  if (pattern.archetype === "polygon-cycle") return Math.max(3, Math.min(12, value));
  if (pattern.archetype === "icon-network") {
    if (value <= 4) return 4;
    if (value <= 6) return 6;
    if (value <= 8) return 7;
    if (value === 9) return 9;
    return 10;
  }
  return value;
}

function tableContent(pattern, count) {
  const rows = genericItems(pattern, Math.max(1, Math.min(8, count))).map((item, index) => [
    item.label,
    `${72 + index * 3}%`,
    index === 0 ? "Priority" : index % 2 ? "On track" : "Watch",
    item.body.runs.map((run) => run.text).join("").replace(/\.$/u, ""),
  ]);
  return { columns: ["Dimension", "Evidence", "Signal", "Implication"], rows };
}

function mergeContent(base, content) {
  for (const key of Object.keys(content)) if (!ALLOWED_CONTENT_KEYS.has(key)) fail(`content contains unsupported key '${key}'.`);
  rejectCoordinates(content, "content");
  return { ...base, ...structuredClone(content) };
}

function buildSlide(pattern, content) {
  const requestedCount = Array.isArray(content.items) ? content.items.length : content.itemCount;
  if (content.itemCount != null && !Number.isInteger(content.itemCount)) fail("content.itemCount must be an integer.");
  const { itemCount: _itemCount, ...slideContent } = content;
  const count = normalizedCount(pattern, requestedCount);
  const title = slideContent.title ?? actionTitle(pattern);
  const base = { id: pattern.id, layout: pattern.archetype, title };
  if (pattern.archetype === "hero") return mergeContent({
    ...base,
    eyebrow: `${pattern.familyLabel.toUpperCase()} / ${String(pattern.ordinal).padStart(3, "0")}`,
    body: "A board-ready page gives the reader one answer, one proof path, and one owned implication.",
    callout: "Decision ready - native, editable, and reviewable",
  }, slideContent);
  if (pattern.archetype === "two-column") return mergeContent({
    ...base,
    left: { heading: "Evidence", body: { runs: [{ text: "Observed facts - ", bold: true }, { text: "define the real constraint and narrow the viable choices.", bold: false }] } },
    right: { heading: "Implication", body: { runs: [{ text: "Recommended move - ", bold: true }, { text: "follows from the evidence and names the accountable action.", bold: false }] } },
  }, slideContent);
  if (pattern.archetype === "opposition") return mergeContent({
    ...base,
    axisLabel: "VS",
    left: { heading: "Current logic", body: "Optimize for control, consistency, and predictable execution." },
    right: { heading: "Target logic", body: "Protect speed while preserving explicit standards and guardrails." },
    synthesis: { runs: [{ text: "Recommendation - ", bold: true }, { text: "keep shared standards and move operating choices closer to the work.", bold: false }] },
  }, slideContent);
  if (pattern.archetype === "table") return mergeContent({ ...base, table: tableContent(pattern, count) }, slideContent);
  if (pattern.archetype === "quadrant-focus") return mergeContent({
    ...base,
    center: "Decision",
    items: semanticItems(pattern, 4).map(({ emphasis: _emphasis, ...item }) => item),
  }, slideContent);
  if (pattern.archetype === "chevron-flow") return mergeContent({
    ...base,
    subtitle: "Each stage ends with a visible output and accountable owner.",
    takeaway: "Critical move - validate the evidence before committing resources.",
    items: semanticItems(pattern, count),
  }, slideContent);
  if (pattern.archetype === "polygon-cycle") return mergeContent({
    ...base,
    relationship: pattern.variantParams.relationship ?? "system",
    center: "Shared outcome",
    items: genericItems(pattern, count),
  }, slideContent);
  if (pattern.archetype === "icon-network") {
    const topology = count === 7 ? "honeycomb" : [3, 6, 10].includes(count) ? "pyramid" : "square";
    return mergeContent({ ...base, topology, items: semanticItems(pattern, count) }, slideContent);
  }
  if (pattern.archetype === "point-grid") return mergeContent({
    ...base,
    arrangement: pattern.variantParams.arrangement ?? "auto",
    items: genericItems(pattern, count),
  }, slideContent);
  fail(`archetype '${pattern.archetype}' is not instantiable by the catalog.`);
}

export async function instantiatePattern(id, content = {}, themeProfileId = "slate") {
  const pattern = await getPattern(id);
  assertPlainObject(content, "content");
  const theme = THEMES[themeProfileId];
  if (!theme) fail(`unknown theme profile '${themeProfileId}'.`);
  const spec = {
    version: "0.2",
    title: `Slidewright pattern ${pattern.id}`,
    theme: structuredClone(theme),
    slides: [buildSlide(pattern, content)],
  };
  validateDeckSpec(spec);
  return spec;
}

export async function instantiatePatternRequest(request) {
  assertPlainObject(request, "pattern request");
  const allowed = new Set(["patternId", "intent", "content", "themeProfileId", "developmentMode"]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) fail(`request contains unsupported key '${key}'.`);
  let receipt;
  let patternId = request.patternId;
  if (!patternId) {
    receipt = await selectPattern(request.intent ?? {});
    patternId = receipt.selectedId;
  } else {
    await getPattern(patternId);
    receipt = await selectPattern(request.intent ?? {});
    receipt = deepFreeze({ ...receipt, selectedId: patternId, explicitPattern: true });
  }
  const pattern = await getPattern(patternId);
  if (pattern.visualReview.status !== "pass" && request.developmentMode !== true) {
    fail(`pattern '${patternId}' is ${pattern.visualReview.status} after full-size review and cannot generate a release candidate. Set developmentMode only for controlled pattern development.`);
  }
  return { spec: await instantiatePattern(patternId, request.content ?? {}, request.themeProfileId ?? "slate"), receipt };
}

export function patternCatalogPath() {
  return CATALOG_PATH;
}
