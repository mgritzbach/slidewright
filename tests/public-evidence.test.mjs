import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPublicScorecard, contentHash, parseNodeTestSummary, rejectMachineSpecificContent } from "../scripts/public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("committed public evidence verifies as content-addressed release data", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-public-evidence.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
});

test("published scorecard hashes reject any content mutation", () => {
  const published = JSON.parse(fs.readFileSync(path.join(root, "evidence", "scorecards", "v1", "c14-geometric-readability.json"), "utf8"));
  assert.equal(published.publishedHash, contentHash(published, "publishedHash"));
  published.scorecard.positiveProofFixtures += 1;
  assert.notEqual(published.publishedHash, contentHash(published, "publishedHash"));
});

test("public evidence rejects machine-specific paths", () => {
  assert.throws(() => rejectMachineSpecificContent("mutant", { path: "C:\\Users\\someone\\deck.pptx" }), /machine-specific/);
});

test("public suite gates reject removed destructive controls", () => {
  const published = JSON.parse(fs.readFileSync(path.join(root, "evidence", "scorecards", "v1", "g22-g23-design-profile.json"), "utf8"));
  published.scorecard.negativeControls.pop();
  assert.throws(() => assertPublicScorecard(published.suiteId, published.scorecard), /eight destructive controls/);
});

test("fresh-host evidence parses Node 22 TAP and Node 24 spec summaries without hiding failures", () => {
  const node22 = "# tests 190\n# pass 188\n# fail 1\n# cancelled 0\n# skipped 1\n";
  const node24 = "ℹ tests 190\nℹ pass 190\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n";
  assert.deepEqual(parseNodeTestSummary(node22), { total: 190, passed: 188, failed: 1, cancelled: 0, skipped: 1 });
  assert.deepEqual(parseNodeTestSummary(node24), { total: 190, passed: 190, failed: 0, cancelled: 0, skipped: 0 });
  assert.deepEqual(parseNodeTestSummary("ok 1 - a test\n"), { total: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0 });
});

test("cross-platform aggregation rejects divergent portable results", async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "slidewright-evidence-negative-"));
  const input = path.join(temporary, "input");
  const output = path.join(temporary, "output");
  await fsp.mkdir(path.join(input, "linux"), { recursive: true });
  await fsp.mkdir(path.join(input, "windows"), { recursive: true });
  const base = {
    schemaVersion: "slidewright-fresh-host-scorecard/v1",
    valid: true,
    environment: { platform: "Linux", gitSha: "abc", repository: "owner/repo" },
    publicEvidence: { manifestHash: "manifest" },
    portableResult: { testsPassed: 80, errors: 0, warnings: 0 },
  };
  base.portableResultHash = contentHash(base.portableResult, "unused");
  base.scorecardHash = contentHash(base, "scorecardHash");
  const windows = structuredClone(base);
  windows.environment.platform = "Windows";
  windows.portableResult.testsPassed = 79;
  windows.portableResultHash = contentHash(windows.portableResult, "unused");
  windows.scorecardHash = contentHash(windows, "scorecardHash");
  await fsp.writeFile(path.join(input, "linux", "fresh-host-scorecard.json"), JSON.stringify(base));
  await fsp.writeFile(path.join(input, "windows", "fresh-host-scorecard.json"), JSON.stringify(windows));
  const result = spawnSync(process.execPath, ["scripts/aggregate-public-evidence.mjs", "--input", input, "--out", output], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  const aggregate = JSON.parse(await fsp.readFile(path.join(output, "aggregate-scorecard.json"), "utf8"));
  assert.equal(aggregate.valid, false);
  assert.ok(aggregate.failures.includes("portable result mismatch"));
});
