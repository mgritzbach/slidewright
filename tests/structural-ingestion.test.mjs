import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sha256NormalizedText, sha256NormalizedTextFile, STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS } from "../scripts/verify-structural-ingestion-evidence.mjs";

const root = process.cwd();
const contractPath = path.join(root, "fixtures", "structural-ingestion", "v1", "fixture-contract.json");
const core = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "structural_ingestion", "import_structural.py");
const audit = path.join(root, "scripts", "structural-ingestion-audit.py");
const python = process.env.SLIDEWRIGHT_PYTHON || "python";

async function sha256(file) { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
function run(args, expected = 0) {
  const completed = spawnSync(python, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(completed.status, expected, completed.stderr || completed.stdout);
  return completed;
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

test("C17 contract pins licensed sources and every named semantic surface", async () => {
  const contract = await readJson(contractPath);
  assert.equal(contract.schemaVersion, "slidewright-structural-ingestion-contract/v1");
  assert.equal(contract.licenseHashMode, "utf8-lf");
  assert.deepEqual(contract.requiredCoverage, ["slideMasterHierarchy", "textRuns", "tables", "nativeDiagrams", "charts", "notes", "semanticReadingOrder"]);
  assert.equal(contract.fixtures.length, 4);
  assert.deepEqual(contract.fixtures.map((item) => item.spdx), ["MIT", "MIT", "CC0-1.0", "MIT"]);
  for (const fixture of contract.fixtures) {
    assert.equal(await sha256(path.join(root, ...fixture.source.split("/"))), fixture.sourceSha256);
    assert.equal(await sha256NormalizedTextFile(path.join(root, ...fixture.license.split("/"))), fixture.licenseSha256);
  }
  assert.deepEqual(contract.controls.map((item) => item.expectedFailure), [
    "SI_HIERARCHY", "SI_HIERARCHY", "SI_TEXT_RUNS", "SI_TABLES", "SI_CHARTS", "SI_NOTES", "SI_READING_ORDER", "SI_DIAGRAMS",
  ]);
  assert.deepEqual(STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS, [...STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS].sort());
});

test("C17 license receipts are invariant to Git LF and Windows CRLF checkouts", () => {
  const lf = "Permission is granted.\nCopyright retained.\n";
  const crlf = lf.replaceAll("\n", "\r\n");
  assert.equal(sha256NormalizedText(lf), sha256NormalizedText(crlf));
});

test("C17 lossless import independently retains all seven semantic surfaces and controls detect each one", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c17-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const contract = await readJson(contractPath);
  const sourceById = new Map();
  const covered = new Set();
  for (const fixture of contract.fixtures) {
    const fixtureDir = path.join(directory, fixture.id);
    await fs.mkdir(fixtureDir, { recursive: true });
    const workspaceSource = path.join(root, ...fixture.source.split("/"));
    const source = path.join(fixtureDir, "source.pptx");
    if (fixture.derivation) {
      run([core, "derive-diagram", workspaceSource, source]);
      assert.equal(await sha256(source), fixture.derivedSha256);
    } else await fs.copyFile(workspaceSource, source);
    const imported = path.join(fixtureDir, "imported.pptx");
    const manifestPath = path.join(fixtureDir, "manifest.json");
    const reportPath = path.join(fixtureDir, "audit.json");
    run([core, "import", source, imported, "--manifest", manifestPath]);
    run([audit, source, imported, "--json", reportPath]);
    const [manifest, report] = await Promise.all([readJson(manifestPath), readJson(reportPath)]);
    assert.equal(report.valid, true);
    assert.equal(report.exactPartInventoryAndBytes, true);
    assert.ok(Object.values(report.surfaceHashes).every((item) => item.equal));
    assert.equal(manifest.sourceSha256, await sha256(source));
    assert.equal(manifest.outputSha256, await sha256(imported));
    for (const [field, minimum] of Object.entries(fixture.minimums)) assert.ok(report.sourceSummary[field] >= minimum, `${fixture.id}:${field}`);
    if (report.sourceSummary.slides && report.sourceSummary.masters && report.sourceSummary.layouts) covered.add("slideMasterHierarchy");
    if (report.sourceSummary.textRuns) covered.add("textRuns");
    if (report.sourceSummary.tables) covered.add("tables");
    if (report.sourceSummary.diagrams) covered.add("nativeDiagrams");
    if (report.sourceSummary.charts) covered.add("charts");
    if (report.sourceSummary.notes) covered.add("notes");
    if (report.surfaceHashes.readingOrder.equal) covered.add("semanticReadingOrder");
    sourceById.set(fixture.id, source);
  }
  assert.deepEqual([...covered].sort(), [...contract.requiredCoverage].sort());

  for (const control of contract.controls) {
    const mutant = path.join(directory, `${control.id}.pptx`);
    const reportPath = path.join(directory, `${control.id}.json`);
    run([core, "mutate", sourceById.get(control.fixture), mutant, "--control", control.id]);
    run([audit, sourceById.get(control.fixture), mutant, "--json", reportPath], 1);
    const report = await readJson(reportPath);
    assert.equal(report.valid, false);
    assert.ok(report.failures.some((item) => item.code === control.expectedFailure), `${control.id} did not trigger ${control.expectedFailure}`);
    assert.notEqual(report.sourceSha256, report.candidateSha256);
  }
});

test("C17 independent auditor does not accept a producer manifest as proof", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c17-claims-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(root, "fixtures", "template", "c10-v1", "automizer-charts", "template.pptx");
  const imported = path.join(directory, "imported.pptx");
  const manifest = path.join(directory, "manifest.json");
  run([core, "import", source, imported, "--manifest", manifest]);
  const falseClaim = await readJson(manifest);
  falseClaim.semanticSha256 = "0".repeat(64);
  await fs.writeFile(manifest, `${JSON.stringify(falseClaim, null, 2)}\n`, "utf8");
  const mutant = path.join(directory, "mutant.pptx");
  run([core, "mutate", imported, mutant, "--control", "chart-cache"]);
  const report = path.join(directory, "audit.json");
  run([audit, source, mutant, "--json", report], 1);
  assert.ok((await readJson(report)).failures.some((item) => item.code === "SI_CHARTS"));
});
