#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MIN_ARTIFACT_TOOL_VERSION,
  RUNTIME_OVERRIDE_INVALID_CODE,
  RUNTIME_UNAVAILABLE_CODE,
  detectHostProfile,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/artifact-runtime.mjs";
import {
  RUNTIME_SCORECARD_SCHEMA,
  assertOwnedOutput,
  hashImplementation,
  sha256Bytes,
  sha256File,
  stableJson,
  validateRuntimeScorecard,
} from "./lib/runtime-bootstrap-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const detectedProfile = detectHostProfile();
const profile = option("--profile", detectedProfile);
if (profile !== detectedProfile) throw new Error(`Profile ${profile} cannot be proved on actual host ${detectedProfile}.`);
const out = assertOwnedOutput(root, option("--out", path.join(root, "outputs", "runtime-bootstrap", profile)));
const contractPath = path.join(root, "evidence", "runtime-bootstrap-contract.json");
const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `git ${gitArgs.join(" ")} failed`);
  return result.stdout.trim();
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function makeFixtureRuntime(runtimeRoot) {
  const packageDir = path.join(runtimeRoot, "dependencies", "node", "node_modules", "@oai", "artifact-tool");
  await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({
    name: "@oai/artifact-tool",
    version: MIN_ARTIFACT_TOOL_VERSION,
    type: "module",
    exports: { ".": "./dist/artifact_tool.mjs" },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(packageDir, "dist", "artifact_tool.mjs"), "export class Presentation {}\nexport class PresentationFile {}\n", "utf8");
  return packageDir;
}

function isolatedEnv(home, extra = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, ".codex"),
    ...extra,
  };
  for (const name of [
    "SLIDEWRIGHT_ARTIFACT_TOOL_PATH",
    "SLIDEWRIGHT_ARTIFACT_SETUP_SCRIPT",
    "SLIDEWRIGHT_PRESENTATIONS_ROOT",
    "SLIDEWRIGHT_CODEX_RUNTIME_ROOT",
  ]) delete env[name];
  return env;
}

function actualHostEnv() {
  const env = { ...process.env };
  for (const name of [
    "SLIDEWRIGHT_ARTIFACT_TOOL_PATH",
    "SLIDEWRIGHT_ARTIFACT_SETUP_SCRIPT",
    "SLIDEWRIGHT_PRESENTATIONS_ROOT",
    "SLIDEWRIGHT_CODEX_RUNTIME_ROOT",
  ]) delete env[name];
  return env;
}

function runSetup(cwd, env) {
  return spawnSync(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs"), "--workspace", cwd, "--json"], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

function count(text, pattern) {
  return [...String(text).matchAll(pattern)].length;
}

function normalizeText(text, replacements) {
  let normalized = String(text || "").replaceAll("\r\n", "\n");
  for (const [value, replacement] of replacements) {
    normalized = normalized.replaceAll(value, replacement);
    normalized = normalized.replaceAll(JSON.stringify(value).slice(1, -1), replacement);
  }
  return normalized;
}

function commandReceipt(id, result, replacements) {
  const stdout = normalizeText(result.stdout, replacements);
  const stderr = normalizeText(result.stderr, replacements);
  return {
    id,
    argv: ["node", "<repo>/scripts/setup-artifact-runtime.mjs", "--workspace", "<target-workspace>", "--json"],
    exitCode: result.status,
    stdout,
    stderr,
    stdoutSha256: sha256Bytes(stdout),
    stderrSha256: sha256Bytes(stderr),
  };
}

function failureRecord(receipt, code, workspaceUntouched) {
  const lines = receipt.stderr.trim().split("\n");
  return {
    exitCode: receipt.exitCode,
    code,
    codeOccurrences: count(receipt.stderr, new RegExp(code, "g")),
    stderrLineCount: lines.length,
    stderrSha256: receipt.stderrSha256,
    stdoutEmpty: receipt.stdout.length === 0,
    workspaceUntouched,
    recoveryPresent: lines.some((line) => line.startsWith("Recovery:")),
    localOnlyPolicyPresent: lines.includes("Policy: Slidewright made no network request, downloaded nothing, and did not switch renderers."),
  };
}

async function hashTree(treeRoot) {
  const records = [];
  const visitedDirectories = new Set();
  async function walk(current, logical) {
    const real = await fs.realpath(current);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) {
      const key = process.platform === "win32" ? real.toLowerCase() : real;
      if (visitedDirectories.has(key)) return;
      visitedDirectories.add(key);
      const entries = await fs.readdir(real, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        await walk(path.join(real, entry.name), logical ? `${logical}/${entry.name}` : entry.name);
      }
      return;
    }
    if (stat.isFile()) records.push({ path: logical, size: stat.size, sha256: await sha256File(real) });
  }
  await walk(treeRoot, "");
  return { fileCount: records.length, files: records, sha256: sha256Bytes(stableJson(records)) };
}

async function auditLocalOnlySources(files) {
  const patterns = [
    { id: "url", regex: /https?:\/\//gi },
    { id: "fetch", regex: /\bfetch\s*\(/gi },
    { id: "node-http-import", regex: /["']node:https?["']/gi },
    { id: "http-request", regex: /\bhttps?\.(?:get|request)\s*\(/gi },
    { id: "socket-import", regex: /["']node:(?:net|tls)["']/gi },
    { id: "websocket", regex: /\bWebSocket\b/gi },
    { id: "downloader", regex: /\b(?:curl|wget|Invoke-WebRequest)\b/gi },
    { id: "package-install", regex: /\b(?:npm|pnpm|yarn)\s+(?:install|add)\b/gi },
  ];
  const records = [];
  const matches = [];
  for (const relativePath of files) {
    const content = await fs.readFile(path.join(root, relativePath), "utf8");
    records.push({ path: relativePath, sha256: sha256Bytes(content.replaceAll("\r\n", "\n")) });
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern.regex)) matches.push({ path: relativePath, pattern: pattern.id, index: match.index });
    }
  }
  return { files: records, networkPrimitiveMatches: matches };
}

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), `slidewright-c03-${profile}-`));
try {
  const cleanHome = path.join(scratch, "clean-home");
  const fixtureRoot = path.join(scratch, "fixture-runtime");
  const fixturePackage = await makeFixtureRuntime(fixtureRoot);
  const replacements = [
    [scratch, "<scratch>"],
    [root, "<repo>"],
    [os.homedir(), "<home>"],
    [process.env.HOME, "<home>"],
    [process.env.USERPROFILE, "<home>"],
  ].filter(([value], index, values) => value && values.findIndex(([candidate]) => candidate === value) === index);

  const fixtureWorkspace = path.join(scratch, "fixture-workspace");
  const fixtureExistedBefore = await pathExists(fixtureWorkspace);
  const fixtureProcess = runSetup(fixtureWorkspace, { ...isolatedEnv(cleanHome), SLIDEWRIGHT_CODEX_RUNTIME_ROOT: fixtureRoot });
  const fixtureReceipt = commandReceipt("resolver-contract-fixture", fixtureProcess, replacements);
  fixtureReceipt.workspace = { existedBefore: fixtureExistedBefore, existsAfter: await pathExists(fixtureWorkspace) };
  const fixtureReport = fixtureProcess.status === 0 ? JSON.parse(fixtureProcess.stdout) : null;
  const fixtureTree = await hashTree(fixturePackage);

  const failureWorkspace = path.join(scratch, "failure-workspace");
  const failureExistedBefore = await pathExists(failureWorkspace);
  const failureProcess = runSetup(failureWorkspace, isolatedEnv(cleanHome));
  const failureReceipt = commandReceipt("clean-host-actionable-failure", failureProcess, replacements);
  failureReceipt.workspace = { existedBefore: failureExistedBefore, existsAfter: await pathExists(failureWorkspace) };
  const failure = failureRecord(failureReceipt, RUNTIME_UNAVAILABLE_CODE, !await pathExists(failureWorkspace));

  const overrideWorkspace = path.join(scratch, "invalid-override-workspace");
  const overrideExistedBefore = await pathExists(overrideWorkspace);
  const missingOverride = path.join(scratch, "missing-explicit-package");
  const overrideProcess = runSetup(overrideWorkspace, {
    ...isolatedEnv(cleanHome),
    SLIDEWRIGHT_ARTIFACT_TOOL_PATH: missingOverride,
    SLIDEWRIGHT_CODEX_RUNTIME_ROOT: fixtureRoot,
  });
  const overrideReceipt = commandReceipt("invalid-override-fails-closed", overrideProcess, replacements);
  overrideReceipt.workspace = { existedBefore: overrideExistedBefore, existsAfter: await pathExists(overrideWorkspace) };
  const invalidOverride = {
    ...failureRecord(overrideReceipt, RUNTIME_OVERRIDE_INVALID_CODE, !await pathExists(overrideWorkspace)),
    fellThrough: await pathExists(overrideWorkspace),
  };

  const actualWorkspace = path.join(scratch, "actual-host-runtime");
  const actualExistedBefore = await pathExists(actualWorkspace);
  const actualProcess = runSetup(actualWorkspace, actualHostEnv());
  const actualReceipt = commandReceipt("actual-host-outcome", actualProcess, replacements);
  actualReceipt.workspace = { existedBefore: actualExistedBefore, existsAfter: await pathExists(actualWorkspace) };
  let hostOutcome;
  let actualPackageTree = null;
  if (actualProcess.status === 0) {
    const report = JSON.parse(actualProcess.stdout);
    actualPackageTree = await hashTree(report.artifactToolPackage);
    hostOutcome = {
      kind: "runtime-resolved",
      hostProfile: report.hostProfile,
      source: report.source,
      artifactToolVersion: report.artifactToolVersion,
      downloaded: report.downloaded,
      rendererSwitched: report.rendererSwitched,
      importSmokePassed: Boolean(report.resolvedEntrypoint),
      packageTree: { fileCount: actualPackageTree.fileCount, sha256: actualPackageTree.sha256 },
      commandExitCode: actualReceipt.exitCode,
      commandStdoutSha256: actualReceipt.stdoutSha256,
      commandStderrSha256: actualReceipt.stderrSha256,
    };
  } else {
    hostOutcome = {
      kind: "actionable-failure",
      hostProfile: profile,
      ...failureRecord(actualReceipt, RUNTIME_UNAVAILABLE_CODE, !await pathExists(actualWorkspace)),
      commandStdoutSha256: actualReceipt.stdoutSha256,
    };
  }

  const implementation = await hashImplementation(root, contract.implementationFiles);
  const sourceAudit = await auditLocalOnlySources(contract.sourceAuditFiles);
  const fixture = {
    syntheticContractFixture: true,
    source: fixtureReport?.source ?? null,
    hostProfile: fixtureReport?.hostProfile ?? null,
    artifactToolVersion: fixtureReport?.artifactToolVersion ?? null,
    downloaded: fixtureReport?.downloaded ?? null,
    rendererSwitched: fixtureReport?.rendererSwitched ?? null,
    importSmokePassed: Boolean(fixtureReport?.resolvedEntrypoint),
    sourcePackageTree: { fileCount: fixtureTree.fileCount, sha256: fixtureTree.sha256 },
    linkedPackageIdentityPreserved: fixtureReport ? await fs.realpath(fixtureReport.artifactToolPackage) === await fs.realpath(fixturePackage) : false,
    commandExitCode: fixtureReceipt.exitCode,
    commandStdoutSha256: fixtureReceipt.stdoutSha256,
    commandStderrSha256: fixtureReceipt.stderrSha256,
  };
  const controls = [
    { id: "resolver-contract-fixture", passed: fixture.syntheticContractFixture && fixture.source === "explicit-runtime-root" && fixture.hostProfile === profile && fixture.artifactToolVersion === MIN_ARTIFACT_TOOL_VERSION && fixture.downloaded === false && fixture.rendererSwitched === false && fixture.importSmokePassed && fixture.linkedPackageIdentityPreserved && fixture.sourcePackageTree.fileCount >= 2 },
    { id: "actual-host-outcome", passed: hostOutcome.hostProfile === profile && (hostOutcome.kind === "runtime-resolved" ? hostOutcome.downloaded === false && hostOutcome.rendererSwitched === false && hostOutcome.importSmokePassed && hostOutcome.packageTree.fileCount > 2 : hostOutcome.exitCode === 1 && hostOutcome.codeOccurrences === 1 && hostOutcome.recoveryPresent && hostOutcome.localOnlyPolicyPresent && hostOutcome.workspaceUntouched) },
    { id: "clean-host-actionable-failure", passed: failure.exitCode === 1 && failure.codeOccurrences === 1 && failure.stderrLineCount === 4 && failure.stdoutEmpty && failure.workspaceUntouched && failure.recoveryPresent && failure.localOnlyPolicyPresent },
    { id: "invalid-override-fails-closed", passed: invalidOverride.exitCode === 1 && invalidOverride.codeOccurrences === 1 && invalidOverride.stderrLineCount === 5 && invalidOverride.stdoutEmpty && invalidOverride.workspaceUntouched && invalidOverride.recoveryPresent && invalidOverride.localOnlyPolicyPresent && invalidOverride.fellThrough === false },
    { id: "local-only-source-audit", passed: sourceAudit.networkPrimitiveMatches.length === 0 },
  ];
  const commandLog = {
    schemaVersion: "slidewright-runtime-bootstrap-command-log-v2",
    profile,
    commands: [fixtureReceipt, failureReceipt, overrideReceipt, actualReceipt],
    trees: { fixture: fixtureTree, actual: actualPackageTree },
  };
  const logPath = path.join(out, "runtime-bootstrap-command-log.json");
  await fs.writeFile(logPath, `${JSON.stringify(commandLog, null, 2)}\n`, "utf8");
  const procVersion = await fs.readFile("/proc/version", "utf8").catch(() => null);
  const filesystem = await fs.statfs(scratch).catch(() => null);
  const host = {
    profile,
    platform: process.platform,
    architecture: process.arch,
    release: os.release(),
    profileDetectedWithoutOverride: profile === detectHostProfile(),
    wslDistro: profile === "wsl" ? process.env.WSL_DISTRO_NAME ?? null : null,
    procVersionSha256: procVersion ? sha256Bytes(procVersion) : null,
    procVersionContainsMicrosoft: procVersion ? /microsoft/i.test(procVersion) : false,
    tempFilesystemType: filesystem ? String(filesystem.type) : null,
  };
  const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  const releaseUrl = process.env.SLIDEWRIGHT_EVIDENCE_URL || null;
  const evidenceKind = runUrl ? "github-actions" : releaseUrl ? "github-release" : "local";
  const scorecard = {
    schemaVersion: RUNTIME_SCORECARD_SCHEMA,
    generatedAt: new Date().toISOString(),
    host,
    git: {
      commit: process.env.GITHUB_SHA || git("rev-parse", "HEAD"),
      evidenceKind,
      evidenceUrl: runUrl || releaseUrl,
      commandLogUrl: evidenceKind === "github-release" ? releaseUrl.replace(/runtime-bootstrap-scorecard\.json$/, "runtime-bootstrap-command-log.json") : null,
      runUrl,
    },
    contractSha256: await sha256File(contractPath),
    implementation,
    policy: { network: contract.networkPolicy, renderer: contract.rendererPolicy, minimumArtifactToolVersion: contract.minimumArtifactToolVersion },
    fixture,
    hostOutcome,
    failure,
    invalidOverride,
    sourceAudit,
    commandLog: { path: "runtime-bootstrap-command-log.json", sha256: await sha256File(logPath) },
    controls,
    valid: controls.every((control) => control.passed),
  };
  const validation = validateRuntimeScorecard(scorecard, contract, commandLog);
  if (!validation.valid) throw new Error(`Runtime scorecard failed validation: ${validation.errors.join(", ")}`);
  const scorecardPath = path.join(out, "runtime-bootstrap-scorecard.json");
  await fs.writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(out, "RUNTIME_BOOTSTRAP_REPORT.md"), [
    `# Runtime bootstrap evidence: ${profile}`,
    "",
    `- Valid: ${scorecard.valid}`,
    `- Synthetic resolver fixture: ${scorecard.fixture.artifactToolVersion} via ${scorecard.fixture.source}`,
    `- Actual host outcome: ${scorecard.hostOutcome.kind}${scorecard.hostOutcome.artifactToolVersion ? ` (${scorecard.hostOutcome.artifactToolVersion})` : ""}`,
    `- Clean-host failure: ${scorecard.failure.code}, exactly ${scorecard.failure.codeOccurrences} occurrence`,
    `- Invalid override: ${scorecard.invalidOverride.code}, fallback used: ${scorecard.invalidOverride.fellThrough}`,
    `- Network primitives in runtime sources: ${scorecard.sourceAudit.networkPrimitiveMatches.length}`,
    `- Implementation SHA-256: ${scorecard.implementation.sha256}`,
    `- Scorecard content SHA-256: ${sha256Bytes(stableJson(scorecard))}`,
    "",
  ].join("\n"), "utf8");
  process.stdout.write(`C03 runtime bootstrap ${profile}: PASS -> ${path.relative(root, scorecardPath)}\n`);
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
