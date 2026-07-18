import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { contentHash, nodeTestPassed, parseNodeTestSummary, sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.RUNNER_OS || `${process.platform}-${process.arch}`;
const slug = platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const output = path.join(root, "outputs", "public-evidence", slug);
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });

async function run(id, command, args, displayCommand) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: false });
  const log = `${result.stdout || ""}${result.stderr || ""}${result.error ? `\n${result.error.stack || result.error.message}\n` : ""}`;
  const logFile = `${id}.log`;
  await fs.writeFile(path.join(output, logFile), log, "utf8");
  return {
    id,
    command: displayCommand || [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    error: result.error ? (result.error.code || result.error.message) : null,
    durationMs: Date.now() - started,
    logFile,
    logBytes: Buffer.byteLength(log, "utf8"),
    logSha256: sha256(log),
    log,
  };
}

const node = process.execPath;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this command through npm run evidence:ci.");
const contract = JSON.parse(await fs.readFile(path.join(root, "evidence", "portable-contract.json"), "utf8"));
if (contract.schemaVersion !== "slidewright-portable-evidence-contract/v1") throw new Error("Portable evidence contract schema is unsupported.");

const commands = [];
commands.push(await run("tests", node, [npmCli, "test"], "npm test"));
commands.push(await run("demo-compile", node, [npmCli, "run", "demo:compile"], "npm run demo:compile"));
commands.push(await run("demo-lint", node, [npmCli, "run", "demo:lint"], "npm run demo:lint"));
const relativeVerification = path.posix.join("outputs", "public-evidence", slug, "verified-evidence.json");
commands.push(await run("public-evidence", node, ["scripts/verify-public-evidence.mjs", "--portable-source", "--out", relativeVerification], `node scripts/verify-public-evidence.mjs --portable-source --out ${relativeVerification}`));

const lint = JSON.parse(await fs.readFile(path.join(root, "outputs", "demo", "lint-report.json"), "utf8"));
const plan = JSON.parse(await fs.readFile(path.join(root, "outputs", "demo", "plan.json"), "utf8"));
const verifiedEvidence = JSON.parse(await fs.readFile(path.join(output, "verified-evidence.json"), "utf8"));
const python = spawnSync(process.platform === "win32" ? "python.exe" : "python", ["--version"], { encoding: "utf8" });
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const { total, passed, failed, cancelled, skipped } = parseNodeTestSummary(commands[0].log);
const missingRequiredTests = contract.requiredTestNames.filter((name) => !nodeTestPassed(commands[0].log, name));
const portableResult = {
  testsTotal: total,
  testsFailed: failed,
  testsCancelled: cancelled,
  minimumTests: contract.minimumTestCount,
  requiredTestsVerified: contract.requiredTestNames.length - missingRequiredTests.length,
  requiredTestsExpected: contract.requiredTestNames.length,
  demoSlides: plan.slides?.length || 0,
  errors: lint.counts?.error,
  warnings: lint.counts?.warning,
  manifestHash: verifiedEvidence.manifestHash,
  scorecardsVerified: verifiedEvidence.scorecards.length,
};
const portableResultHash = contentHash(portableResult, "unused");

const scorecard = {
  schemaVersion: "slidewright-fresh-host-scorecard/v1",
  valid: commands.every((item) => item.exitCode === 0)
    && total >= contract.minimumTestCount
    && failed === 0
    && cancelled === 0
    && missingRequiredTests.length === 0
    && lint.counts?.error <= contract.maximumErrors
    && lint.counts?.warning <= contract.maximumWarnings
    && plan.slides?.length === contract.demoSlides
    && verifiedEvidence.valid === true,
  environment: {
    platform,
    osPlatform: process.platform,
    architecture: process.arch,
    node: process.version,
    python: `${python.stdout || python.stderr || ""}`.trim(),
    gitSha: (process.env.GITHUB_SHA || git.stdout || "").trim(),
    githubRunId: process.env.GITHUB_RUN_ID || null,
    repository: process.env.GITHUB_REPOSITORY || null,
    runUrl: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
  },
  portableResult,
  portableResultHash,
  tests: { total, passed, failed, cancelled, skipped, minimum: contract.minimumTestCount, required: contract.requiredTestNames, missingRequiredTests },
  demo: { slides: plan.slides?.length || 0, errors: lint.counts?.error, warnings: lint.counts?.warning },
  publicEvidence: { manifestHash: verifiedEvidence.manifestHash, scorecards: verifiedEvidence.scorecards.length },
  commands: commands.map(({ id, command, exitCode, signal, error, durationMs, logFile, logBytes, logSha256 }) => ({ id, command, exitCode, signal, error, durationMs, logFile, logBytes, logSha256 })),
  limitations: [
    "This fresh-host job reproduces the portable compiler, linter, unit/destructive-control tests, and public-evidence integrity checks.",
    "PowerPoint-only and Codex-runtime rendering scorecards are verified as content-addressed curated evidence; they require the documented capable-host commands to regenerate.",
  ],
};
scorecard.scorecardHash = contentHash(scorecard, "scorecardHash");
await fs.writeFile(path.join(output, "fresh-host-scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");

const report = `# Slidewright fresh-host replication\n\n- Valid: **${scorecard.valid}**\n- Platform: ${platform} (${process.platform}/${process.arch})\n- Git commit: \`${scorecard.environment.gitSha}\`\n- Node: ${scorecard.environment.node}\n- Python: ${scorecard.environment.python}\n- Tests: ${scorecard.tests.passed} passed, ${scorecard.tests.failed} failed, ${scorecard.tests.cancelled} cancelled, ${scorecard.tests.skipped} skipped (${scorecard.tests.total} total; minimum ${scorecard.tests.minimum})\n- Required destructive-control tests: ${scorecard.portableResult.requiredTestsVerified}/${scorecard.portableResult.requiredTestsExpected}\n- Demo: ${scorecard.demo.slides} slides, ${scorecard.demo.errors} errors, ${scorecard.demo.warnings} warnings\n- Public scorecards verified: ${scorecard.publicEvidence.scorecards}\n- Evidence manifest: \`${scorecard.publicEvidence.manifestHash}\`\n- Portable result: \`${scorecard.portableResultHash}\`\n- Scorecard: \`${scorecard.scorecardHash}\`\n\n## Exact commands\n\n${scorecard.commands.map((item) => `- \`${item.command}\` -> exit ${item.exitCode}${item.signal ? `, signal ${item.signal}` : ""}${item.error ? `, error ${item.error}` : ""}`).join("\n")}\n\n## Scope\n\n${scorecard.limitations.map((item) => `- ${item}`).join("\n")}\n`;
await fs.writeFile(path.join(output, "FRESH_HOST_REPORT.md"), report, "utf8");

if (!scorecard.valid) {
  process.stderr.write(`${report}\n`);
  process.exit(1);
}
process.stdout.write(`${report}\n`);
