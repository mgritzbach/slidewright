import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputIndex = process.argv.indexOf("--input");
const outputIndex = process.argv.indexOf("--out");
const input = path.resolve(inputIndex >= 0 ? process.argv[inputIndex + 1] : path.join(root, "outputs", "ci-evidence"));
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(root, "outputs", "public-evidence-aggregate"));

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
  if (item.value.valid !== true) failures.push(`${item.value.environment.platform}: scorecard invalid`);
  if (item.value.environment.gitSha !== expectedSha) failures.push(`${item.value.environment.platform}: commit mismatch`);
  if (item.value.scorecardHash !== contentHash(item.value, "scorecardHash")) failures.push(`${item.value.environment.platform}: scorecard hash mismatch`);
  if (item.value.portableResultHash !== contentHash(item.value.portableResult, "unused")) failures.push(`${item.value.environment.platform}: portable result hash mismatch`);
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
const report = `# Slidewright cross-platform replication report\n\n- Valid: **${aggregate.valid}**\n- Repository: ${aggregate.repository}\n- Commit: \`${aggregate.gitSha}\`\n- Run: ${aggregate.runUrl}\n- Evidence manifest: \`${aggregate.manifestHash}\`\n- Portable result: \`${aggregate.portableResultHash}\`\n- Aggregate: \`${aggregate.aggregateHash}\`\n\n## Platforms\n\n${aggregate.platforms.map((item) => `- ${item.platform}: ${item.portableResult.testsPassed} tests, ${item.portableResult.requiredTestsVerified}/${item.portableResult.requiredTestsExpected} required destructive-control tests, ${item.portableResult.demoSlides} demo slides, ${item.portableResult.errors} errors, ${item.portableResult.warnings} warnings`).join("\n")}\n\n## Scope\n\n- ${aggregate.scope.reproducedOnBothHosts}\n- ${aggregate.scope.capableHostSnapshots}\n`;
await fs.writeFile(path.join(output, "FRESH_MACHINE_REPLICATION.md"), report, "utf8");
process.stdout.write(report);
if (!aggregate.valid) process.exit(1);
