import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash, nodeTestPassed, parseNodeTestSummary, sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputIndex = process.argv.indexOf("--input");
const outputIndex = process.argv.indexOf("--out");
const input = path.resolve(inputIndex >= 0 ? process.argv[inputIndex + 1] : path.join(root, "outputs", "ci-evidence"));
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(root, "outputs", "public-evidence-aggregate"));
const contract = JSON.parse(await fs.readFile(path.join(root, "evidence", "portable-contract.json"), "utf8"));
if (contract.schemaVersion !== "slidewright-portable-evidence-contract/v1") throw new Error("Portable evidence contract schema is unsupported.");

async function findScorecards(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findScorecards(target));
    else if (entry.name === "fresh-host-scorecard.json") found.push(target);
  }
  return found;
}

const files = await findScorecards(input);
if (files.length !== 2) throw new Error(`Expected exactly two fresh-host scorecards, found ${files.length}.`);
const scorecards = await Promise.all(files.map(async (file) => ({ file, value: JSON.parse(await fs.readFile(file, "utf8")) })));
const linux = scorecards.find(({ value }) => value.environment?.platform?.toLowerCase() === "linux");
const windows = scorecards.find(({ value }) => value.environment?.platform?.toLowerCase() === "windows");
if (!linux || !windows) throw new Error("Both Linux and Windows scorecards are required.");
const expectedSha = process.env.GITHUB_SHA || linux.value.environment.gitSha;
const failures = [];
for (const item of [linux, windows]) {
  const label = item.value.environment.platform;
  if (item.value.valid !== true) failures.push(`${item.value.environment.platform}: scorecard invalid`);
  if (item.value.environment.gitSha !== expectedSha) failures.push(`${item.value.environment.platform}: commit mismatch`);
  if (item.value.scorecardHash !== contentHash(item.value, "scorecardHash")) failures.push(`${item.value.environment.platform}: scorecard hash mismatch`);
  if (item.value.portableResultHash !== contentHash(item.value.portableResult, "unused")) failures.push(`${item.value.environment.platform}: portable result hash mismatch`);
  const tests = item.value.tests;
  if (!tests || tests.total !== tests.passed + tests.failed + tests.cancelled + tests.skipped || tests.failed !== 0 || tests.cancelled !== 0 || tests.total < contract.minimumTestCount || tests.minimum !== contract.minimumTestCount || JSON.stringify(tests.required) !== JSON.stringify(contract.requiredTestNames) || tests.missingRequiredTests?.length !== 0) {
    failures.push(`${label}: test summary invalid`);
  }
  const portable = item.value.portableResult ?? {};
  const expectedPortableKeys = ["demoSlides", "errors", "manifestHash", "minimumTests", "requiredTestsExpected", "requiredTestsVerified", "scorecardsVerified", "testsCancelled", "testsFailed", "testsTotal", "warnings"];
  const validCount = (value) => Number.isInteger(value) && value >= 0;
  if (JSON.stringify(Object.keys(portable).sort()) !== JSON.stringify(expectedPortableKeys)
    || !validCount(portable.testsTotal) || portable.testsTotal !== tests?.total
    || !validCount(portable.testsFailed) || portable.testsFailed !== tests?.failed
    || !validCount(portable.testsCancelled) || portable.testsCancelled !== tests?.cancelled
    || portable.minimumTests !== contract.minimumTestCount
    || portable.requiredTestsVerified !== contract.requiredTestNames.length
    || portable.requiredTestsExpected !== contract.requiredTestNames.length
    || portable.demoSlides !== contract.demoSlides
    || !validCount(portable.errors) || portable.errors > contract.maximumErrors
    || !validCount(portable.warnings) || portable.warnings > contract.maximumWarnings
    || !/^[a-f0-9]{64}$/u.test(portable.manifestHash) || portable.manifestHash !== item.value.publicEvidence?.manifestHash
    || !validCount(portable.scorecardsVerified) || portable.scorecardsVerified !== item.value.publicEvidence?.scorecards) {
    failures.push(`${label}: portable test summary mismatch`);
  }
  const commands = item.value.commands;
  const expectedCommandIds = ["tests", "demo-compile", "demo-lint", "public-evidence"];
  const commandTextValid = (command) => command.id === "tests" ? command.command === "npm test"
    : command.id === "demo-compile" ? command.command === "npm run demo:compile"
      : command.id === "demo-lint" ? command.command === "npm run demo:lint"
        : command.id === "public-evidence" && /^node scripts\/verify-public-evidence\.mjs --out outputs\/public-evidence\/[a-z0-9-]+\/verified-evidence\.json$/u.test(command.command);
  if (!Array.isArray(commands) || JSON.stringify(commands.map((command) => command.id)) !== JSON.stringify(expectedCommandIds) || commands.some((command) => command.exitCode !== 0 || command.signal !== null || command.error !== null || !commandTextValid(command))) {
    failures.push(`${label}: command summary invalid`);
  }
  if (Array.isArray(commands)) {
    const names = new Set();
    const logs = new Map();
    const scorecardDirectory = path.dirname(item.file);
    const realScorecardDirectory = await fs.realpath(scorecardDirectory);
    const canonical = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    for (const command of commands) {
      if (command.logFile !== `${command.id}.log` || names.has(command.logFile)) {
        failures.push(`${label}: command log path invalid`);
        continue;
      }
      names.add(command.logFile);
      try {
        const candidate = path.join(scorecardDirectory, command.logFile);
        const stat = await fs.lstat(candidate);
        const realCandidate = await fs.realpath(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || canonical(path.dirname(realCandidate)) !== canonical(realScorecardDirectory)) {
          failures.push(`${label}: command log path invalid`);
          continue;
        }
        const bytes = await fs.readFile(candidate);
        logs.set(command.id, bytes);
        if (bytes.length !== command.logBytes || sha256(bytes) !== command.logSha256) failures.push(`${label}: command log mismatch (${command.id})`);
      } catch {
        failures.push(`${label}: command log missing (${command.id})`);
      }
    }
    const testLog = logs.get("tests")?.toString("utf8");
    if (testLog) {
      const derived = parseNodeTestSummary(testLog);
      if (["total", "passed", "failed", "cancelled", "skipped"].some((key) => derived[key] !== tests?.[key])) failures.push(`${label}: raw test summary mismatch`);
      if (!contract.requiredTestNames.every((name) => nodeTestPassed(testLog, name))) failures.push(`${label}: required test did not pass in raw log`);
    } else {
      failures.push(`${label}: raw test log unavailable`);
    }
  }
}
if (linux.value.publicEvidence.manifestHash !== windows.value.publicEvidence.manifestHash) failures.push("evidence manifest mismatch");
if (linux.value.portableResultHash !== windows.value.portableResultHash) failures.push("portable result mismatch");

const aggregate = {
  schemaVersion: "slidewright-cross-platform-replication/v1",
  valid: failures.length === 0,
  repository: process.env.GITHUB_REPOSITORY || linux.value.environment.repository,
  runId: process.env.GITHUB_RUN_ID || linux.value.environment.githubRunId,
  runUrl: process.env.GITHUB_RUN_ID && (process.env.GITHUB_REPOSITORY || linux.value.environment.repository)
    ? `https://github.com/${process.env.GITHUB_REPOSITORY || linux.value.environment.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : linux.value.environment.runUrl,
  gitSha: expectedSha,
  manifestHash: linux.value.publicEvidence.manifestHash,
  portableResultHash: linux.value.portableResultHash,
  platforms: [linux.value, windows.value].map((value) => ({
    platform: value.environment.platform,
    osPlatform: value.environment.osPlatform,
    architecture: value.environment.architecture,
    node: value.environment.node,
    python: value.environment.python,
    scorecardHash: value.scorecardHash,
    tests: value.tests,
    portableResult: value.portableResult,
  })),
  failures,
  scope: {
    reproducedOnBothHosts: "Portable compiler, linter, unit/destructive-control tests, and committed public-evidence integrity.",
    capableHostSnapshots: "PowerPoint/Codex-runtime scorecards are content-addressed snapshots with exact regeneration commands; they are not re-executed on GitHub runners.",
  },
};
aggregate.aggregateHash = contentHash(aggregate, "aggregateHash");
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "aggregate-scorecard.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
const report = `# Slidewright cross-platform replication report\n\n- Valid: **${aggregate.valid}**\n- Repository: ${aggregate.repository}\n- Commit: \`${aggregate.gitSha}\`\n- Run: ${aggregate.runUrl}\n- Evidence manifest: \`${aggregate.manifestHash}\`\n- Portable result: \`${aggregate.portableResultHash}\`\n- Aggregate: \`${aggregate.aggregateHash}\`\n\n## Platforms\n\n${aggregate.platforms.map((item) => `- ${item.platform}: ${item.tests.passed} passed, ${item.tests.skipped} skipped (${item.tests.total} total), ${item.portableResult.requiredTestsVerified}/${item.portableResult.requiredTestsExpected} required destructive-control tests, ${item.portableResult.demoSlides} demo slides, ${item.portableResult.errors} errors, ${item.portableResult.warnings} warnings`).join("\n")}\n\n## Scope\n\n- ${aggregate.scope.reproducedOnBothHosts}\n- ${aggregate.scope.capableHostSnapshots}\n`;
await fs.writeFile(path.join(output, "FRESH_MACHINE_REPLICATION.md"), report, "utf8");
process.stdout.write(report);
if (!aggregate.valid) process.exit(1);
