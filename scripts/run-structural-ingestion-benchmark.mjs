#!/usr/bin/env node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalHash, sha256File, STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS, verifyStructuralIngestionEvidence } from "./verify-structural-ingestion-evidence.mjs";

const root = process.cwd();
const contractPath = path.join(root, "fixtures", "structural-ingestion", "v1", "fixture-contract.json");
const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
const outputRoot = path.join(root, "outputs", "structural-ingestion");
const runsRoot = path.join(outputRoot, "runs");
const staging = path.join(runsRoot, `.staging-${process.pid}-${Date.now()}`);
const core = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "structural_ingestion", "import_structural.py");
const audit = path.join(root, "scripts", "structural-ingestion-audit.py");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function logical(file) { return path.relative(root, file).split(path.sep).join("/"); }
function confined(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function readJson(file) { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "")); }
async function writeJson(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8"); }

const receipts = [];
let receiptIndex = 0;
function normalizeArg(value) {
  const absolute = path.resolve(value);
  if (confined(staging, absolute)) return `$RUN/${path.relative(staging, absolute).split(path.sep).join("/")}`;
  if (confined(root, absolute)) return `$ROOT/${path.relative(root, absolute).split(path.sep).join("/")}`;
  return value === python ? "$PYTHON" : value;
}
function run(id, args, expectedExitCode = 0) {
  const completed = spawnSync(python, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (completed.error) throw completed.error;
  const streams = [];
  const prefix = String(++receiptIndex).padStart(3, "0");
  for (const [name, value] of [["stdout", completed.stdout || ""], ["stderr", completed.stderr || ""]]) {
    const bytes = Buffer.from(value, "utf8");
    const relative = `command-receipts/${prefix}-${id}.${name}.txt`;
    const file = path.join(staging, ...relative.split("/"));
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, bytes);
    streams.push({ name, path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  receipts.push({ id, command: "$PYTHON", args: args.map(normalizeArg), expectedExitCode, exitCode: completed.status, streams });
  if (completed.status !== expectedExitCode) throw new Error(`${id} returned ${completed.status}; expected ${expectedExitCode}.\n${completed.stderr || completed.stdout}`);
  return completed;
}

async function inventoryTree(directory, excluded = new Set()) {
  const result = [];
  async function visit(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (excluded.has(relative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`C17 refuses symlink evidence: ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else {
        const stat = await fs.stat(absolute);
        result.push({ path: relative, bytes: stat.size, sha256: await sha256File(absolute) });
      }
    }
  }
  await visit(directory);
  return result;
}

function gitState() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout.trim();
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", windowsHide: true }).stdout.trim();
  return { commit, clean: status.length === 0 };
}

if (contract.schemaVersion !== "slidewright-structural-ingestion-contract/v1" || contract.fixtures.length < 4 || contract.controls.length < 8) {
  throw new Error("C17 fixture contract is incomplete.");
}
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
const gitBefore = gitState();
const fixtures = [];
const sourceById = new Map();
const coverage = new Set();
for (const fixture of contract.fixtures) {
  const directory = path.join(staging, "fixtures", fixture.id);
  await fs.mkdir(directory, { recursive: true });
  const workspaceSource = path.resolve(root, ...fixture.source.split("/"));
  const license = path.resolve(root, ...fixture.license.split("/"));
  if (!confined(root, workspaceSource) || !confined(root, license)) throw new Error(`C17 fixture ${fixture.id} escapes the repository.`);
  if (await sha256File(workspaceSource) !== fixture.sourceSha256 || await sha256File(license) !== fixture.licenseSha256) throw new Error(`C17 fixture ${fixture.id} or its license drifted.`);
  const source = path.join(directory, "source.pptx");
  if (fixture.derivation === "append-editable-native-shape-diagram") {
    run(`derive-${fixture.id}`, [core, "derive-diagram", workspaceSource, source]);
    if (await sha256File(source) !== fixture.derivedSha256) throw new Error(`C17 fixture ${fixture.id} derivative is not deterministic.`);
  } else await fs.copyFile(workspaceSource, source);
  await fs.copyFile(license, path.join(directory, "LICENSE.txt"));
  const imported = path.join(directory, "imported.pptx");
  const manifestPath = path.join(directory, "import-manifest.json");
  const auditPath = path.join(directory, "audit.json");
  run(`import-${fixture.id}`, [core, "import", source, imported, "--manifest", manifestPath]);
  run(`audit-${fixture.id}`, [audit, source, imported, "--json", auditPath]);
  const [manifest, auditReport] = await Promise.all([readJson(manifestPath), readJson(auditPath)]);
  if (!auditReport.valid || !auditReport.exactPartInventoryAndBytes) throw new Error(`C17 fixture ${fixture.id} failed independent structural audit.`);
  for (const [field, minimum] of Object.entries(fixture.minimums)) if ((auditReport.sourceSummary[field] ?? 0) < minimum) throw new Error(`C17 fixture ${fixture.id} misses ${field} minimum.`);
  if (auditReport.sourceSummary.slides > 0 && auditReport.sourceSummary.masters > 0 && auditReport.sourceSummary.layouts > 0) coverage.add("slideMasterHierarchy");
  if (auditReport.sourceSummary.textRuns > 0) coverage.add("textRuns");
  if (auditReport.sourceSummary.tables > 0) coverage.add("tables");
  if (auditReport.sourceSummary.diagrams > 0) coverage.add("nativeDiagrams");
  if (auditReport.sourceSummary.charts > 0) coverage.add("charts");
  if (auditReport.sourceSummary.notes > 0) coverage.add("notes");
  if (auditReport.surfaceHashes.readingOrder.equal) coverage.add("semanticReadingOrder");
  sourceById.set(fixture.id, source);
  fixtures.push({
    id: fixture.id, spdx: fixture.spdx, packageOnly: fixture.packageOnly === true,
    sourceSha256: await sha256File(source), importedSha256: await sha256File(imported),
    containerBytesDiffer: manifest.containerBytesDiffer, summary: auditReport.sourceSummary,
    semanticSurfaceHashes: auditReport.surfaceHashes,
  });
}
if (!contract.requiredCoverage.every((item) => coverage.has(item))) throw new Error(`C17 coverage is incomplete: ${JSON.stringify([...coverage])}`);

const controls = [];
const controlsDirectory = path.join(staging, "controls");
await fs.mkdir(controlsDirectory, { recursive: true });
for (const control of contract.controls) {
  const source = sourceById.get(control.fixture);
  if (!source) throw new Error(`C17 control ${control.id} has no source fixture.`);
  const mutant = path.join(controlsDirectory, `${control.id}.pptx`);
  const report = path.join(controlsDirectory, `${control.id}.json`);
  run(`mutate-${control.id}`, [core, "mutate", source, mutant, "--control", control.id]);
  run(`audit-control-${control.id}`, [audit, source, mutant, "--json", report], 1);
  const payload = await readJson(report);
  if (payload.valid || !payload.failures.some((item) => item.code === control.expectedFailure)) throw new Error(`C17 control ${control.id} did not trigger ${control.expectedFailure}.`);
  controls.push({ id: control.id, fixture: control.fixture, expectedFailure: control.expectedFailure, mutantSha256: await sha256File(mutant), failureCodes: payload.failures.map((item) => item.code).sort() });
}

await writeJson(path.join(staging, "command-log.json"), { schemaVersion: "slidewright-structural-ingestion-command-log/v1", receipts });
const implementation = await Promise.all(STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS.map(async (relative) => ({ path: relative, sha256: await sha256File(path.join(root, ...relative.split("/"))) })));
const gitAfter = gitState();
const releaseEvidence = gitBefore.clean && gitAfter.clean && gitBefore.commit === gitAfter.commit;
const artifacts = await inventoryTree(staging, new Set(["scorecard.json"]));
const scorecardBasis = {
  schemaVersion: "slidewright-structural-ingestion-scorecard/v1",
  valid: true,
  releaseEvidence,
  provenance: { gitBefore, gitAfter, sameCommit: gitBefore.commit === gitAfter.commit, logicalCommand: "node scripts/run-structural-ingestion-benchmark.mjs" },
  contract: logical(contractPath),
  contractSha256: await sha256File(contractPath),
  fixtureCount: fixtures.length,
  controlCount: controls.length,
  coverage: [...coverage].sort(),
  fixtures,
  controls,
  receipts,
  implementation,
  implementationSha256: canonicalHash(implementation),
  artifacts,
};
const scorecard = { ...scorecardBasis, scorecardHash: canonicalHash(scorecardBasis) };
await writeJson(path.join(staging, "scorecard.json"), scorecard);
await verifyStructuralIngestionEvidence({ root, runDirectory: staging, requireCurrentSource: true, requireRelease: false, python });
const finalRun = path.join(runsRoot, scorecard.scorecardHash);
await fs.rm(finalRun, { recursive: true, force: true });
await fs.rename(staging, finalRun);
await writeJson(path.join(outputRoot, "current.json"), { schemaVersion: "slidewright-structural-ingestion-current/v1", scorecardHash: scorecard.scorecardHash, run: `runs/${scorecard.scorecardHash}`, releaseEvidence });
await verifyStructuralIngestionEvidence({ root, runDirectory: finalRun, requireCurrentSource: true, requireRelease: false, python });
process.stdout.write(`C17 structural-ingestion benchmark passed ${fixtures.length}/${fixtures.length} fixtures and ${controls.length}/${controls.length} controls: ${scorecard.scorecardHash}${releaseEvidence ? " [release]" : " [development]"}\n`);
