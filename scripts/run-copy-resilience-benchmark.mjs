#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adaptDeckCopyToFit, auditAdaptedDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { mutateDeckCopy, mutateFlexibleDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-mutation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { stableJson } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";
import { collectC15WorkspaceImplementationFiles } from "./lib/c15-implementation-closure.mjs";
import { captureC15RuntimeBindings } from "./lib/c15-runtime-bindings.mjs";
import { publishVersionedEvidence } from "./lib/versioned-evidence-publish.mjs";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "copy-resilience", "v1");
const fixtureManifestPath = path.join(fixtureRoot, "fixture-manifest.json");
const sourcePath = path.join(root, "examples", "demo", "deck-spec.json");
const manifest = JSON.parse(await fs.readFile(fixtureManifestPath, "utf8"));
const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
const cli = path.join(root, "packages", "cli", "src", "cli.mjs");
const auditPptx = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py");
const auditPlan = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_request_plan.py");
const rasterizeControl = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark", "rasterize_deck_control.py");
const work = path.join(root, "outputs", `.copy-resilience-work-${process.pid}-${Date.now()}`);
const staging = path.join(root, "outputs", `.copy-resilience-staging-${process.pid}-${Date.now()}`);
const published = path.join(root, "outputs", "copy-resilience");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function listFiles(directory) {
  if (!await exists(directory)) return [];
  const found = [];
  async function visit(current, prefix = "") {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(current, entry.name), relative);
      else found.push(relative);
    }
  }
  await visit(directory);
  return found;
}

async function publishArtifact(sourcePath, relativePath) {
  const destination = path.join(staging, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(sourcePath, destination);
  return { path: relativePath, bytes: (await fs.stat(destination)).size, sha256: await sha256File(destination) };
}

function normalizeFontReport(report) {
  return {
    valid: report.valid,
    requestedFonts: report.requestedFonts,
    fallback: report.fallback,
    diagnostics: report.diagnostics,
    suggestedThemePatch: report.suggestedThemePatch,
    substitutionApplied: report.substitutionApplied,
  };
}

function normalizeDeliveryReport(report, previewNames) {
  return {
    valid: report.valid,
    deckValid: report.deckValid,
    bundleValid: report.bundleValid,
    requireBundle: report.requireBundle,
    file: {
      sizeBytes: report.file.sizeBytes,
      sha256: report.file.sha256,
      slideCount: report.file.slideCount,
    },
    checks: report.checks,
    bundleChecks: report.bundleChecks,
    previews: previewNames,
    inspectionError: report.inspectionError,
  };
}

function run(command, args, { expectedStatus = 0, retryNativeCrash = false } = {}) {
  let result;
  for (let attempt = 0; attempt < (retryNativeCrash ? 2 : 1); attempt += 1) {
    result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status === expectedStatus) break;
    if (![3221225477, -1073741819].includes(result.status) || attempt === 1) break;
    process.stdout.write(`C15 bounded retry after native renderer status ${result.status}.\n`);
  }
  if (result.status !== expectedStatus) throw new Error(`${command} ${args.join(" ")} returned ${result.status}; expected ${expectedStatus}.\n${result.stderr || result.stdout}`);
  return { stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), status: result.status };
}

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Could not find ${name} in the Codex presentation runtime.`);
}

async function pythonRuntime() {
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
  return await exists(bundled) ? bundled : "python";
}

function caseInput(fixture) {
  if (fixture.kind === "human-authored-translation") return fs.readFile(path.join(root, fixture.spec), "utf8").then(JSON.parse);
  if (fixture.mutationScope === "flexible-copy") return Promise.resolve(mutateFlexibleDeckCopy(source, fixture.factor));
  return Promise.resolve(mutateDeckCopy(source, fixture.factor));
}

function minimumType(plan) {
  const text = plan.slides.flatMap((slide) => slide.shapes).filter((shape) => shape.type === "text");
  return {
    minimumFontSizePt: Math.min(...text.map((shape) => shape.style.fontSizePt)),
    allInteger: text.every((shape) => Number.isInteger(shape.style.fontSizePt)),
    allAtOrAboveMinimum: text.every((shape) => shape.style.fontSizePt >= shape.fit.minSizePt),
    allFit: text.every((shape) => shape.fit.fits),
  };
}

async function runCase(fixture, tools) {
  const directory = path.join(work, fixture.id);
  const inputPath = path.join(directory, "input-spec.json");
  const fixedPlanPath = path.join(directory, "fixed-plan.json");
  const fixedLintPath = path.join(directory, "fixed-lint.json");
  const adaptedPath = path.join(directory, "adapted-spec.json");
  const adaptationPath = path.join(directory, "adaptation.json");
  const adaptationAuditPath = path.join(directory, "adaptation-audit.json");
  const planPath = path.join(directory, "plan.json");
  const fontPath = path.join(directory, "font-report.json");
  const lintPath = path.join(directory, "lint-report.json");
  const deckPath = path.join(directory, "deck.pptx");
  const previewDir = path.join(directory, "previews");
  const genericAuditPath = path.join(directory, "ooxml-audit.json");
  const planAuditPath = path.join(directory, "plan-audit.json");
  const montagePath = path.join(directory, "montage.png");
  const deliveryPath = path.join(directory, "delivery.json");
  const handoffPath = path.join(directory, "DELIVERY.md");
  await fs.mkdir(directory, { recursive: true });
  const input = await caseInput(fixture);
  await writeJson(inputPath, input);

  const fixedPlan = compileDeck(input);
  const fixedLint = lintPlan(fixedPlan);
  await writeJson(fixedPlanPath, fixedPlan);
  await writeJson(fixedLintPath, fixedLint);
  if (Boolean(fixture.expectFixedLayoutFailure) === fixedLint.valid) throw new Error(`${fixture.id} fixed-layout expectation did not match lint result.`);

  const repetitions = [adaptDeckCopyToFit(input), adaptDeckCopyToFit(input), adaptDeckCopyToFit(input)];
  const deterministicHashes = repetitions.map((item) => sha256(Buffer.from(stableJson({ spec: item.spec, manifest: item.manifest, plan: item.plan }), "utf8")));
  if (new Set(deterministicHashes).size !== 1) throw new Error(`${fixture.id} adaptive planning is not deterministic.`);
  if (Boolean(fixture.expectAdaptation) !== (repetitions[0].manifest.continuationSlideCount > 0)) throw new Error(`${fixture.id} adaptation expectation did not match output topology.`);

  run(process.execPath, [cli, "adapt", inputPath, "--out", adaptedPath, "--manifest", adaptationPath]);
  run(process.execPath, [cli, "compile", adaptedPath, "--out", planPath]);
  run(process.execPath, [cli, "fonts", planPath, "--out", fontPath]);
  run(process.execPath, [cli, "lint", planPath, "--out", lintPath]);
  run(process.execPath, [cli, "render", planPath, "--out", deckPath, "--preview-dir", previewDir], { retryNativeCrash: true });
  run(tools.python, [auditPptx, deckPath, "--json", genericAuditPath]);
  run(tools.python, [auditPlan, deckPath, planPath, "--json", planAuditPath]);
  const slidesTest = run(tools.python, [tools.slidesTest, deckPath]);
  await fs.writeFile(path.join(directory, "slides-test.txt"), `${slidesTest.stdout}\n`, "utf8");
  run(tools.python, [tools.montage, "--input_dir", previewDir, "--output_file", montagePath]);
  run(process.execPath, [cli, "verify", deckPath, "--out", deliveryPath, "--preview-dir", previewDir, "--montage", montagePath, "--handoff", handoffPath, "--require-bundle"]);

  const [adapted, adaptation, plan, fonts, lint, genericAudit, planAudit, delivery] = await Promise.all([
    fs.readFile(adaptedPath, "utf8").then(JSON.parse),
    fs.readFile(adaptationPath, "utf8").then(JSON.parse),
    fs.readFile(planPath, "utf8").then(JSON.parse),
    fs.readFile(fontPath, "utf8").then(JSON.parse),
    fs.readFile(lintPath, "utf8").then(JSON.parse),
    fs.readFile(genericAuditPath, "utf8").then(JSON.parse),
    fs.readFile(planAuditPath, "utf8").then(JSON.parse),
    fs.readFile(deliveryPath, "utf8").then(JSON.parse),
  ]);
  const adaptationAudit = auditAdaptedDeckCopy(input, adapted, adaptation, plan);
  await writeJson(adaptationAuditPath, adaptationAudit);
  const typography = minimumType(plan);
  const previewNames = (await fs.readdir(previewDir)).filter((name) => /^slide-\d+\.png$/u.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const normalizedFontPath = path.join(directory, "font-report-normalized.json");
  const normalizedDeliveryPath = path.join(directory, "delivery-normalized.json");
  await writeJson(normalizedFontPath, normalizeFontReport(fonts));
  await writeJson(normalizedDeliveryPath, normalizeDeliveryReport(delivery, previewNames));
  const reviewArtifacts = [];
  for (const name of previewNames) {
    const destination = path.join(staging, "review", fixture.id, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(previewDir, name), destination);
    reviewArtifacts.push({ path: `review/${fixture.id}/${name}`, sha256: await sha256File(destination) });
  }
  const evidenceFiles = [
    [inputPath, "input-spec.json"],
    [fixedPlanPath, "fixed-plan.json"],
    [fixedLintPath, "fixed-lint.json"],
    [adaptedPath, "adapted-spec.json"],
    [adaptationPath, "adaptation.json"],
    [planPath, "plan.json"],
    [normalizedFontPath, "font-report-normalized.json"],
    [lintPath, "lint-report.json"],
    [path.join(previewDir, "rendered-lint-report.json"), "rendered-lint-report.json"],
    [genericAuditPath, "ooxml-audit.json"],
    [planAuditPath, "plan-audit.json"],
    [adaptationAuditPath, "adaptation-audit.json"],
    [path.join(directory, "slides-test.txt"), "slides-test.txt"],
    [normalizedDeliveryPath, "delivery-normalized.json"],
    [deckPath, "deck.pptx"],
  ];
  const artifactHashes = [];
  for (const [sourceArtifact, name] of evidenceFiles) {
    artifactHashes.push(await publishArtifact(sourceArtifact, `cases/${fixture.id}/${name}`));
  }
  const valid = adaptationAudit.valid
    && fonts.valid
    && lint.valid && lint.counts.warning === 0
    && genericAudit.valid && planAudit.valid
    && delivery.valid && delivery.bundleValid
    && typography.allFit && typography.allInteger && typography.allAtOrAboveMinimum
    && genericAudit.summary.pictures === 0
    && previewNames.length === plan.slides.length;
  if (!valid) throw new Error(`${fixture.id} did not close every C15 quality gate.`);
  return {
    id: fixture.id,
    kind: fixture.kind,
    factor: fixture.factor ?? null,
    language: fixture.language ?? null,
    inputSha256: await sha256File(inputPath),
    adaptedSha256: adaptation.adaptedSha256,
    planSha256: await sha256File(planPath),
    deckSha256: await sha256File(deckPath),
    deterministicAdaptiveHash: deterministicHashes[0],
    fixedLayoutValid: fixedLint.valid,
    fixedLayoutDiagnostics: fixedLint.diagnostics.map((item) => item.ruleId),
    sourceSlideCount: adaptation.sourceSlideCount,
    adaptedSlideCount: adaptation.adaptedSlideCount,
    continuationSlideCount: adaptation.continuationSlideCount,
    preservedFieldCount: adaptation.fields.length,
    preservedWordCount: adaptation.fields.reduce((sum, field) => sum + field.wordCount, 0),
    typography,
    nativeTextNodes: genericAudit.summary.nativeTextNodes,
    pictures: genericAudit.summary.pictures,
    slidesTestPassed: /no .*overflow|no overflow|passed/iu.test(slidesTest.stdout) || slidesTest.status === 0,
    planAuditValid: planAudit.valid,
    deliveryValid: delivery.valid,
    artifactHashes,
    reviewArtifacts,
    valid,
  };
}

function runControls(denseInput, positive) {
  const controls = [];
  function check(id, expectedDiagnosticCodes, expectedLintRuleIds, mutate) {
    const state = { spec: structuredClone(positive.spec), manifest: structuredClone(positive.manifest), plan: structuredClone(positive.plan) };
    mutate(state);
    const report = auditAdaptedDeckCopy(denseInput, state.spec, state.manifest, state.plan);
    const diagnosticCodes = [...new Set(report.diagnostics.map((item) => item.code))].sort();
    const expectedDiagnosticMatched = expectedDiagnosticCodes.every((code) => diagnosticCodes.includes(code));
    const expectedLintRulesMatched = expectedLintRuleIds.every((ruleId) => report.lintRuleIds.includes(ruleId));
    controls.push({ id, expectedDiagnosticCodes, diagnosticCodes, expectedDiagnosticMatched, expectedLintRuleIds, lintRuleIds: report.lintRuleIds, expectedLintRulesMatched, rejected: !report.valid, diagnostics: report.diagnostics });
    if (report.valid || !expectedDiagnosticMatched || !expectedLintRulesMatched) throw new Error(`C15 destructive control '${id}' did not reject through ${[...expectedDiagnosticCodes, ...expectedLintRuleIds].join(", ")}.`);
  }
  const continuationIndices = positive.spec.slides.map((slide, index) => slide.layout === "continuation" ? index : -1).filter((index) => index >= 0);
  check("drop-continuation", ["CA001", "CA004"], [], ({ spec }) => { spec.slides.splice(continuationIndices[0], 1); });
  check("duplicate-continuation", ["CA001"], [], ({ spec }) => { spec.slides.push(structuredClone(spec.slides[continuationIndices[0]])); });
  check("reorder-continuations", ["CA001"], [], ({ spec }) => { [spec.slides[continuationIndices[0]], spec.slides[continuationIndices[1]]] = [spec.slides[continuationIndices[1]], spec.slides[continuationIndices[0]]]; });
  check("tamper-source-hash", ["CA002"], [], ({ manifest: evidence }) => { evidence.sourceSha256 = "0".repeat(64); });
  check("tamper-chunk-ownership", ["CA002"], [], ({ manifest: evidence }) => { evidence.fields[0].locations[0].fieldPath = "callout"; });
  check("forged-fit", ["CA003", "CA005"], ["SW004"], ({ plan }) => { const body = plan.slides[0].shapes.find((shape) => shape.role === "body"); body.position.height = 1; body.fit.fits = true; });
  check("subminimum-type", ["CA003", "CA005"], ["SW002", "SW009"], ({ plan }) => { const body = plan.slides[0].shapes.find((shape) => shape.role === "body"); body.style.fontSizePt = body.fit.minSizePt - 1; });
  check("fractional-type", ["CA003", "CA005"], ["SW003"], ({ plan }) => { const body = plan.slides[0].shapes.find((shape) => shape.role === "body"); body.style.fontSizePt += 0.5; });
  check("text-overlap", ["CA003", "CA005"], ["SW018"], ({ plan }) => { const [title, body] = plan.slides[0].shapes.filter((shape) => shape.type === "text" && ["title", "body"].includes(shape.role)); body.position = { ...title.position }; });
  return controls;
}

async function runRasterControl(tools, positiveCase) {
  const controlDirectory = path.join(work, "controls", "rasterized-text");
  const deckPath = path.join(controlDirectory, "rasterized-text.pptx");
  const genericAuditPath = path.join(controlDirectory, "ooxml-audit.json");
  const planAuditPath = path.join(controlDirectory, "plan-audit.json");
  const previewDir = path.join(work, positiveCase.id, "previews");
  const planPath = path.join(work, positiveCase.id, "plan.json");
  await fs.mkdir(controlDirectory, { recursive: true });
  run(tools.python, [rasterizeControl, previewDir, deckPath]);
  run(tools.python, [auditPptx, deckPath, "--json", genericAuditPath], { expectedStatus: 2 });
  run(tools.python, [auditPlan, deckPath, planPath, "--json", planAuditPath], { expectedStatus: 2 });
  const [genericAudit, planAudit] = await Promise.all([
    fs.readFile(genericAuditPath, "utf8").then(JSON.parse),
    fs.readFile(planAuditPath, "utf8").then(JSON.parse),
  ]);
  const artifactHashes = [];
  for (const [sourceArtifact, name] of [[deckPath, "rasterized-text.pptx"], [genericAuditPath, "ooxml-audit.json"], [planAuditPath, "plan-audit.json"]]) {
    artifactHashes.push(await publishArtifact(sourceArtifact, `controls/rasterized-text/${name}`));
  }
  const rejected = genericAudit.valid === false
    && planAudit.valid === false
    && genericAudit.summary.pictures === positiveCase.adaptedSlideCount
    && planAudit.pictures === positiveCase.adaptedSlideCount
    && genericAudit.summary.nativeTextNodes === 0
    && planAudit.matchedTextObjects === 0;
  if (!rejected) throw new Error("C15 all-raster exported-PPTX control did not fail both native-text auditors.");
  return {
    id: "rasterized-text",
    expectedFailureSurface: ["generic OOXML native-text audit", "plan-bound OOXML object audit"],
    rejected,
    genericAuditValid: genericAudit.valid,
    planAuditValid: planAudit.valid,
    pictures: genericAudit.summary.pictures,
    nativeTextNodes: genericAudit.summary.nativeTextNodes,
    matchedTextObjects: planAudit.matchedTextObjects,
    artifactHashes,
  };
}

async function runSlideCeilingControl() {
  const controlDirectory = path.join(work, "controls", "slide-ceiling");
  const requestPath = path.join(controlDirectory, "request-input.json");
  const runDirectory = path.join(controlDirectory, "guarded-run");
  const request = {
    schemaVersion: "slidewright-request/v1",
    id: "c15-production-slide-ceiling",
    prompt: "Build this dense editable presentation while preserving the supplied formatting and quality gates.",
    spec: mutateFlexibleDeckCopy(source, 500),
  };
  await writeJson(requestPath, request);
  const execution = run(process.execPath, [cli, "request", requestPath, "--out", runDirectory], { expectedStatus: 2 });
  const runRecord = JSON.parse(await fs.readFile(path.join(runDirectory, "run.json"), "utf8"));
  const files = await listFiles(runDirectory);
  const forbidden = ["adapted-spec.json", "adaptation.json", "plan.json", "font-report.json", "lint-report.json", "deck.pptx", "audit.json", "plan-audit.json", "delivery.json", "DELIVERY.md", "previews"];
  const publishedForbiddenArtifacts = files.filter((file) => forbidden.some((item) => file === item || file.startsWith(`${item}/`)));
  const failedStage = runRecord.stages.find((stage) => stage.status === "failed");
  const ceilingDiagnostic = failedStage?.message ?? failedStage?.error ?? "";
  const rejected = runRecord.outcome === "failed"
    && runRecord.valid === false
    && /200-slide safety ceiling/u.test(ceilingDiagnostic)
    && publishedForbiddenArtifacts.length === 0;
  if (!rejected) throw new Error(`C15 production slide-ceiling control did not fail closed: ${JSON.stringify({ outcome: runRecord.outcome, ceilingDiagnostic, publishedForbiddenArtifacts })}`);
  const evidenceDirectory = path.join(staging, "controls", "slide-ceiling");
  await fs.mkdir(evidenceDirectory, { recursive: true });
  const sanitizedRun = {
    ...runRecord,
    artifacts: runRecord.artifacts,
    observedFiles: files,
    commandStatus: execution.status,
    publishedForbiddenArtifacts,
  };
  const sanitizedRunPath = path.join(controlDirectory, "run-normalized.json");
  await writeJson(sanitizedRunPath, sanitizedRun);
  const artifactHashes = [
    await publishArtifact(requestPath, "controls/slide-ceiling/request-input.json"),
    await publishArtifact(path.join(runDirectory, "request.json"), "controls/slide-ceiling/request.json"),
    await publishArtifact(path.join(runDirectory, "policy.json"), "controls/slide-ceiling/policy.json"),
    await publishArtifact(sanitizedRunPath, "controls/slide-ceiling/run-normalized.json"),
  ];
  return {
    rejected,
    productionMaxSlides: 200,
    outcome: runRecord.outcome,
    failingStage: failedStage?.name ?? null,
    ceilingDiagnostic,
    observedFiles: files,
    publishedForbiddenArtifacts,
    noDeckPublished: publishedForbiddenArtifacts.length === 0,
    artifactHashes,
  };
}

await fs.rm(work, { recursive: true, force: true });
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
run(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs")]);
const tools = { python: await pythonRuntime(), slidesTest: await findPresentationTool("slides_test.py"), montage: await findPresentationTool("create_montage.py") };
const cases = [];
for (const fixture of manifest.cases) {
  process.stdout.write(`C15 ${fixture.id}...\n`);
  cases.push(await runCase(fixture, tools));
}

const denseFixture = manifest.cases.find((item) => item.id === "dense-400");
const denseInput = await caseInput(denseFixture);
const densePositive = adaptDeckCopyToFit(denseInput);
const destructiveControls = runControls(denseInput, densePositive);
const densePositiveCase = cases.find((item) => item.id === "dense-400");
destructiveControls.push(await runRasterControl(tools, densePositiveCase));
const slideCeilingControl = await runSlideCeilingControl();

const implementationFiles = await collectC15WorkspaceImplementationFiles(root);
const implementationHashes = await Promise.all(implementationFiles
  .map(async (file) => ({ path: path.relative(root, file).split(path.sep).join("/"), sha256: await sha256File(file) })));
const runtimeBindings = await captureC15RuntimeBindings({ root, python: tools.python });
const reviewArtifactCount = cases.reduce((sum, item) => sum + item.reviewArtifacts.length, 0);
const scorecard = {
  schemaVersion: "slidewright-copy-resilience-scorecard/v1",
  suiteId: manifest.suiteId,
  implementationHashes,
  runtimeBindings,
  caseCount: cases.length,
  cases,
  destructiveControls,
  slideCeilingControl,
  reviewArtifactCount,
  reviewArtifactsReady: reviewArtifactCount === cases.reduce((sum, item) => sum + item.adaptedSlideCount, 0),
  limitations: manifest.limitations,
  valid: cases.every((item) => item.valid)
    && destructiveControls.length === manifest.destructiveControls.length
    && destructiveControls.every((item) => item.rejected && (item.expectedDiagnosticMatched ?? true) && (item.expectedLintRulesMatched ?? true))
    && slideCeilingControl.rejected
    && slideCeilingControl.noDeckPublished,
};
if (!scorecard.valid || !scorecard.reviewArtifactsReady) throw new Error("C15 scorecard did not close every required machine gate.");
scorecard.scorecardHash = sha256(Buffer.from(stableJson(scorecard), "utf8"));
await writeJson(path.join(staging, "scorecard.json"), scorecard);
const finalRun = await publishVersionedEvidence(staging, published, scorecard.scorecardHash, { currentSchemaVersion: "slidewright-copy-resilience-current/v1" });
await fs.rm(work, { recursive: true, force: true });
process.stdout.write(`C15 machine benchmark passed: ${cases.length} cases, ${reviewArtifactCount} full-size review slides, ${destructiveControls.length} destructive controls, scorecard ${scorecard.scorecardHash}.\nPublished ${finalRun}\n`);
