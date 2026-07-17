#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_AGGREGATE_SCHEMA,
  assertOwnedOutput,
  fetchAndVerifyRuntimeReleaseAssets,
  hashImplementation,
  sha256Bytes,
  sha256File,
  stableJson,
  validateRuntimeAggregate,
  validateRuntimeScorecard,
} from "./lib/runtime-bootstrap-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = path.resolve(option("--input", path.join(root, "outputs", "runtime-bootstrap-hosts")));
const out = assertOwnedOutput(root, option("--out", path.join(root, "outputs", "runtime-bootstrap-aggregate")));
const scope = option("--scope", "complete");
if (!["native", "complete"].includes(scope)) throw new Error(`Unknown aggregate scope: ${scope}`);

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `git ${gitArgs.join(" ")} failed`);
  return result.stdout.trim();
}

async function findScorecards(directory) {
  const matches = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(candidate);
      else if (entry.isFile() && entry.name === "runtime-bootstrap-scorecard.json") matches.push(candidate);
    }
  }
  await walk(directory);
  return matches.sort();
}

const contractPath = path.join(root, "evidence", "runtime-bootstrap-contract.json");
const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
const expectedProfiles = scope === "native" ? contract.nativeCiProfiles : contract.requiredProfiles;
const contractSha256 = await sha256File(contractPath);
const scorecardPaths = await findScorecards(input);
if (scorecardPaths.length !== expectedProfiles.length) {
  throw new Error(`Expected ${expectedProfiles.length} ${scope} runtime scorecards; found ${scorecardPaths.length}.`);
}
const byProfile = new Map();
for (const scorecardPath of scorecardPaths) {
  const scorecardBytes = await fs.readFile(scorecardPath);
  const scorecard = JSON.parse(scorecardBytes.toString("utf8"));
  const commandLogPath = path.join(path.dirname(scorecardPath), scorecard.commandLog.path);
  if (await sha256File(commandLogPath) !== scorecard.commandLog.sha256) throw new Error(`${scorecardPath} has a missing or modified command log.`);
  const commandLogBytes = await fs.readFile(commandLogPath);
  const commandLog = JSON.parse(commandLogBytes.toString("utf8"));
  const validation = validateRuntimeScorecard(scorecard, contract, commandLog);
  if (!validation.valid) throw new Error(`${scorecardPath} is invalid: ${validation.errors.join(", ")}`);
  if (scorecard.contractSha256 !== contractSha256) throw new Error(`${scorecardPath} is bound to a different runtime contract.`);
  if (sha256Bytes(stableJson(scorecard.implementation.files)) !== scorecard.implementation.sha256) throw new Error(`${scorecardPath} has a forged implementation hash.`);
  if (byProfile.has(scorecard.host.profile)) throw new Error(`Duplicate runtime profile: ${scorecard.host.profile}`);
  byProfile.set(scorecard.host.profile, { scorecard, scorecardPath, scorecardBytes, commandLogBytes });
}
for (const profile of expectedProfiles) if (!byProfile.has(profile)) throw new Error(`Missing runtime profile: ${profile}`);

const commit = [...new Set([...byProfile.values()].map(({ scorecard }) => scorecard.git.commit))];
if (commit.length !== 1) throw new Error(`Runtime scorecards span multiple commits: ${commit.join(", ")}`);
const checkoutCommit = git("rev-parse", "HEAD");
if (commit[0] !== checkoutCommit) throw new Error(`Runtime scorecards bind ${commit[0]}, not checkout ${checkoutCommit}.`);
const implementationHashes = [...new Set([...byProfile.values()].map(({ scorecard }) => scorecard.implementation.sha256))];
if (implementationHashes.length !== 1) throw new Error(`Runtime implementations differ across hosts: ${implementationHashes.join(", ")}`);
const checkoutImplementation = await hashImplementation(root, contract.implementationFiles);
if (implementationHashes[0] !== checkoutImplementation.sha256) throw new Error(`Runtime scorecards do not match the checked-out implementation: ${implementationHashes[0]} != ${checkoutImplementation.sha256}.`);
const nativeScorecards = contract.nativeCiProfiles.map((profile) => byProfile.get(profile)?.scorecard).filter(Boolean);
if (nativeScorecards.length !== contract.nativeCiProfiles.length || nativeScorecards.some((scorecard) => scorecard.git.evidenceKind !== "github-actions" || !scorecard.git.runUrl)) throw new Error("Every native runtime scorecard must bind the public GitHub Actions run URL.");
const runUrls = [...new Set(nativeScorecards.map((scorecard) => scorecard.git.runUrl))];
if (runUrls.length !== 1) throw new Error(`Runtime scorecards span multiple GitHub runs: ${runUrls.join(", ")}`);
const wslScorecard = byProfile.get("wsl")?.scorecard ?? null;
if (scope === "complete" && (!wslScorecard || wslScorecard.git.evidenceKind !== "github-release" || !wslScorecard.git.evidenceUrl || !wslScorecard.git.commandLogUrl)) throw new Error("Complete evidence requires public GitHub release scorecard and command-log assets from a genuine WSL host.");
const wslPublicFetch = scope === "complete" ? await fetchAndVerifyRuntimeReleaseAssets({
  scorecardUrl: wslScorecard.git.evidenceUrl,
  commandLogUrl: wslScorecard.git.commandLogUrl,
  expectedScorecardBytes: byProfile.get("wsl").scorecardBytes,
  expectedCommandLogBytes: byProfile.get("wsl").commandLogBytes,
}) : null;
const expectedRunUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;
if (expectedRunUrl && runUrls[0] !== expectedRunUrl) throw new Error(`Runtime scorecards bind ${runUrls[0] ?? "no run"}, not current run ${expectedRunUrl}.`);

const profiles = expectedProfiles.map((profile) => {
  const { scorecard, scorecardPath } = byProfile.get(profile);
  return {
    profile,
    platform: scorecard.host.platform,
    architecture: scorecard.host.architecture,
    scorecardSha256: null,
    commandLogSha256: scorecard.commandLog.sha256,
    fixture: scorecard.fixture,
    hostOutcome: scorecard.hostOutcome,
    failure: scorecard.failure,
    invalidOverride: scorecard.invalidOverride,
    sourceAudit: scorecard.sourceAudit,
    relativeSource: path.relative(input, scorecardPath).replaceAll("\\", "/"),
  };
});
for (const entry of profiles) {
  entry.scorecardSha256 = await sha256File(byProfile.get(entry.profile).scorecardPath);
}
const aggregateCore = {
  schemaVersion: RUNTIME_AGGREGATE_SCHEMA,
  scope,
  complete: scope === "complete",
  creditEligible: scope === "complete",
  pendingProfiles: contract.requiredProfiles.filter((profile) => !expectedProfiles.includes(profile)),
  git: { commit: commit[0], runUrl: runUrls[0] ?? null },
  provenance: {
    nativeRunUrl: runUrls[0] ?? null,
    wslReleaseUrl: wslScorecard?.git.evidenceUrl ?? null,
    wslCommandLogUrl: wslScorecard?.git.commandLogUrl ?? null,
    wslPublicFetch,
  },
  contractSha256,
  implementationSha256: implementationHashes[0],
  profiles,
};
const aggregate = {
  ...aggregateCore,
  aggregateSha256: sha256Bytes(stableJson(aggregateCore)),
  valid: true,
};
const validation = validateRuntimeAggregate(aggregate, contract);
if (!validation.valid) throw new Error(`Runtime aggregate failed validation: ${validation.errors.join(", ")}`);

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const aggregatePath = path.join(out, "runtime-bootstrap-aggregate.json");
await fs.writeFile(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(out, "RUNTIME_BOOTSTRAP_AGGREGATE.md"), [
  "# Cross-platform runtime bootstrap evidence",
  "",
  `- Valid: ${aggregate.valid}`,
  `- Scope: ${aggregate.scope}`,
  `- Credit eligible: ${aggregate.creditEligible}`,
  `- Pending profiles: ${aggregate.pendingProfiles.join(", ") || "none"}`,
  `- Commit: ${aggregate.git.commit}`,
  `- GitHub run: ${aggregate.git.runUrl ?? "local"}`,
  `- Profiles: ${aggregate.profiles.map((entry) => entry.profile).join(", ")}`,
  `- Implementation SHA-256: ${aggregate.implementationSha256}`,
  `- Aggregate SHA-256: ${aggregate.aggregateSha256}`,
  `- No-download source audits: ${aggregate.profiles.every((entry) => entry.sourceAudit.networkPrimitiveMatches.length === 0)}`,
  "",
].join("\n"), "utf8");
process.stdout.write(`C03 ${scope === "complete" ? "complete aggregate" : "native checkpoint"}: PASS (${profiles.length} profiles; credit eligible: ${aggregate.creditEligible}) -> ${path.relative(root, aggregatePath)}\n`);
