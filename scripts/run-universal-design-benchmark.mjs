#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { adaptDeckCopyToFit } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { renderPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "fixtures", "universal-design", "deck-spec.json");
const baselinePath = path.join(root, "fixtures", "universal-design", "visual-baseline.json");
const output = path.join(root, "outputs", "universal-design");
const previewDir = path.join(output, "previews");
const planPath = path.join(output, "plan.json");
const deckPath = path.join(output, "universal-design.pptx");
const planAuditPath = path.join(output, "plan-audit.json");
const ooxmlAuditPath = path.join(output, "ooxml-audit.json");

const stable = (value) => JSON.stringify(value);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);

function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("Visual baseline contains a non-PNG file.");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function runPython(args, expectedStatus = 0) {
  const command = process.env.SLIDEWRIGHT_PYTHON || "python";
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== expectedStatus) throw result.error ?? new Error(result.stderr || result.stdout || `Python command failed with status ${result.status}; expected ${expectedStatus}.`);
  return result;
}

function exactControl(id, plan, mutate, expectedRuleId) {
  const candidate = clone(plan);
  mutate(candidate);
  const report = lintPlan(candidate);
  const ruleIds = report.diagnostics.map((item) => item.ruleId);
  if (report.valid || ruleIds.length !== 1 || ruleIds[0] !== expectedRuleId) throw new Error(`${id} must fail only ${expectedRuleId}; received ${ruleIds.join(", ") || "no diagnostics"}.`);
  return { id, expectedRuleId, observedRuleIds: ruleIds, valid: true };
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(previewDir, { recursive: true });
const spec = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const plans = [compileDeck(clone(spec)), compileDeck(clone(spec)), compileDeck(clone(spec))];
if (!plans.every((plan) => stable(plan) === stable(plans[0]))) throw new Error("Universal design compilation is nondeterministic.");
const plan = plans[0];
const lint = lintPlan(plan);
if (!lint.valid || lint.counts.error || lint.counts.warning) throw new Error(`Universal positive fixture failed lint: ${JSON.stringify(lint.diagnostics)}.`);
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(output, "lint-report.json"), `${JSON.stringify(lint, null, 2)}\n`, "utf8");
await renderPlan(plan, { out: deckPath, previewDir });

const copyStressSpec = clone(spec);
copyStressSpec.slides.find((slide) => slide.layout === "icon-list").items[0].body = "The outcome and why it matters. ".repeat(45);
const copyStress = adaptDeckCopyToFit(copyStressSpec);
const stressedIconField = copyStress.manifest.fields.find((field) => field.sourceSlideId === "universal-icons" && field.sourceField === "items.0.body");
const stressedSourceSlide = copyStress.plan.slides.find((slide) => slide.id === "universal-icons");
const stressedBodySizes = stressedSourceSlide.shapes.filter((shape) => shape.componentPattern?.slot === "body").map((shape) => shape.style.fontSizePt);
if (!stressedIconField || stressedIconField.chunkCount < 2 || new Set(stressedBodySizes).size !== 1 || !lintPlan(copyStress.plan).valid) throw new Error("Single-item icon-list copy stress did not relayout while preserving peer formatting.");

runPython([
  path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_request_plan.py"),
  deckPath, planPath, "--json", planAuditPath,
]);
runPython([
  path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py"),
  deckPath, "--json", ooxmlAuditPath,
]);
const planAudit = JSON.parse(await fs.readFile(planAuditPath, "utf8"));
const ooxmlAudit = JSON.parse(await fs.readFile(ooxmlAuditPath, "utf8"));
if (!planAudit.valid || !ooxmlAudit.valid) throw new Error("Universal native-export audits failed.");

const ooxmlControls = [];
const mutationScript = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "mutate_universal_ooxml.py");
const planAuditScript = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_request_plan.py");
for (const control of [
  { id: "asymmetric-text-inset", expectedField: "inset-right" },
  { id: "paragraph-spacing-drift", expectedField: "paragraph-0-space-after" },
  { id: "asymmetric-table-inset", expectedField: "r2c1-inset-right" },
  { id: "semantic-icon-metadata-loss", expectedField: "semantic-icon-metadata" },
  { id: "backing-geometry-drift", expectedField: "width" },
  { id: "repeated-component-style-drift", expectedField: "run-0-color" },
  { id: "headline-size-drift", expectedField: "run-0-size" },
]) {
  const mutant = path.join(output, "negative-controls", control.id, "mutant.pptx");
  const reportPath = path.join(output, "negative-controls", control.id, "plan-audit.json");
  runPython([mutationScript, deckPath, mutant, control.id]);
  runPython([planAuditScript, mutant, planPath, "--json", reportPath], 2);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  const fields = report.failures.map((failure) => failure.field);
  if (report.valid || fields.length !== 1 || fields[0] !== control.expectedField) throw new Error(`${control.id} must be rejected only as ${control.expectedField}; received ${fields.join(", ") || "no failures"}.`);
  ooxmlControls.push({ ...control, observedFields: fields, valid: true, mutantSha256: sha256(await fs.readFile(mutant)) });
}

const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
if (baseline.decision !== "pass" || baseline.slides.length !== plan.slides.length) throw new Error("Universal visual baseline is incomplete.");
const visualEvidence = [];
for (const expected of baseline.slides) {
  const file = path.join(previewDir, expected.file);
  const bytes = await fs.readFile(file);
  const actual = { slide: expected.slide, file: expected.file, ...pngSize(bytes), sha256: sha256(bytes) };
  if (actual.width !== expected.width || actual.height !== expected.height || actual.sha256 !== expected.sha256 || expected.decision !== "pass") throw new Error(`Visual baseline drifted on slide ${expected.slide}; inspect the full-size render before updating evidence.`);
  visualEvidence.push(actual);
}

const controls = [];
controls.push(exactControl("asymmetric-text-inset", plan, (candidate) => {
  candidate.slides[0].shapes.find((shape) => shape.id === "s1-title").style.insets.right = 8;
}, "SW023"));
controls.push(exactControl("asymmetric-table-cell-inset", plan, (candidate) => {
  candidate.slides.find((slide) => slide.layout === "table").shapes.find((shape) => shape.type === "table").table.styles.body.insets.right = 12;
}, "SW023"));
controls.push(exactControl("native-table-cell-overflow", plan, (candidate) => {
  candidate.slides.find((slide) => slide.layout === "table").shapes.find((shape) => shape.type === "table").table.values[1][0] = "W ".repeat(200);
}, "SW004"));
controls.push(exactControl("text-escapes-backing-one-pixel", plan, (candidate) => {
  candidate.slides[0].shapes.find((shape) => shape.id === "s1-callout").position.width += 1;
}, "SW024"));
controls.push(exactControl("repeated-component-style-drift", plan, (candidate) => {
  const repeated = candidate.slides.find((slide) => slide.id === "universal-comparison-repeat");
  repeated.shapes.find((shape) => shape.componentPattern?.slot === "heading" && shape.componentPattern.variantId === "neutral").style.fontSizePt = 18;
}, "SW025"));
controls.push(exactControl("required-component-metadata-removal", plan, (candidate) => {
  const component = candidate.slides.find((slide) => slide.layout === "two-column").shapes.find((shape) => shape.componentPattern?.slot === "heading");
  delete component.componentPattern;
  component.style.color = "#FF0000";
}, "SW025"));
controls.push(exactControl("semantic-icon-mismatch", plan, (candidate) => {
  candidate.slides.find((slide) => slide.layout === "icon-list").shapes.find((shape) => shape.semanticType === "icon").icon.name = "globe";
}, "SW026"));
controls.push(exactControl("semantic-icon-decorative-bypass", plan, (candidate) => {
  const icon = candidate.slides.find((slide) => slide.layout === "icon-list").shapes.find((shape) => shape.semanticType === "icon");
  icon.icon.name = "nonsense";
  icon.semanticBinding = { decorative: true };
}, "SW026"));
controls.push(exactControl("headline-aggressive-shrink", plan, (candidate) => {
  candidate.slides[0].shapes.find((shape) => shape.id === "s1-title").style.fontSizePt = 40;
}, "SW027"));
controls.push(exactControl("arbitrary-paragraph-spacing", plan, (candidate) => {
  candidate.slides[0].shapes.find((shape) => shape.id === "s1-body").text.paragraphs[0].spaceAfterPt = 8;
}, "SW028"));
controls.push(exactControl("mutable-paragraph-scale-bypass", plan, (candidate) => {
  candidate.designSystem.paragraphSpacingPt.push(8);
  candidate.slides[0].shapes.find((shape) => shape.id === "s1-body").text.paragraphs[0].spaceAfterPt = 8;
}, "SW029"));
controls.push(exactControl("mutable-inset-scale-bypass", plan, (candidate) => {
  candidate.designSystem.insetTokensPx.push(7);
  candidate.slides[0].shapes.find((shape) => shape.id === "s1-title").style.insets = { top: 7, right: 7, bottom: 7, left: 7 };
}, "SW029"));
controls.push(exactControl("mutable-backing-archetype-bypass", plan, (candidate) => {
  delete candidate.designSystem.archetypes.hero.requiredBackedRoles;
}, "SW029"));
controls.push(exactControl("mutable-component-archetype-bypass", plan, (candidate) => {
  delete candidate.designSystem.archetypes["two-column"].componentFamilies;
}, "SW029"));
controls.push(exactControl("mutable-semantic-archetype-bypass", plan, (candidate) => {
  candidate.designSystem.archetypes["icon-list"].requiresSemanticIcons = false;
}, "SW029"));
controls.push(exactControl("mutable-typography-floor-bypass", plan, (candidate) => {
  candidate.designSystem.typographyRoles["hero-title"].minimumSizePt = 12;
}, "SW029"));
controls.push(exactControl("injected-custom-archetype-bypass", plan, (candidate) => {
  candidate.designSystem.archetypes.custom = { pageRole: "custom", requiredStyleRoles: [] };
}, "SW029"));
controls.push(exactControl("injected-custom-typography-bypass", plan, (candidate) => {
  candidate.designSystem.typographyRoles.custom = { preferredSizePt: 14, minimumSizePt: 12, maximumLines: 8, lineHeight: 1, baseWeight: "regular" };
}, "SW029"));
controls.push(exactControl("stacked-six-plus-six-spacing", plan, (candidate) => {
  const paragraphs = candidate.slides[0].shapes.find((shape) => shape.id === "s1-body").text.paragraphs;
  paragraphs[0].spaceAfterPt = 6;
  paragraphs[1].spaceBeforePt = 6;
}, "SW028"));
controls.push(exactControl("backing-contract-metadata-removal", plan, (candidate) => {
  candidate.slides[0].layoutContract.backings = [];
}, "SW024"));
controls.push(exactControl("unknown-page-archetype", plan, (candidate) => {
  candidate.slides[0].archetypeId = "undeclared-page";
}, "SW029"));

const scorecard = {
  schemaVersion: "slidewright-universal-design-scorecard/v1",
  valid: true,
  fixture: path.relative(root, fixturePath).replaceAll("\\", "/"),
  deterministicCompilations: plans.length,
  slides: plan.slides.length,
  archetypes: [...new Set(plan.slides.map((slide) => slide.archetypeId))],
  planAudit: {
    expectedObjects: planAudit.expectedObjects,
    actualObjects: planAudit.actualObjects,
    expectedTextObjects: planAudit.expectedTextObjects,
    matchedTextObjects: planAudit.matchedTextObjects,
    expectedParagraphs: planAudit.expectedParagraphs,
    matchedParagraphs: planAudit.matchedParagraphs,
    expectedTables: planAudit.expectedTables,
    matchedTables: planAudit.matchedTables,
    expectedSemanticIcons: planAudit.expectedSemanticIcons,
    matchedSemanticIcons: planAudit.matchedSemanticIcons,
    pictures: planAudit.pictures,
  },
  ooxmlAudit: ooxmlAudit.summary,
  negativeControls: controls,
  copyStress: {
    sourceSlideCount: copyStress.manifest.sourceSlideCount,
    adaptedSlideCount: copyStress.manifest.adaptedSlideCount,
    continuationSlideCount: copyStress.manifest.continuationSlideCount,
    stressedFieldChunkCount: stressedIconField.chunkCount,
    peerBodyFontSizePt: stressedBodySizes[0],
  },
  ooxmlNegativeControls: ooxmlControls,
  visualEvidence,
  artifacts: {
    planSha256: sha256(await fs.readFile(planPath)),
    pptxSha256: sha256(await fs.readFile(deckPath)),
  },
};
await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
process.stdout.write(`Universal design benchmark passed: ${scorecard.slides} slides, ${controls.length} plan controls, ${ooxmlControls.length} OOXML controls, ${visualEvidence.length} full-size visual baselines.\n`);
