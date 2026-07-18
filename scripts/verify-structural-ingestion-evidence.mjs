#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS = [
  "fixtures/structural-ingestion/v1/fixture-contract.json",
  "scripts/run-structural-ingestion-benchmark.mjs",
  "scripts/verify-structural-ingestion-evidence.mjs",
  "plugins/slidewright/skills/slidewright/scripts/structural_ingestion/import_structural.py",
  "plugins/slidewright/skills/slidewright/references/structural-ingestion.md",
  "scripts/structural-ingestion-audit.py",
  "tests/structural-ingestion.test.mjs",
].sort();

export function canonicalHash(value) {
  const normalize = (item) => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])])) : item;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export async function sha256File(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`C17 evidence invalid: ${message}`);
}

function confined(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function inventoryTree(directory, excluded = new Set()) {
  const result = [];
  async function visit(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      if (excluded.has(relative)) continue;
      requireEvidence(!entry.isSymbolicLink(), `artifact is a symlink: ${relative}`);
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

function runAudit(root, python, source, candidate, report) {
  const completed = spawnSync(python, [path.join(root, "scripts", "structural-ingestion-audit.py"), source, candidate, "--json", report], {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  return completed;
}

export async function verifyStructuralIngestionEvidence({ root, runDirectory, requireCurrentSource = true, requireRelease = false, python = process.env.SLIDEWRIGHT_PYTHON || "python" }) {
  const realRun = await fs.realpath(runDirectory);
  const contractPath = path.join(root, "fixtures", "structural-ingestion", "v1", "fixture-contract.json");
  const [contract, scorecard] = await Promise.all([readJson(contractPath), readJson(path.join(realRun, "scorecard.json"))]);
  requireEvidence(scorecard.schemaVersion === "slidewright-structural-ingestion-scorecard/v1" && scorecard.valid === true, "scorecard is not valid v1 evidence");
  if (requireRelease) requireEvidence(scorecard.releaseEvidence === true, "scorecard is development evidence, not clean-commit release evidence");
  const scorecardBasis = { ...scorecard }; delete scorecardBasis.scorecardHash;
  requireEvidence(scorecard.scorecardHash === canonicalHash(scorecardBasis), "scorecard hash drifted");
  requireEvidence(scorecard.contractSha256 === await sha256File(contractPath), "fixture contract drifted");
  requireEvidence(scorecard.fixtureCount === contract.fixtures.length && scorecard.controlCount === contract.controls.length, "fixture or control count is incomplete");
  requireEvidence(scorecard.fixtures.filter((item) => item.containerBytesDiffer === true).length >= 3, "fewer than three fixtures prove a fresh imported container distinct from the source bytes");
  requireEvidence(scorecard.coverage.every((name) => contract.requiredCoverage.includes(name))
    && contract.requiredCoverage.every((name) => scorecard.coverage.includes(name)), "required semantic coverage is incomplete");

  const fixtureById = new Map(contract.fixtures.map((item) => [item.id, item]));
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c17-verify-"));
  try {
    for (const fixture of scorecard.fixtures) {
      const expected = fixtureById.get(fixture.id);
      requireEvidence(expected, `undeclared fixture ${fixture.id}`);
      const directory = path.join(realRun, "fixtures", fixture.id);
      const source = path.join(directory, "source.pptx");
      const imported = path.join(directory, "imported.pptx");
      const manifest = await readJson(path.join(directory, "import-manifest.json"));
      const audit = await readJson(path.join(directory, "audit.json"));
      const expectedSourceHash = expected.derivedSha256 ?? expected.sourceSha256;
      requireEvidence(await sha256File(source) === expectedSourceHash && fixture.sourceSha256 === expectedSourceHash, `${fixture.id} source hash drifted`);
      requireEvidence(await sha256File(imported) === fixture.importedSha256, `${fixture.id} imported hash drifted`);
      requireEvidence(manifest.sourceSha256 === fixture.sourceSha256 && manifest.outputSha256 === fixture.importedSha256, `${fixture.id} producer manifest is not artifact-bound`);
      requireEvidence(audit.valid === true && audit.exactPartInventoryAndBytes === true && audit.failures.length === 0, `${fixture.id} committed independent audit is not exact`);
      for (const [surface, hashes] of Object.entries(audit.surfaceHashes)) requireEvidence(hashes.equal === true && hashes.source === hashes.candidate, `${fixture.id} ${surface} drifted`);
      for (const [field, minimum] of Object.entries(expected.minimums)) requireEvidence(audit.sourceSummary[field] >= minimum, `${fixture.id} misses ${field} minimum`);
      const freshReport = path.join(scratch, `${fixture.id}.json`);
      const fresh = runAudit(root, python, source, imported, freshReport);
      requireEvidence(fresh.status === 0, `${fixture.id} failed fresh independent audit: ${fresh.stderr || fresh.stdout}`);
      const freshAudit = await readJson(freshReport);
      requireEvidence(freshAudit.valid === true && canonicalHash(freshAudit.surfaceHashes) === canonicalHash(audit.surfaceHashes), `${fixture.id} fresh audit disagrees with committed evidence`);
    }

    const controlsById = new Map(contract.controls.map((item) => [item.id, item]));
    for (const control of scorecard.controls) {
      const expected = controlsById.get(control.id);
      requireEvidence(expected && expected.fixture === control.fixture && expected.expectedFailure === control.expectedFailure, `control ${control.id} contract drifted`);
      const fixtureDir = path.join(realRun, "fixtures", control.fixture);
      const mutant = path.join(realRun, "controls", `${control.id}.pptx`);
      const committed = await readJson(path.join(realRun, "controls", `${control.id}.json`));
      requireEvidence(await sha256File(mutant) === control.mutantSha256 && committed.valid === false, `control ${control.id} artifact or audit drifted`);
      requireEvidence(committed.failures.some((item) => item.code === control.expectedFailure), `control ${control.id} lacks intended failure ${control.expectedFailure}`);
      const freshReport = path.join(scratch, `control-${control.id}.json`);
      const fresh = runAudit(root, python, path.join(fixtureDir, "source.pptx"), mutant, freshReport);
      requireEvidence(fresh.status === 1, `control ${control.id} unexpectedly passed fresh independent audit`);
      const freshAudit = await readJson(freshReport);
      requireEvidence(freshAudit.failures.some((item) => item.code === control.expectedFailure), `control ${control.id} fresh audit missed ${control.expectedFailure}`);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }

  requireEvidence(Array.isArray(scorecard.receipts) && scorecard.receipts.length === contract.fixtures.length * 2 + 1 + contract.controls.length * 2, "command receipt count is not exact");
  for (const receipt of scorecard.receipts) {
    requireEvidence(receipt.exitCode === receipt.expectedExitCode && Array.isArray(receipt.streams) && receipt.streams.length === 2, `command receipt ${receipt.id} is invalid`);
    for (const stream of receipt.streams) {
      const file = path.join(realRun, ...stream.path.split("/"));
      requireEvidence(confined(realRun, file) && await sha256File(file) === stream.sha256 && (await fs.stat(file)).size === stream.bytes, `receipt stream drifted: ${stream.path}`);
    }
  }
  const actualInventory = await inventoryTree(realRun, new Set(["scorecard.json"]));
  requireEvidence(JSON.stringify(actualInventory) === JSON.stringify(scorecard.artifacts), "artifact inventory is not exhaustive or exact");
  if (requireCurrentSource) {
    requireEvidence(JSON.stringify(scorecard.implementation.map((item) => item.path)) === JSON.stringify(STRUCTURAL_INGESTION_IMPLEMENTATION_PATHS), "implementation closure path set drifted");
    for (const item of scorecard.implementation) requireEvidence(await sha256File(path.join(root, ...item.path.split("/"))) === item.sha256, `implementation drifted: ${item.path}`);
    requireEvidence(canonicalHash(scorecard.implementation) === scorecard.implementationSha256, "implementation closure hash drifted");
  }
  return { valid: true, scorecardHash: scorecard.scorecardHash, fixtures: scorecard.fixtureCount, controls: scorecard.controlCount, releaseEvidence: scorecard.releaseEvidence };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = process.cwd();
  const output = path.join(root, "outputs", "structural-ingestion");
  const pointer = await readJson(path.join(output, "current.json"));
  const runDirectory = path.resolve(output, ...pointer.run.split("/"));
  if (runDirectory !== path.resolve(output, "runs", pointer.scorecardHash)) throw new Error("C17 current pointer escaped the immutable run root.");
  const result = await verifyStructuralIngestionEvidence({ root, runDirectory, requireRelease: process.argv.includes("--release") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
