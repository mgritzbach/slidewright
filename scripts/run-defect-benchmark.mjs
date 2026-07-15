#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan, QUALITY_THRESHOLDS } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { renderPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/renderer.mjs";
import { negativeQualityFixtures, readableChartPlan } from "../tests/fixtures/quality-linter-fixtures.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "defects");
const cleanPreview = path.join(output, "clean");
const chartPreview = path.join(output, "chart-components");
const falsePreview = path.join(output, "false-fit-preview");
const cleanPptx = path.join(output, "slidewright-defects-clean.pptx");
const chartPptx = path.join(output, "slidewright-chart-components.pptx");
const falsePptx = path.join(output, "false-fit-must-not-exist.pptx");
const clippedPptx = path.join(output, "powerpoint-clipped-must-not-survive.pptx");
const manifest = JSON.parse(await fs.readFile(path.join(root, "fixtures", "defects", "c14-v1", "fixture-manifest.json"), "utf8"));
const spec = JSON.parse(await fs.readFile(path.join(root, "examples", "demo", "deck-spec.json"), "utf8"));
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* PATH fallback */ }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

function runExpectFailure(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`${command} ${args.join(" ")} unexpectedly passed.`);
}

async function findTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not find ${name} in the Codex presentation runtime.`);
}

function stable(value) {
  return JSON.stringify(value);
}

const expectedPositiveFixtures = [
  "demo-layout",
  "readable-horizontal-chart-component",
  "readable-vertical-chart-component",
  "rendered-clean-deck",
  "powerpoint-text-bounds",
];
const expectedNegativeFixtures = [
  ...negativeQualityFixtures.map(({ id, ruleId }) => ({ id, ruleId })),
  { id: "false-fit-after-render", ruleId: "SW013" },
  { id: "actual-powerpoint-text-clipping", ruleId: "POWERPOINT_TEXT_BOUNDS" },
];
if (stable(manifest.positiveFixtures) !== stable(expectedPositiveFixtures)) throw new Error("C14 positive fixture manifest does not match the implemented benchmark.");
if (stable(manifest.negativeFixtures) !== stable(expectedNegativeFixtures)) throw new Error("C14 negative fixture manifest does not match the implemented benchmark.");
if (stable(manifest.thresholds) !== stable(QUALITY_THRESHOLDS)) throw new Error("C14 threshold manifest does not match the linter constants.");
if (!Number.isInteger(manifest.repetitions) || manifest.repetitions < 3) throw new Error("C14 requires at least three deterministic repetitions.");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const cleanPlan = compileDeck(spec);
const chartPlan = readableChartPlan();
const positiveReports = {
  demo: lintPlan(cleanPlan),
  charts: lintPlan(chartPlan),
};
if (!positiveReports.demo.valid || !positiveReports.charts.valid) throw new Error("A positive C14 fixture failed plan lint.");

const negatives = [];
for (const fixture of negativeQualityFixtures) {
  const runs = Array.from({ length: manifest.repetitions }, () => lintPlan(fixture.build()));
  if (!runs.every((report) => stable(report.diagnostics) === stable(runs[0].diagnostics))) throw new Error(`${fixture.id} diagnostics are nondeterministic.`);
  if (stable(runs[0].diagnostics) !== stable([fixture.expectedDiagnostic])) throw new Error(`${fixture.id} diagnostics do not match the exact fixture contract.`);
  const ruleIds = [...new Set(runs[0].diagnostics.map((item) => item.ruleId))];
  if (stable(ruleIds) !== stable([fixture.ruleId])) throw new Error(`${fixture.id} did not fail only ${fixture.ruleId}: ${ruleIds.join(", ")}`);
  negatives.push({ id: fixture.id, ruleId: fixture.ruleId, diagnostics: runs[0].diagnostics });
}

await renderPlan(cleanPlan, { out: cleanPptx, previewDir: cleanPreview });
const renderedClean = JSON.parse(await fs.readFile(path.join(cleanPreview, "rendered-lint-report.json"), "utf8"));
if (!renderedClean.valid) throw new Error("Clean deck failed rendered-layout lint.");
await renderPlan(chartPlan, { out: chartPptx, previewDir: chartPreview });
const renderedCharts = JSON.parse(await fs.readFile(path.join(chartPreview, "rendered-lint-report.json"), "utf8"));
if (!renderedCharts.valid || renderedCharts.renderedSlides !== 2) throw new Error("Horizontal/vertical chart components failed rendered-layout lint.");

const falsePlan = compileDeck(spec);
const falseTitle = falsePlan.slides[0].shapes.find((shape) => shape.role === "title");
falseTitle.fit.maxLines = 1;
falseTitle.fit.lines = 1;
falseTitle.fit.glyphFactor = 0.1;
falseTitle.fit.fits = true;
if (!lintPlan(falsePlan).valid) throw new Error("False-fit fixture must pass plan lint to exercise rendered-layout lint.");
let falseRejected = false;
try {
  await renderPlan(falsePlan, { out: falsePptx, previewDir: falsePreview });
} catch (error) {
  falseRejected = /rendered layout/u.test(error.message);
}
if (!falseRejected) throw new Error("False-fit rendered fixture was not rejected.");
try { await fs.access(falsePptx); throw new Error("False-fit fixture emitted a deliverable PPTX."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const falseReport = JSON.parse(await fs.readFile(path.join(falsePreview, "rendered-lint-report.json"), "utf8"));
const expectedFalseDiagnostic = {
  ruleId: "SW013",
  severity: "error",
  slideId: "promise",
  objectId: falseTitle.id,
  message: "Text wraps to 2 lines but the contract allows 1.",
  suggestion: "Shorten the copy, widen the text frame, or choose a layout that explicitly permits more lines.",
};
if (stable(falseReport.diagnostics) !== stable([expectedFalseDiagnostic])) throw new Error("False-fit fixture did not emit the exact SW013 rendered-layout diagnostic.");

const slidesTest = await findTool("slides_test.py");
run(python, [slidesTest, cleanPptx]);
run(python, [slidesTest, chartPptx]);
run("python", [path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py"), cleanPptx, "--json", path.join(output, "ooxml-audit.json")]);
const powerPointExe = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
try { await fs.access(powerPointExe); } catch { throw new Error("Microsoft PowerPoint is required for the C14 text-bound proof."); }
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "powerpoint-text-bounds.ps1"), "-InputPptx", cleanPptx, "-ReportJson", path.join(output, "powerpoint-text-bounds.json")]);
const powerPointBounds = JSON.parse((await fs.readFile(path.join(output, "powerpoint-text-bounds.json"), "utf8")).replace(/^\uFEFF/u, ""));
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "powerpoint-text-bounds.ps1"), "-InputPptx", chartPptx, "-ReportJson", path.join(output, "powerpoint-chart-text-bounds.json")]);
const powerPointChartBounds = JSON.parse((await fs.readFile(path.join(output, "powerpoint-chart-text-bounds.json"), "utf8")).replace(/^\uFEFF/u, ""));
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "make-powerpoint-clipped-fixture.ps1"), "-InputPptx", cleanPptx, "-OutputPptx", clippedPptx]);
runExpectFailure("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "powerpoint-text-bounds.ps1"), "-InputPptx", clippedPptx, "-ReportJson", path.join(output, "powerpoint-clipped-text-bounds.json")]);
const clippedBounds = JSON.parse((await fs.readFile(path.join(output, "powerpoint-clipped-text-bounds.json"), "utf8")).replace(/^\uFEFF/u, ""));
if (clippedBounds.valid || !clippedBounds.items.some((item) => item.shape === "s1-title" && item.heightFits === false)) throw new Error("Actual PowerPoint clipping fixture did not fail on s1-title.");
await fs.rm(clippedPptx, { force: true });
try { await fs.access(clippedPptx); throw new Error("Rejected clipped PowerPoint survived as a deliverable."); } catch (error) { if (error.code !== "ENOENT") throw error; }

const scorecardCore = {
  valid: true,
  fixtureVersion: manifest.version,
  positivePlanFixtures: 3,
  positiveProofFixtures: expectedPositiveFixtures.length,
  negativePlanFixtures: negatives.length,
  negativeProofFixtures: expectedNegativeFixtures.length,
  negativeRules: negatives.map((item) => ({ id: item.id, ruleId: item.ruleId })),
  negativeProofs: expectedNegativeFixtures,
  deterministicRepetitions: manifest.repetitions,
  renderedClean: { valid: renderedClean.valid, slides: renderedClean.renderedSlides },
  renderedChartComponents: { valid: renderedCharts.valid, slides: renderedCharts.renderedSlides, nativeEditableObjects: chartPlan.slides.reduce((count, slide) => count + slide.shapes.length, 0) },
  renderedFalseFit: { rejected: true, emittedPptx: false, ruleId: "SW013", objectId: falseTitle.id },
  powerPointTextBounds: { valid: powerPointBounds.valid, slides: powerPointBounds.slides, textShapes: powerPointBounds.textShapes },
  powerPointChartTextBounds: { valid: powerPointChartBounds.valid, slides: powerPointChartBounds.slides, textShapes: powerPointChartBounds.textShapes },
  powerPointClippingNegative: { rejected: true, emittedPptx: false, shape: "s1-title" },
  thresholds: manifest.thresholds,
};
const scorecardHash = crypto.createHash("sha256").update(stable(scorecardCore)).digest("hex");
await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify({ ...scorecardCore, scorecardHash }, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(output, "negative-diagnostics.json"), `${JSON.stringify(negatives, null, 2)}\n`, "utf8");
process.stdout.write(`C14 defect benchmark passed with scorecard ${scorecardHash}\n`);
