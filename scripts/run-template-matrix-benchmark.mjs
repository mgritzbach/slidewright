#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TEMPLATE_MATRIX_IMPLEMENTATION_PATHS,
  canonicalHash,
  expectedTemplateMatrixClosurePaths,
  inventoryTree,
  loadValidatedRejectedSources,
  readJson,
  sha256File,
  validateTemplateMatrixManifest,
  verifyTemplateMatrixEvidence,
} from "./lib/template-matrix-evidence.mjs";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "template", "c10-v1");
const manifestPath = path.join(fixtureRoot, "manifest.json");
const published = path.join(root, "outputs", "template-matrix");
const staging = path.join(published, "runs", `.staging-${process.pid}-${Date.now()}`);
const scriptRoot = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");
const profileScripts = path.join(scriptRoot, "design_profile");
const templateScripts = path.join(scriptRoot, "template");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }

function run(command, args, options = {}) {
  process.stdout.write(`C10: ${options.label ?? path.basename(args[0] ?? command)}\n`);
  const completed = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (completed.stdout) process.stdout.write(completed.stdout);
  if (completed.stderr) process.stderr.write(completed.stderr);
  if (completed.error) throw completed.error;
  if (completed.status !== (options.expectedStatus ?? 0)) throw new Error(`${command} ${args.join(" ")} exited ${completed.status}.`);
  return completed;
}

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not locate presentation runtime tool ${name}.`);
}

async function render(renderTool, deck, outputDirectory) {
  await fs.rm(outputDirectory, { recursive: true, force: true });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const completed = spawnSync(python, [renderTool, deck], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (completed.stdout) process.stdout.write(completed.stdout);
    if (completed.stderr) process.stderr.write(completed.stderr);
    if (!completed.error && completed.status === 0) return;
    if (attempt === 3) throw completed.error ?? new Error(`Rendering ${deck} failed with ${completed.status}.`);
    await fs.rm(outputDirectory, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

async function implementationClosure(rawManifest) {
  const records = [];
  for (const relative of await expectedTemplateMatrixClosurePaths(root, rawManifest)) {
    const absolute = path.join(root, ...relative.split("/"));
    await fs.access(absolute);
    records.push({ path: relative, sha256: await sha256File(absolute) });
  }
  return records;
}

await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
try {
  const rawManifest = await readJson(manifestPath);
  const manifest = validateTemplateMatrixManifest(rawManifest);
  const renderTool = await findPresentationTool("render_slides.py");
  const slidesTest = await findPresentationTool("slides_test.py");
  const montageTool = await findPresentationTool("create_montage.py");
  const fixtureReports = [];
  const reviewArtifacts = [];

  for (const fixture of manifest.fixtures) {
    const fixtureOutput = path.join(staging, "fixtures", fixture.id);
    await fs.mkdir(fixtureOutput, { recursive: true });
    const sourceOriginal = path.join(fixtureRoot, fixture.sourceFile);
    const source = path.join(fixtureOutput, "source.pptx");
    const edited = path.join(fixtureOutput, "edited.pptx");
    const roundtrip = path.join(fixtureOutput, "powerpoint-roundtrip.pptx");
    const roundtripRepeat = path.join(fixtureOutput, "powerpoint-roundtrip-repeat.pptx");
    const plan = path.join(fixtureRoot, fixture.editPlan);
    const profileA = path.join(fixtureOutput, "source-profile-a.json");
    const profileB = path.join(fixtureOutput, "source-profile-b.json");
    let sanitizerRebuildValid = fixture.distribution === "unmodified-upstream-binary";
    if (fixture.distribution !== "unmodified-upstream-binary") {
      const upstream = path.join(fixtureRoot, fixture.source.upstreamFile);
      const rebuilt = path.join(fixtureOutput, "sanitizer-rebuilt-source.pptx");
      const upstreamStat = await fs.stat(upstream);
      if (await sha256File(upstream) !== fixture.source.upstreamSha256 || upstreamStat.size !== fixture.source.upstreamBytes) {
        throw new Error(`C10 fixture ${fixture.id} vendored upstream hash or byte count drifted.`);
      }
      const sanitizerArguments = fixture.source.sanitizerArguments.map((item) => item === "{input}" ? upstream : item === "{output}" ? rebuilt : item);
      run(python, [path.join(fixtureRoot, fixture.source.sanitizer), ...sanitizerArguments], { label: `${fixture.id} deterministic sanitizer rebuild` });
      sanitizerRebuildValid = await sha256File(rebuilt) === fixture.sourceSha256
        && (await fs.readFile(rebuilt)).equals(await fs.readFile(sourceOriginal));
      if (!sanitizerRebuildValid) throw new Error(`C10 fixture ${fixture.id} sanitizer rebuild did not reproduce the curated source exactly.`);
    }
    await fs.copyFile(sourceOriginal, source);
    const sourceHashValid = await sha256File(sourceOriginal) === fixture.sourceSha256 && await sha256File(source) === fixture.sourceSha256;
    if (!sourceHashValid) throw new Error(`C10 fixture ${fixture.id} source hash drifted.`);
    const licenseText = await fs.readFile(path.join(fixtureRoot, fixture.license.file), "utf8");
    const licenseHashValid = fixture.license.spdx === "MIT" ? /MIT License/u.test(licenseText) : licenseText.includes(fixture.license.spdx);
    if (!licenseHashValid) throw new Error(`C10 fixture ${fixture.id} license notice does not match its declared SPDX identity.`);

    for (const profile of [profileA, profileB]) {
      run(python, [path.join(profileScripts, "extract_design_profile.py"), source, "--out", profile, "--quiet"], { label: `${fixture.id} profile` });
    }
    const profileDeterministic = (await fs.readFile(profileA)).equals(await fs.readFile(profileB));
    if (!profileDeterministic) throw new Error(`C10 fixture ${fixture.id} profile extraction is nondeterministic.`);
    const profile = await readJson(profileA);
    const editPlan = await readJson(plan);
    if (editPlan.sourceSha256 !== fixture.sourceSha256) throw new Error(`C10 fixture ${fixture.id} edit plan is not source-bound.`);
    run(python, [path.join(templateScripts, "edit_template.py"), source, plan, edited, "--json", path.join(fixtureOutput, "edit-report.json")], { label: `${fixture.id} edit` });
    run(python, [path.join(profileScripts, "audit_design_profile.py"), source, edited, "--profile", profileA, "--edit-plan", plan, "--json", path.join(fixtureOutput, "package-audit.json")], { label: `${fixture.id} package audit` });
    run(python, [path.join(profileScripts, "template_matrix_negative_controls.py"), source, edited, profileA, plan, "--out-dir", path.join(fixtureOutput, "negative-controls"), "--json", path.join(fixtureOutput, "negative-controls.json")], { label: `${fixture.id} destructive controls` });

    if (process.platform !== "win32") throw new Error("C10 requires installed Microsoft PowerPoint on Windows.");
    run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(templateScripts, "powerpoint_template_matrix_roundtrip.ps1"),
      "-InputPptx", edited, "-OutputPptx", roundtrip, "-ReportJson", path.join(fixtureOutput, "powerpoint-roundtrip.json"),
      "-OwnershipRecordJson", path.join(fixtureOutput, "powerpoint-ownership.json"), "-FixtureId", fixture.id], { label: `${fixture.id} PowerPoint round trip` });
    run(python, [path.join(templateScripts, "audit_powerpoint_roundtrip_semantics.py"), edited, roundtrip,
      "--json", path.join(fixtureOutput, "powerpoint-semantic-audit.json")], { label: `${fixture.id} PowerPoint OOXML semantic audit` });
    run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(templateScripts, "powerpoint_template_matrix_roundtrip.ps1"),
      "-InputPptx", edited, "-OutputPptx", roundtripRepeat, "-ReportJson", path.join(fixtureOutput, "powerpoint-roundtrip-repeat.json"),
      "-OwnershipRecordJson", path.join(fixtureOutput, "powerpoint-ownership-repeat.json"), "-FixtureId", `${fixture.id}-repeat`], { label: `${fixture.id} repeated PowerPoint round trip` });
    run(python, [path.join(templateScripts, "audit_powerpoint_roundtrip_semantics.py"), edited, roundtripRepeat,
      "--json", path.join(fixtureOutput, "powerpoint-semantic-audit-repeat.json")], { label: `${fixture.id} repeated PowerPoint OOXML semantic audit` });
    run(python, [path.join(templateScripts, "powerpoint_roundtrip_semantic_controls.py"), edited, roundtrip,
      "--out-dir", path.join(fixtureOutput, "powerpoint-semantic-controls"), "--json", path.join(fixtureOutput, "powerpoint-semantic-controls.json")], { label: `${fixture.id} PowerPoint semantic destructive controls` });

    const visibleNegativeDeck = path.join(fixtureOutput, "visible-negative.pptx");
    await fs.copyFile(path.join(fixtureOutput, "negative-controls", "visible-geometry-drift.pptx"), visibleNegativeDeck);
    const renderSets = [
      ["source", source], ["edited", edited], ["powerpoint-roundtrip", roundtrip],
      ["powerpoint-roundtrip-repeat", roundtripRepeat],
      ["visible-negative", visibleNegativeDeck],
    ];
    for (const [id, deck] of renderSets) {
      const directory = path.join(fixtureOutput, id);
      await render(renderTool, deck, directory);
      run(python, [slidesTest, deck], { label: `${fixture.id} ${id} slides_test` });
      const pngs = (await fs.readdir(directory)).filter((name) => /^slide-\d+\.png$/u.test(name)).sort((left, right) => Number(left.match(/\d+/u)[0]) - Number(right.match(/\d+/u)[0]));
      if (pngs.length !== fixture.expected.slideCount) throw new Error(`C10 fixture ${fixture.id}/${id} rendered ${pngs.length} of ${fixture.expected.slideCount} slides.`);
      for (const name of pngs) {
        const relative = path.relative(staging, path.join(directory, name)).replaceAll("\\", "/");
        reviewArtifacts.push({ fixtureId: fixture.id, deck: id, slide: Number(name.match(/\d+/u)[0]), path: relative, sha256: await sha256File(path.join(directory, name)) });
      }
    }
    if (editPlan.mode === "preserve-source-deck") {
      run(python, [path.join(templateScripts, "compare_exact_renders.py"), path.join(fixtureOutput, "source"), path.join(fixtureOutput, "edited"), "--slides", String(fixture.expected.slideCount), "--minimum", "1", "--json", path.join(fixtureOutput, "visual-audit.json"), "--out-dir", path.join(fixtureOutput, "visual-diff")], { label: `${fixture.id} exact preservation visual audit` });
    } else {
      run(python, [path.join(templateScripts, "compare_template_renders.py"), source, plan, path.join(fixtureOutput, "source"), path.join(fixtureOutput, "edited"), "--json", path.join(fixtureOutput, "visual-audit.json"), "--out-dir", path.join(fixtureOutput, "visual-diff")], { label: `${fixture.id} source/edit visual audit` });
    }
    run(python, [path.join(templateScripts, "compare_exact_renders.py"), path.join(fixtureOutput, "edited"), path.join(fixtureOutput, "powerpoint-roundtrip"), "--slides", String(fixture.expected.slideCount), "--minimum", "1", "--json", path.join(fixtureOutput, "roundtrip-visual-audit.json"), "--out-dir", path.join(fixtureOutput, "roundtrip-visual-diff")], { label: `${fixture.id} exact PowerPoint visual audit` });
    run(python, [path.join(templateScripts, "compare_exact_renders.py"), path.join(fixtureOutput, "edited"), path.join(fixtureOutput, "powerpoint-roundtrip-repeat"), "--slides", String(fixture.expected.slideCount), "--minimum", "1", "--json", path.join(fixtureOutput, "roundtrip-repeat-visual-audit.json"), "--out-dir", path.join(fixtureOutput, "roundtrip-repeat-visual-diff")], { label: `${fixture.id} exact repeated PowerPoint visual audit` });
    const visibleNegative = spawnSync(python, [path.join(templateScripts, "compare_exact_renders.py"), path.join(fixtureOutput, "edited"), path.join(fixtureOutput, "visible-negative"), "--slides", String(fixture.expected.slideCount), "--minimum", "1", "--json", path.join(fixtureOutput, "visible-negative-audit.json"), "--out-dir", path.join(fixtureOutput, "visible-negative-diff")], { cwd: root, encoding: "utf8", windowsHide: true });
    if (visibleNegative.stdout) process.stdout.write(visibleNegative.stdout);
    if (visibleNegative.stderr) process.stderr.write(visibleNegative.stderr);
    if (visibleNegative.status !== 1) throw new Error(`C10 fixture ${fixture.id} visible corruption was not rejected.`);
    run(python, [montageTool, "--input_dir", path.join(fixtureOutput, "edited"), "--output_file", path.join(fixtureOutput, "montage.png")], { label: `${fixture.id} montage overview` });

    const [audit, negatives, powerPoint, powerPointRepeat, powerPointSemantic, powerPointSemanticRepeat, powerPointSemanticControls, visual, roundtripVisual, roundtripRepeatVisual, visibleNegativeReport] = await Promise.all([
      readJson(path.join(fixtureOutput, "package-audit.json")), readJson(path.join(fixtureOutput, "negative-controls.json")),
      readJson(path.join(fixtureOutput, "powerpoint-roundtrip.json")), readJson(path.join(fixtureOutput, "powerpoint-roundtrip-repeat.json")),
      readJson(path.join(fixtureOutput, "powerpoint-semantic-audit.json")), readJson(path.join(fixtureOutput, "powerpoint-semantic-audit-repeat.json")),
      readJson(path.join(fixtureOutput, "powerpoint-semantic-controls.json")), readJson(path.join(fixtureOutput, "visual-audit.json")),
      readJson(path.join(fixtureOutput, "roundtrip-visual-audit.json")), readJson(path.join(fixtureOutput, "roundtrip-repeat-visual-audit.json")),
      readJson(path.join(fixtureOutput, "visible-negative-audit.json")),
    ]);
    const inventory = {
      slideCount: profile.slides.length,
      masterCount: profile.masters.length,
      layoutCount: profile.layouts.length,
      themeCount: profile.themes.length,
      placeholderCount: profile.objects.filter((item) => item.placeholder).length,
      chartCount: profile.objects.filter((item) => item.semanticKind === "chart").length,
      tableCount: profile.objects.filter((item) => item.semanticKind === "table").length,
      mediaCount: profile.assets.media.length,
      groupCount: profile.assets.groups.length,
      spacingRecordCount: profile.spacing.records.length,
      inheritanceChainCount: profile.presentation.inheritanceChains.length,
    };
    fixtureReports.push({
      id: fixture.id,
      expected: fixture.expected,
      inventory,
      licensed: licenseHashValid && Boolean(fixture.license.spdx && fixture.license.sourceUrl),
      sourceHashValid,
      sanitizerRebuildValid,
      profileDeterministic,
      editAuditValid: audit.valid === true && audit.summary?.planBound === true && audit.summary?.authorizedTextShapes === editPlan.edits.length,
      retained: audit.summary,
      negativeControlsValid: negatives.valid === true,
      negativeControls: negatives.controls.map(({ name, applicable, rejected, exitCode, failureFields, rejectionMode, reason }) => ({
        name, applicable, rejected,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(failureFields ? { failureFields } : {}),
        ...(rejectionMode ? { rejectionMode } : {}),
        ...(reason ? { reason } : {}),
      })),
      visualAuditValid: visual.valid === true,
      powerpointRoundtripValid: powerPoint.valid === true && powerPoint.automationProcessOwned === true
        && powerPoint.ownership?.preexistingPowerPointProcessCount === 0 && powerPoint.ownedProcessExitedNaturally === true
        && powerPoint.hiddenAndEmptyAfterClose === true && powerPoint.exactLiveSemanticStatePreserved === true,
      powerpointRepeatRoundtripValid: powerPointRepeat.valid === true && powerPointRepeat.automationProcessOwned === true
        && powerPointRepeat.ownership?.preexistingPowerPointProcessCount === 0 && powerPointRepeat.ownedProcessExitedNaturally === true
        && powerPointRepeat.hiddenAndEmptyAfterClose === true && powerPointRepeat.exactLiveSemanticStatePreserved === true,
      powerpointSemanticAuditValid: powerPointSemantic.valid === true,
      powerpointSemanticAuditSha256: powerPointSemantic.semanticAuditSha256,
      powerpointSemanticRepeatAuditValid: powerPointSemanticRepeat.valid === true,
      powerpointSemanticRepeatAuditSha256: powerPointSemanticRepeat.semanticAuditSha256,
      powerpointSemanticControlsValid: powerPointSemanticControls.valid === true,
      powerpointSemanticControls: powerPointSemanticControls.controls,
      powerpointVisualAuditValid: roundtripVisual.valid === true,
      powerpointRepeatVisualAuditValid: roundtripRepeatVisual.valid === true,
      visibleNegativeRejected: visibleNegativeReport.valid === false && visibleNegativeReport.slides.some((item) => item.valid === false),
      slidesTestValid: true,
    });
  }

  const closure = await implementationClosure(rawManifest);
  const scorecard = {
    schemaVersion: "slidewright-template-matrix-scorecard/v1",
    machineValid: false,
    reviewArtifactsReady: false,
    fixtureManifestSha256: await sha256File(manifestPath),
    rejectedSources: await loadValidatedRejectedSources(root, manifest),
    fixtures: fixtureReports,
    reviewArtifacts: reviewArtifacts.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId) || left.deck.localeCompare(right.deck) || left.slide - right.slide),
    implementationClosure: closure,
    implementationClosureHash: canonicalHash(closure),
  };
  const aggregateControls = new Map();
  for (const fixture of fixtureReports) for (const control of fixture.negativeControls) {
    if (!aggregateControls.has(control.name)) aggregateControls.set(control.name, false);
    if (control.applicable && control.rejected) aggregateControls.set(control.name, true);
  }
  const aggregateSemanticControls = new Map();
  for (const fixture of fixtureReports) for (const control of fixture.powerpointSemanticControls) {
    if (!aggregateSemanticControls.has(control.name)) aggregateSemanticControls.set(control.name, false);
    if (control.applicable && control.rejected && control.intendedFailureFound) aggregateSemanticControls.set(control.name, true);
  }
  scorecard.machineValid = fixtureReports.length === 4
    && fixtureReports.every((item) => item.licensed && item.sourceHashValid && item.sanitizerRebuildValid && item.profileDeterministic && item.editAuditValid
      && item.negativeControlsValid && item.visualAuditValid && item.powerpointRoundtripValid && item.powerpointRepeatRoundtripValid
      && item.powerpointSemanticAuditValid && item.powerpointSemanticRepeatAuditValid
      && item.powerpointSemanticControlsValid && item.powerpointVisualAuditValid && item.powerpointRepeatVisualAuditValid
      && item.visibleNegativeRejected && item.slidesTestValid)
    && [...aggregateControls.values()].every(Boolean)
    && ["chart-semantic-drift", "embedded-workbook-drift", "table-cell-drift", "hyperlink-target-drift", "media-byte-drift", "native-object-editability-drift"]
      .every((name) => aggregateSemanticControls.get(name) === true);
  scorecard.reviewArtifactsReady = scorecard.machineValid && scorecard.reviewArtifacts.length === fixtureReports.reduce((sum, item) => sum + item.expected.slideCount * 5, 0);
  if (!scorecard.machineValid || !scorecard.reviewArtifactsReady) throw new Error("C10 machine scorecard is incomplete.");
  scorecard.artifactInventory = await inventoryTree(staging, new Set(["scorecard.json"]));
  scorecard.scorecardHash = canonicalHash(scorecard);
  await fs.writeFile(path.join(staging, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  await verifyTemplateMatrixEvidence({ root, runDirectory: staging, requireCurrentSource: true });
  const finalDirectory = path.join(published, "runs", scorecard.scorecardHash);
  try { await fs.access(finalDirectory); throw new Error(`C10 immutable run already exists: ${scorecard.scorecardHash}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await fs.rename(staging, finalDirectory);
  await fs.mkdir(published, { recursive: true });
  await fs.writeFile(path.join(published, "current.json"), `${JSON.stringify({ schemaVersion: "slidewright-template-matrix-current/v1", scorecardHash: scorecard.scorecardHash, run: `runs/${scorecard.scorecardHash}` }, null, 2)}\n`, "utf8");
  await fs.copyFile(path.join(finalDirectory, "scorecard.json"), path.join(published, "scorecard.json"));
  process.stdout.write(`C10 machine benchmark passed: ${scorecard.scorecardHash}\n`);
} catch (error) {
  if (process.env.SLIDEWRIGHT_KEEP_FAILED_TEMPLATE_MATRIX === "1") process.stderr.write(`C10 retained failed staging evidence at ${staging}\n`);
  else await fs.rm(staging, { recursive: true, force: true });
  throw error;
}
