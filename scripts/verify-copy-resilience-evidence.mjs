#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditAdaptedDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { stableJson } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";
import { collectC15WorkspaceImplementationFiles } from "./lib/c15-implementation-closure.mjs";
import { captureC15RuntimeBindings } from "./lib/c15-runtime-bindings.mjs";

const root = process.cwd();
const published = path.join(root, "outputs", "copy-resilience");
const requiredCaseArtifacts = [
  "input-spec.json",
  "fixed-plan.json",
  "fixed-lint.json",
  "adapted-spec.json",
  "adaptation.json",
  "plan.json",
  "font-report-normalized.json",
  "lint-report.json",
  "rendered-lint-report.json",
  "ooxml-audit.json",
  "plan-audit.json",
  "adaptation-audit.json",
  "slides-test.txt",
  "delivery-normalized.json",
  "deck.pptx",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

function equal(left, right) {
  return stableJson(left) === stableJson(right);
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function resolveBoundArtifact(runDirectory, relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe evidence path '${relativePath}'.`);
  }
  const resolved = path.resolve(runDirectory, ...relativePath.split("/"));
  if (!resolved.startsWith(`${path.resolve(runDirectory)}${path.sep}`)) throw new Error(`Evidence path escaped the run directory: ${relativePath}.`);
  return resolved;
}

async function verifyArtifact(runDirectory, artifact) {
  const filePath = resolveBoundArtifact(runDirectory, artifact.path);
  const bytes = await fs.readFile(filePath);
  if (sha256(bytes) !== artifact.sha256) throw new Error(`Evidence hash drift for ${artifact.path}.`);
  if (artifact.bytes != null && bytes.length !== artifact.bytes) throw new Error(`Evidence size drift for ${artifact.path}.`);
  if (/\.(?:json|txt)$/iu.test(artifact.path)) {
    const text = bytes.toString("utf8");
    if (/(?:[A-Za-z]:\\Users\\|\/Users\/[^/]+\/|\/home\/[^/]+\/)/u.test(text)) throw new Error(`Machine-specific path leaked into ${artifact.path}.`);
  }
}

const current = await readJson(path.join(published, "current.json"));
if (current.schemaVersion !== "slidewright-copy-resilience-current/v1") throw new Error("Current C15 pointer schema is missing or unsupported.");
if (!/^runs\/[a-f0-9]{64}$/u.test(current.run) || !/^[a-f0-9]{64}$/u.test(current.scorecardHash)) throw new Error("Current C15 pointer is malformed.");
const runDirectory = path.join(published, ...current.run.split("/"));
const scorecard = await readJson(path.join(runDirectory, "scorecard.json"));
const unhashedScorecard = structuredClone(scorecard);
delete unhashedScorecard.scorecardHash;
const recomputedScorecardHash = sha256(Buffer.from(stableJson(unhashedScorecard), "utf8"));
if (scorecard.scorecardHash !== recomputedScorecardHash || scorecard.scorecardHash !== current.scorecardHash || path.basename(runDirectory) !== scorecard.scorecardHash) {
  throw new Error("C15 scorecard content hash or current pointer drifted.");
}
if (!scorecard.valid || scorecard.caseCount !== 5 || scorecard.reviewArtifactCount !== 22 || !scorecard.reviewArtifactsReady) throw new Error("C15 scorecard does not close the declared machine gate.");

const expectedImplementationFiles = await collectC15WorkspaceImplementationFiles(root);
const expectedImplementationPaths = expectedImplementationFiles.map((file) => path.relative(root, file).split(path.sep).join("/"));
const declaredImplementationPaths = scorecard.implementationHashes.map((item) => item.path);
if (!equal(declaredImplementationPaths, expectedImplementationPaths)) throw new Error("C15 implementation dependency closure is incomplete or reordered.");
for (const implementation of scorecard.implementationHashes) {
  const filePath = path.resolve(root, ...implementation.path.split("/"));
  if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`) || sha256(await fs.readFile(filePath)) !== implementation.sha256) {
    throw new Error(`C15 implementation dependency drift for ${implementation.path}.`);
  }
}
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
const python = await fs.stat(bundledPython).then(() => bundledPython).catch(() => "python");
const runtimeBindings = await captureC15RuntimeBindings({ root, python });
if (!equal(scorecard.runtimeBindings, runtimeBindings)) throw new Error("C15 renderer or external runtime dependency binding drifted.");

const boundArtifacts = [];
for (const item of scorecard.cases) boundArtifacts.push(...item.artifactHashes, ...item.reviewArtifacts);
for (const item of scorecard.destructiveControls) boundArtifacts.push(...(item.artifactHashes ?? []));
boundArtifacts.push(...scorecard.slideCeilingControl.artifactHashes);
const paths = boundArtifacts.map((item) => item.path);
if (new Set(paths).size !== paths.length) throw new Error("C15 evidence paths are not unique.");
await Promise.all(boundArtifacts.map((item) => verifyArtifact(runDirectory, item)));

for (const item of scorecard.cases) {
  const prefix = `cases/${item.id}/`;
  const actualNames = item.artifactHashes.map((artifact) => artifact.path.startsWith(prefix) ? artifact.path.slice(prefix.length) : "<outside-case>").sort();
  if (!equal(actualNames, [...requiredCaseArtifacts].sort())) throw new Error(`C15 case ${item.id} does not publish the exact required artifact set.`);
  const readCase = (name) => readJson(path.join(runDirectory, ...prefix.split("/"), name));
  const [input, fixedPlan, fixedLint, adapted, adaptation, plan, lint, renderedLint, genericAudit, planAudit, adaptationAudit, fonts, delivery] = await Promise.all([
    readCase("input-spec.json"), readCase("fixed-plan.json"), readCase("fixed-lint.json"), readCase("adapted-spec.json"),
    readCase("adaptation.json"), readCase("plan.json"), readCase("lint-report.json"), readCase("rendered-lint-report.json"),
    readCase("ooxml-audit.json"), readCase("plan-audit.json"), readCase("adaptation-audit.json"), readCase("font-report-normalized.json"),
    readCase("delivery-normalized.json"),
  ]);
  if (!equal(fixedPlan, compileDeck(input)) || !equal(fixedLint, lintPlan(fixedPlan))) throw new Error(`C15 case ${item.id} fixed-layout evidence cannot be reproduced.`);
  if (!equal(plan, compileDeck(adapted)) || !equal(lint, lintPlan(plan))) throw new Error(`C15 case ${item.id} adapted plan evidence cannot be reproduced.`);
  const recomputedAdaptationAudit = auditAdaptedDeckCopy(input, adapted, adaptation, plan);
  if (!equal(adaptationAudit, recomputedAdaptationAudit) || !adaptationAudit.valid) throw new Error(`C15 case ${item.id} content-conservation evidence cannot be reproduced.`);
  if (!fonts.valid || !lint.valid || lint.counts.warning !== 0 || !renderedLint.valid || renderedLint.counts.warning !== 0 || !genericAudit.valid || !planAudit.valid || !delivery.valid || !delivery.bundleValid) {
    throw new Error(`C15 case ${item.id} contains a failed quality report.`);
  }
  const deckArtifact = item.artifactHashes.find((artifact) => artifact.path === `${prefix}deck.pptx`);
  if (deckArtifact.sha256 !== item.deckSha256 || delivery.file.sha256 !== item.deckSha256) throw new Error(`C15 case ${item.id} deck bindings drifted.`);
}

if (scorecard.destructiveControls.length !== 10 || scorecard.destructiveControls.some((item) => !item.rejected || item.expectedDiagnosticMatched === false || item.expectedLintRulesMatched === false)) {
  throw new Error("C15 destructive-control closure is incomplete.");
}
const expectedLintRules = {
  "forged-fit": ["SW004"],
  "subminimum-type": ["SW002", "SW009"],
  "fractional-type": ["SW003"],
  "text-overlap": ["SW018"],
};
for (const [id, rules] of Object.entries(expectedLintRules)) {
  const control = scorecard.destructiveControls.find((item) => item.id === id);
  if (!control || !equal(control.expectedLintRuleIds, rules) || !rules.every((ruleId) => control.lintRuleIds.includes(ruleId))) {
    throw new Error(`C15 control ${id} is not bound to its intended lint rule set.`);
  }
}
const raster = scorecard.destructiveControls.find((item) => item.id === "rasterized-text");
if (!raster || raster.genericAuditValid !== false || raster.planAuditValid !== false || raster.nativeTextNodes !== 0 || raster.matchedTextObjects !== 0 || raster.pictures !== 9) {
  throw new Error("C15 exported all-raster PPTX control is incomplete.");
}
const ceiling = scorecard.slideCeilingControl;
if (!ceiling.rejected || !ceiling.noDeckPublished || ceiling.productionMaxSlides !== 200 || ceiling.outcome !== "failed" || ceiling.failingStage !== "compile" || !/200-slide safety ceiling/u.test(ceiling.ceilingDiagnostic) || ceiling.publishedForbiddenArtifacts.length !== 0) {
  throw new Error("C15 production slide-ceiling control is incomplete.");
}

let reviewVerified = false;
const reviewPointerPath = path.join(published, "current-review.json");
if (await exists(reviewPointerPath)) {
  const reviewPointer = await readJson(reviewPointerPath);
  if (reviewPointer.machineScorecardHash === scorecard.scorecardHash) {
    if (reviewPointer.schemaVersion !== "slidewright-copy-resilience-review-current/v1" || !/^[a-f0-9]{64}$/u.test(reviewPointer.reviewHash)) throw new Error("C15 review pointer is malformed.");
    const review = await readJson(resolveBoundArtifact(published, reviewPointer.review));
    const reviewCore = structuredClone(review);
    delete reviewCore.reviewHash;
    if (review.schemaVersion !== "slidewright-copy-resilience-review/v1"
      || review.machineScorecardHash !== scorecard.scorecardHash
      || review.reviewHash !== reviewPointer.reviewHash
      || sha256(Buffer.from(stableJson(reviewCore), "utf8")) !== review.reviewHash
      || review.reviewMethod !== "individual-original-resolution"
      || review.montageAcceptedAsEvidence !== false
      || review.valid !== true
      || review.allGo !== true) throw new Error("C15 full-size review record is invalid.");
    const expectedReview = scorecard.cases.flatMap((item) => item.reviewArtifacts).sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
    const decisions = [...review.decisions].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
    if (decisions.length !== expectedReview.length || decisions.some((item, index) => item.path !== expectedReview[index].path || item.sha256 !== expectedReview[index].sha256 || item.status !== "GO")) {
      throw new Error("C15 review decisions do not bind every current preview hash.");
    }
    reviewVerified = true;
  }
}

process.stdout.write(`C15 published evidence verified: ${scorecard.caseCount} cases, ${scorecard.reviewArtifactCount} review slides, ${scorecard.destructiveControls.length} controls, ${boundArtifacts.length} bound artifacts, review ${reviewVerified ? "verified" : "pending-current-scorecard"}, scorecard ${scorecard.scorecardHash}.\n`);
