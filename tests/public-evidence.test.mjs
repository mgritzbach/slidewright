import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPublicScorecard, contentHash, nodeTestPassed, parseNodeTestSummary, rejectMachineSpecificContent, sha256 } from "../scripts/public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const portableContract = JSON.parse(fs.readFileSync(path.join(root, "evidence", "portable-contract.json"), "utf8"));
const evidenceCommandIds = ["tests", "demo-compile", "demo-lint", "public-evidence"];
const commandText = (id) => id === "tests" ? "npm test"
  : id === "demo-compile" ? "npm run demo:compile"
    : id === "demo-lint" ? "npm run demo:lint"
      : "node scripts/verify-public-evidence.mjs --out outputs/public-evidence/test/verified-evidence.json";
const passingTestLog = (passed, skipped, total = passed + skipped) => `${portableContract.requiredTestNames.map((name, index) => `ok ${index + 1} - ${name}`).join("\n")}\n# tests ${total}\n# pass ${passed}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n`;
const commandLog = (id, testLog) => id === "tests" ? testLog : `${id} passed\n`;
const evidenceCommands = (testLog) => evidenceCommandIds.map((id) => {
  const log = commandLog(id, testLog);
  return { id, command: commandText(id), exitCode: 0, signal: null, error: null, logFile: `${id}.log`, logBytes: Buffer.byteLength(log), logSha256: sha256(log) };
});
const testSummary = (passed, skipped, total = passed + skipped) => ({ total, passed, failed: 0, cancelled: 0, skipped, minimum: portableContract.minimumTestCount, required: portableContract.requiredTestNames, missingRequiredTests: [] });
const testManifest = "a".repeat(64);
const portableResult = (total) => ({ testsTotal: total, testsFailed: 0, testsCancelled: 0, minimumTests: portableContract.minimumTestCount, requiredTestsVerified: portableContract.requiredTestNames.length, requiredTestsExpected: portableContract.requiredTestNames.length, demoSlides: portableContract.demoSlides, errors: 0, warnings: 0, manifestHash: testManifest, scorecardsVerified: 3 });
async function writeCommandLogs(directory, commands, testLog) {
  for (const command of commands) await fsp.writeFile(path.join(directory, command.logFile), commandLog(command.id, testLog));
}
function runSyntheticAggregate(input, output) {
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  delete env.GITHUB_REPOSITORY;
  delete env.GITHUB_RUN_ID;
  return spawnSync(process.execPath, ["scripts/aggregate-public-evidence.mjs", "--input", input, "--out", output], { cwd: root, encoding: "utf8", env });
}

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
  assert.equal(nodeTestPassed("ok 1 - required control\n", "required control"), true);
  assert.equal(nodeTestPassed("ok 1 - required control # SKIP host-only\n", "required control"), false);
  assert.equal(nodeTestPassed("✔ required control (1.2ms)\n", "required control"), true);
});

test("cross-platform aggregation rejects divergent portable results", async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "slidewright-evidence-negative-"));
  const input = path.join(temporary, "input");
  const output = path.join(temporary, "output");
  await fsp.mkdir(path.join(input, "linux"), { recursive: true });
  await fsp.mkdir(path.join(input, "windows"), { recursive: true });
  const log = passingTestLog(80, 0);
  const commands = evidenceCommands(log);
  const base = {
    schemaVersion: "slidewright-fresh-host-scorecard/v1",
    valid: true,
    environment: { platform: "Linux", gitSha: "abc", repository: "owner/repo" },
    publicEvidence: { manifestHash: testManifest, scorecards: 3 },
    tests: testSummary(80, 0),
    commands,
    portableResult: portableResult(80),
  };
  base.portableResultHash = contentHash(base.portableResult, "unused");
  base.scorecardHash = contentHash(base, "scorecardHash");
  const windows = structuredClone(base);
  windows.environment.platform = "Windows";
  windows.portableResult.testsTotal = 79;
  windows.portableResultHash = contentHash(windows.portableResult, "unused");
  windows.scorecardHash = contentHash(windows, "scorecardHash");
  await fsp.writeFile(path.join(input, "linux", "fresh-host-scorecard.json"), JSON.stringify(base));
  await fsp.writeFile(path.join(input, "windows", "fresh-host-scorecard.json"), JSON.stringify(windows));
  for (const directory of ["linux", "windows"]) await writeCommandLogs(path.join(input, directory), commands, log);
  const result = runSyntheticAggregate(input, output);
  assert.equal(result.status, 1);
  const aggregate = JSON.parse(await fsp.readFile(path.join(output, "aggregate-scorecard.json"), "utf8"));
  assert.equal(aggregate.valid, false);
  assert.ok(aggregate.failures.includes("portable result mismatch"));
});

test("cross-platform aggregation accepts platform-specific skips when totals and failures match", async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "slidewright-evidence-positive-"));
  const input = path.join(temporary, "input");
  const output = path.join(temporary, "output");
  const make = (platform, passed, skipped) => {
    const log = passingTestLog(passed, skipped, 80);
    const value = {
      schemaVersion: "slidewright-fresh-host-scorecard/v1",
      valid: true,
      environment: { platform, gitSha: "abc", repository: "owner/repo" },
      publicEvidence: { manifestHash: testManifest, scorecards: 3 },
      tests: testSummary(passed, skipped, 80),
      commands: evidenceCommands(log),
      portableResult: portableResult(80),
    };
    value.portableResultHash = contentHash(value.portableResult, "unused");
    value.scorecardHash = contentHash(value, "scorecardHash");
    return value;
  };
  for (const [directory, value] of [["linux", make("Linux", 72, 8)], ["windows", make("Windows", 79, 1)]]) {
    await fsp.mkdir(path.join(input, directory), { recursive: true });
    await fsp.writeFile(path.join(input, directory, "fresh-host-scorecard.json"), JSON.stringify(value));
    await writeCommandLogs(path.join(input, directory), value.commands, passingTestLog(value.tests.passed, value.tests.skipped, value.tests.total));
  }
  const result = runSyntheticAggregate(input, output);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fsp.readFile(path.join(output, "aggregate-scorecard.json"), "utf8")).valid, true);
  await fsp.writeFile(path.join(input, "windows", "tests.log"), "tampered\n");
  const tampered = runSyntheticAggregate(input, `${output}-tampered`);
  assert.equal(tampered.status, 1);
  assert.ok(JSON.parse(await fsp.readFile(path.join(`${output}-tampered`, "aggregate-scorecard.json"), "utf8")).failures.includes("Windows: command log mismatch (tests)"));
  await fsp.writeFile(path.join(input, "windows", "tests.log"), passingTestLog(79, 1, 80));
  const windowsPath = path.join(input, "windows", "fresh-host-scorecard.json");
  const originalWindows = JSON.parse(await fsp.readFile(windowsPath, "utf8"));
  const runRawMutation = async (log, suffix, expectedFailure) => {
    const mutated = structuredClone(originalWindows);
    mutated.commands[0].logBytes = Buffer.byteLength(log);
    mutated.commands[0].logSha256 = sha256(log);
    mutated.scorecardHash = contentHash(mutated, "scorecardHash");
    await fsp.writeFile(windowsPath, JSON.stringify(mutated));
    await fsp.writeFile(path.join(input, "windows", "tests.log"), log);
    const outcome = runSyntheticAggregate(input, `${output}-${suffix}`);
    assert.equal(outcome.status, 1);
    assert.ok(JSON.parse(await fsp.readFile(path.join(`${output}-${suffix}`, "aggregate-scorecard.json"), "utf8")).failures.includes(expectedFailure));
  };
  await runRawMutation(passingTestLog(78, 1, 80).replace("# fail 0", "# fail 1"), "raw-failure", "Windows: raw test summary mismatch");
  const firstRequired = portableContract.requiredTestNames[0];
  await runRawMutation(passingTestLog(79, 1, 80).replace(`ok 1 - ${firstRequired}`, `ok 1 - ${firstRequired} # SKIP`), "required-skip", "Windows: required test did not pass in raw log");
  await fsp.writeFile(windowsPath, JSON.stringify(originalWindows));
  await fsp.writeFile(path.join(input, "windows", "tests.log"), passingTestLog(79, 1, 80));
  for (const [suffix, mutate] of [
    ["missing-errors", (value) => { delete value.portableResult.errors; }],
    ["null-warnings", (value) => { value.portableResult.warnings = null; }],
    ["string-errors", (value) => { value.portableResult.errors = "0"; }],
    ["negative-warnings", (value) => { value.portableResult.warnings = -1; }],
  ]) {
    const malformed = structuredClone(originalWindows);
    mutate(malformed);
    malformed.portableResultHash = contentHash(malformed.portableResult, "unused");
    malformed.scorecardHash = contentHash(malformed, "scorecardHash");
    await fsp.writeFile(windowsPath, JSON.stringify(malformed));
    const outcome = runSyntheticAggregate(input, `${output}-${suffix}`);
    assert.equal(outcome.status, 1);
    assert.ok(JSON.parse(await fsp.readFile(path.join(`${output}-${suffix}`, "aggregate-scorecard.json"), "utf8")).failures.includes("Windows: portable test summary mismatch"));
  }
  await fsp.writeFile(windowsPath, JSON.stringify(originalWindows));
  if (process.platform !== "win32") {
    const outsideLog = path.join(temporary, "outside-tests.log");
    await fsp.writeFile(outsideLog, passingTestLog(79, 1, 80));
    await fsp.rm(path.join(input, "windows", "tests.log"));
    await fsp.symlink(outsideLog, path.join(input, "windows", "tests.log"));
    const linked = runSyntheticAggregate(input, `${output}-symlink`);
    assert.equal(linked.status, 1);
    assert.ok(JSON.parse(await fsp.readFile(path.join(`${output}-symlink`, "aggregate-scorecard.json"), "utf8")).failures.includes("Windows: command log path invalid"));
    await fsp.rm(path.join(input, "windows", "tests.log"));
    await fsp.writeFile(path.join(input, "windows", "tests.log"), passingTestLog(79, 1, 80));
  }
  const windows = structuredClone(originalWindows);
  windows.commands[0].logFile = "../tests.log";
  windows.scorecardHash = contentHash(windows, "scorecardHash");
  await fsp.writeFile(windowsPath, JSON.stringify(windows));
  const unsafe = runSyntheticAggregate(input, `${output}-unsafe`);
  assert.equal(unsafe.status, 1);
  assert.ok(JSON.parse(await fsp.readFile(path.join(`${output}-unsafe`, "aggregate-scorecard.json"), "utf8")).failures.includes("Windows: command log path invalid"));
});
