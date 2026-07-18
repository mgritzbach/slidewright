#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { auditFonts } from "../plugins/slidewright/skills/slidewright/scripts/lib/font-audit.mjs";
import { verifyFontIntegrityEvidence } from "./verify-font-integrity-evidence.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "font-integrity");
const powerpointOutput = path.join(output, "powerpoint");
const fixtureDir = path.join(root, "fixtures", "fonts", "lato-v1");
const fixtureManifest = path.join(fixtureDir, "fixture-manifest.json");
const pythonTool = path.join(root, "scripts", "font-integrity", "font_integrity_pptx.py");
const powerPointTool = path.join(root, "scripts", "font-integrity", "powerpoint-font-integrity.ps1");
const powerPointReportPath = path.join(output, "powerpoint-report.json");
const fullSizeReviewPath = path.join(root, "evidence", "font-integrity", "v1", "full-size-review.json");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* PATH fallback */ }

function run(command, args, { expectedStatus = 0, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== expectedStatus) {
    const detail = capture ? `\nstdout: ${result.stdout ?? ""}\nstderr: ${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} returned ${result.status}; expected ${expectedStatus}.${detail}`);
  }
  return result;
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Could not locate ${name} in the bundled presentation runtime.`);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(candidate) {
  return sha256(await fs.readFile(candidate));
}

function relative(candidate) {
  return path.relative(root, candidate).split(path.sep).join("/");
}

async function artifact(candidate, kind) {
  return { path: relative(candidate), sha256: await sha256File(candidate), kind };
}

async function readJson(candidate) {
  return JSON.parse((await fs.readFile(candidate, "utf8")).replace(/^\uFEFF/u, ""));
}

async function auditDeck(deckPath, reportPath, expectedStatus = 0) {
  run(python, [pythonTool, "audit", deckPath, "--fixture-dir", fixtureDir, "--manifest", fixtureManifest, "--json", reportPath], { expectedStatus, capture: expectedStatus !== 0 });
  return readJson(reportPath);
}

const expectedParent = path.resolve(root, "outputs");
if (path.dirname(output) !== expectedParent) throw new Error(`Unsafe C11 output path: ${output}`);
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(powerpointOutput, { recursive: true });

run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powerPointTool, "-FixtureDir", fixtureDir, "-OutputDir", powerpointOutput, "-ReportJson", powerPointReportPath]);

const decks = {
  source: path.join(powerpointOutput, "font-integrity-source.pptx"),
  roundtrip1: path.join(powerpointOutput, "font-integrity-roundtrip-1.pptx"),
  roundtrip2: path.join(powerpointOutput, "font-integrity-roundtrip-2.pptx"),
  missingFontControl: path.join(powerpointOutput, "font-integrity-missing-font-control.pptx"),
};
const auditPaths = Object.fromEntries(Object.keys(decks).map((name) => [name, path.join(output, `${name}-audit.json`)]));
const audits = {
  source: await auditDeck(decks.source, auditPaths.source),
  roundtrip1: await auditDeck(decks.roundtrip1, auditPaths.roundtrip1),
  roundtrip2: await auditDeck(decks.roundtrip2, auditPaths.roundtrip2),
  missingFontControl: await auditDeck(decks.missingFontControl, auditPaths.missingFontControl, 2),
};

const destructiveControls = [];
const expectedMutantRule = {
  "remove-embedded": "SWF123",
  "truncate-embedded": "SWF124",
  "substitute-visible": "SWF130",
};
for (const [mode, expectedRuleId] of Object.entries(expectedMutantRule)) {
  const mutant = path.join(output, `mutant-${mode}.pptx`);
  const report = path.join(output, `mutant-${mode}-audit.json`);
  run(python, [pythonTool, "mutate", decks.roundtrip2, "--out", mutant, "--mode", mode, "--family", "Slidewright Fixture Sans"]);
  const mutantAudit = await auditDeck(mutant, report, 2);
  destructiveControls.push({ mode, expectedRuleId, pptx: relative(mutant), audit: mutantAudit, auditPath: relative(report) });
}

const fontAuditControl = auditFonts({
  theme: { fontFamily: "Slidewright Definitely Missing Sans 9F24", fallbackFontFamily: "Arial" },
  slides: [{ shapes: [{ type: "text", style: { typeface: "Slidewright Definitely Missing Sans 9F24" }, text: { runs: [{ text: "This control must never render through substitution." }] } }] }],
}, ["Arial"]);
await fs.writeFile(path.join(output, "slidewright-missing-font-audit.json"), `${JSON.stringify(fontAuditControl, null, 2)}\n`, "utf8");

const renderTool = await findPresentationTool("render_slides.py");
const slidesTest = await findPresentationTool("slides_test.py");
const renderProof = { states: [], slidesPerState: 2, overflowChecks: 0 };
for (const state of ["source", "roundtrip1", "roundtrip2"]) {
  run(python, [renderTool, decks[state]]);
  run(python, [slidesTest, decks[state]]);
  renderProof.overflowChecks += 1;
  const renderDir = path.join(powerpointOutput, path.basename(decks[state], ".pptx"));
  const slides = [];
  for (let slide = 1; slide <= 2; slide += 1) {
    const image = path.join(renderDir, `slide-${slide}.png`);
    slides.push({ slide, path: relative(image), sha256: await sha256File(image) });
  }
  renderProof.states.push({ state, slides });
}

const powerPointRaw = await readJson(powerPointReportPath);
const fullSizeReview = await readJson(fullSizeReviewPath);
const powerPoint = {
  valid: powerPointRaw.valid,
  application: powerPointRaw.application,
  family: powerPointRaw.family,
  embeddedSaveRequested: powerPointRaw.embeddedSaveRequested,
  cycles: powerPointRaw.cycles,
  sourceSha256: powerPointRaw.sourceSha256,
  roundtrip1Sha256: powerPointRaw.roundtrip1Sha256,
  roundtrip2Sha256: powerPointRaw.roundtrip2Sha256,
  missingControlSha256: powerPointRaw.missingControlSha256,
  statesEqual: powerPointRaw.statesEqual,
};

const implementationFiles = [
  path.join(root, "scripts", "run-font-integrity-benchmark.mjs"),
  path.join(root, "scripts", "verify-font-integrity-evidence.mjs"),
  pythonTool,
  powerPointTool,
  fixtureManifest,
  path.join(fixtureDir, "PROVENANCE.md"),
  path.join(fixtureDir, "OFL.txt"),
  ...["SWFixture-Regular.ttf", "SWFixture-Bold.ttf", "SWFixture-Italic.ttf", "SWFixture-BoldItalic.ttf"].map((name) => path.join(fixtureDir, name)),
  path.join(root, "tests", "font-integrity.test.mjs"),
];
const artifacts = [];
for (const candidate of implementationFiles) artifacts.push(await artifact(candidate, "implementation"));
for (const candidate of Object.values(decks)) artifacts.push(await artifact(candidate, "pptx"));
for (const candidate of Object.values(auditPaths)) artifacts.push(await artifact(candidate, "audit"));
for (const control of destructiveControls) {
  artifacts.push(await artifact(path.resolve(root, control.pptx), "destructive-control"));
  artifacts.push(await artifact(path.resolve(root, control.auditPath), "audit"));
}
artifacts.push(await artifact(powerPointReportPath, "powerpoint-report"));
artifacts.push(await artifact(path.join(output, "slidewright-missing-font-audit.json"), "audit"));
artifacts.push(await artifact(fullSizeReviewPath, "review"));
for (const state of renderProof.states) for (const slide of state.slides) artifacts.push(await artifact(path.resolve(root, slide.path), "render"));
const implementationRecords = artifacts.filter((item) => item.kind === "implementation").map(({ path: itemPath, sha256: itemSha }) => ({ path: itemPath, sha256: itemSha }));

const scorecard = {
  schemaVersion: 1,
  benchmarkId: "C11-font-integrity-v1",
  generatedAt: new Date().toISOString(),
  valid: true,
  family: "Slidewright Fixture Sans",
  powerPoint,
  audits,
  fontAuditControl,
  destructiveControls,
  renderProof,
  fullSizeReview,
  artifacts,
  implementationClosureSha256: sha256(Buffer.from(JSON.stringify(implementationRecords))),
};
const scorecardPath = path.join(output, "scorecard.json");
await fs.writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
await verifyFontIntegrityEvidence(scorecard);
await fs.writeFile(path.join(output, "current.json"), `${JSON.stringify({ schemaVersion: 1, scorecard: relative(scorecardPath), scorecardSha256: await sha256File(scorecardPath) }, null, 2)}\n`, "utf8");
process.stdout.write(`C11 font-integrity benchmark passed: two PowerPoint cycles, four embedded styles, six pixel-identical renders, and four visible failure controls.\n`);
