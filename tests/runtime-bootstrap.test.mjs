import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RUNTIME_OVERRIDE_INVALID_CODE,
  RUNTIME_UNAVAILABLE_CODE,
  bootstrapArtifactWorkspace,
  detectHostProfile,
  inspectArtifactToolPackage,
  resolveArtifactRuntime,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/artifact-runtime.mjs";
import { collectPreflight } from "../plugins/slidewright/skills/slidewright/scripts/lib/preflight.mjs";
import {
  RUNTIME_AGGREGATE_SCHEMA,
  RUNTIME_SCORECARD_SCHEMA,
  assertOwnedOutput,
  fetchAndVerifyRuntimeReleaseAssets,
  sha256Bytes,
  stableJson,
  validateRuntimeAggregate,
  validateRuntimeScorecard,
} from "../scripts/lib/runtime-bootstrap-evidence.mjs";

const contract = JSON.parse(await fs.readFile(new URL("../evidence/runtime-bootstrap-contract.json", import.meta.url), "utf8"));
const hash = "a".repeat(64);

function validScorecard(profile = "linux") {
  const platform = { windows: "win32", macos: "darwin", linux: "linux", wsl: "linux" }[profile];
  const unavailable = [
    `[${contract.failureCodes.unavailable}] unavailable`,
    "Checked local candidates.",
    "Recovery: install or select a local runtime.",
    "Policy: Slidewright made no network request, downloaded nothing, and did not switch renderers.",
  ].join("\n") + "\n";
  const invalid = [
    `[${contract.failureCodes.invalidOverride}] invalid override`,
    "Checked: <scratch>/missing",
    "Reason: missing",
    "Recovery: correct or unset the override.",
    "Policy: Slidewright made no network request, downloaded nothing, and did not switch renderers.",
  ].join("\n") + "\n";
  const fixtureCandidate = "<scratch>/runtime/@oai/artifact-tool";
  const fixtureReport = `${JSON.stringify({ source: "explicit-runtime-root", hostProfile: profile, artifactToolVersion: contract.minimumArtifactToolVersion, downloaded: false, rendererSwitched: false, resolvedEntrypoint: `${fixtureCandidate}/dist/artifact_tool.mjs`, attempts: [{ source: "explicit-runtime-root", candidate: fixtureCandidate, valid: true }] })}\n`;
  const command = (id, exitCode, stdout, stderr, workspace) => ({
    id,
    argv: ["node", "<repo>/scripts/setup-artifact-runtime.mjs", "--workspace", "<target-workspace>", "--json"],
    exitCode,
    stdout,
    stderr,
    stdoutSha256: sha256Bytes(stdout),
    stderrSha256: sha256Bytes(stderr),
    workspace,
  });
  const fixtureFiles = [
    { path: "dist/artifact_tool.mjs", size: 10, sha256: hash },
    { path: "package.json", size: 20, sha256: hash },
  ];
  const fixtureTree = { fileCount: fixtureFiles.length, files: fixtureFiles, sha256: sha256Bytes(stableJson(fixtureFiles)) };
  const commandLog = {
    schemaVersion: "slidewright-runtime-bootstrap-command-log-v2",
    profile,
    commands: [
      command("resolver-contract-fixture", 0, fixtureReport, "", { existedBefore: false, existsAfter: true }),
      command("clean-host-actionable-failure", 1, "", unavailable, { existedBefore: false, existsAfter: false }),
      command("invalid-override-fails-closed", 1, "", invalid, { existedBefore: false, existsAfter: false }),
      command("actual-host-outcome", 1, "", unavailable, { existedBefore: false, existsAfter: false }),
    ],
    trees: { fixture: fixtureTree, actual: null },
  };
  const failure = { exitCode: 1, code: contract.failureCodes.unavailable, codeOccurrences: 1, stderrLineCount: 4, stderrSha256: sha256Bytes(unavailable), stdoutEmpty: true, workspaceUntouched: true, recoveryPresent: true, localOnlyPolicyPresent: true };
  const scorecard = {
    schemaVersion: RUNTIME_SCORECARD_SCHEMA,
    host: {
      profile,
      platform,
      architecture: "x64",
      release: "test-release",
      profileDetectedWithoutOverride: true,
      wslDistro: profile === "wsl" ? "Ubuntu" : null,
      procVersionSha256: profile === "wsl" ? hash : null,
      procVersionContainsMicrosoft: profile === "wsl",
      tempFilesystemType: profile === "wsl" ? "0x1234" : null,
    },
    git: { commit: "b".repeat(40), evidenceKind: "github-actions", evidenceUrl: "https://github.com/example/slidewright/actions/runs/123", commandLogUrl: null, runUrl: "https://github.com/example/slidewright/actions/runs/123" },
    contractSha256: hash,
    implementation: { files: [...contract.implementationFiles].sort().map((entry) => ({ path: entry, sha256: hash })), sha256: hash },
    policy: { network: contract.networkPolicy, renderer: contract.rendererPolicy },
    fixture: { syntheticContractFixture: true, source: "explicit-runtime-root", hostProfile: profile, artifactToolVersion: contract.minimumArtifactToolVersion, sourcePackageTree: { fileCount: fixtureTree.fileCount, sha256: fixtureTree.sha256 }, linkedPackageIdentityPreserved: true, downloaded: false, rendererSwitched: false, importSmokePassed: true, commandExitCode: 0, commandStdoutSha256: sha256Bytes(fixtureReport), commandStderrSha256: sha256Bytes("") },
    hostOutcome: { kind: "actionable-failure", hostProfile: profile, ...failure, commandStdoutSha256: sha256Bytes("") },
    failure,
    invalidOverride: { exitCode: 1, code: contract.failureCodes.invalidOverride, codeOccurrences: 1, stderrLineCount: 5, stderrSha256: sha256Bytes(invalid), stdoutEmpty: true, workspaceUntouched: true, recoveryPresent: true, localOnlyPolicyPresent: true, fellThrough: false },
    sourceAudit: { files: contract.sourceAuditFiles.map((entry) => ({ path: entry, sha256: hash })), networkPrimitiveMatches: [] },
    commandLog: { path: "runtime-bootstrap-command-log.json", sha256: hash },
    controls: contract.requiredControls.map((id) => ({ id, passed: true })),
    valid: true,
  };
  return { scorecard, commandLog };
}

function validResolvedScorecard(profile = "linux") {
  const value = validScorecard(profile);
  const candidate = "<scratch>/actual-runtime/@oai/artifact-tool";
  const actualFiles = [
    { path: "dist/artifact_tool.mjs", size: 30, sha256: hash },
    { path: "dist/index.mjs", size: 15, sha256: hash },
    { path: "package.json", size: 20, sha256: hash },
  ];
  const actualTree = { fileCount: actualFiles.length, files: actualFiles, sha256: sha256Bytes(stableJson(actualFiles)) };
  const actualReport = `${JSON.stringify({ source: "codex-bundled-runtime", hostProfile: profile, artifactToolVersion: "2.8.24", downloaded: false, rendererSwitched: false, resolvedEntrypoint: `${candidate}/dist/artifact_tool.mjs`, attempts: [{ source: "codex-bundled-runtime", candidate, valid: true }] })}\n`;
  const command = value.commandLog.commands[3];
  Object.assign(command, {
    exitCode: 0,
    stdout: actualReport,
    stderr: "",
    stdoutSha256: sha256Bytes(actualReport),
    stderrSha256: sha256Bytes(""),
    workspace: { existedBefore: false, existsAfter: true },
  });
  value.commandLog.trees.actual = actualTree;
  value.scorecard.hostOutcome = {
    kind: "runtime-resolved",
    hostProfile: profile,
    source: "codex-bundled-runtime",
    artifactToolVersion: "2.8.24",
    downloaded: false,
    rendererSwitched: false,
    importSmokePassed: true,
    packageTree: { fileCount: actualTree.fileCount, sha256: actualTree.sha256 },
    commandExitCode: 0,
    commandStdoutSha256: sha256Bytes(actualReport),
    commandStderrSha256: sha256Bytes(""),
  };
  return value;
}

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-runtime-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function createArtifactPackage(packageDir, version = "2.8.24") {
  await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "package.json"), `${JSON.stringify({
    name: "@oai/artifact-tool",
    version,
    type: "module",
    exports: { ".": "./dist/artifact_tool.mjs" },
  }, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(packageDir, "dist", "artifact_tool.mjs"), [
    "export class Presentation {}",
    "export class PresentationFile {}",
    "",
  ].join("\n"), "utf8");
  return packageDir;
}

async function createRuntimeRoot(root, version = "2.8.24") {
  const packageDir = path.join(root, "dependencies", "node", "node_modules", "@oai", "artifact-tool");
  await createArtifactPackage(packageDir, version);
  return { root, packageDir };
}

test("C03 host detection distinguishes Windows, macOS, Linux, and WSL", () => {
  assert.equal(detectHostProfile({ platform: "win32", release: "10.0", env: {} }), "windows");
  assert.equal(detectHostProfile({ platform: "darwin", release: "25.0", env: {} }), "macos");
  assert.equal(detectHostProfile({ platform: "linux", release: "6.8.0", env: {} }), "linux");
  assert.equal(detectHostProfile({ platform: "linux", release: "5.15.0-microsoft-standard-WSL2", env: {} }), "wsl");
  assert.equal(detectHostProfile({ platform: "linux", release: "6.8.0", env: { WSL_DISTRO_NAME: "Ubuntu" } }), "wsl");
});

test("C03 validates the package identity, minimum version, and built entrypoint", async (t) => {
  const root = await temporaryRoot(t);
  const valid = await createArtifactPackage(path.join(root, "valid"));
  assert.equal((await inspectArtifactToolPackage(valid)).valid, true);
  const old = await createArtifactPackage(path.join(root, "old"), "2.7.2");
  assert.match((await inspectArtifactToolPackage(old)).reason, />= 2\.7\.3/);
  const prerelease = await createArtifactPackage(path.join(root, "prerelease"), "2.7.3-beta.1");
  assert.match((await inspectArtifactToolPackage(prerelease)).reason, />= 2\.7\.3/);
  const malformed = await createArtifactPackage(path.join(root, "malformed"), "2.7.3garbage");
  assert.match((await inspectArtifactToolPackage(malformed)).reason, /invalid semantic version/);
  const leadingZero = await createArtifactPackage(path.join(root, "leading-zero"), "2.7.4-01");
  assert.match((await inspectArtifactToolPackage(leadingZero)).reason, /invalid semantic version/);
  const wrong = await createArtifactPackage(path.join(root, "wrong"));
  const wrongJson = JSON.parse(await fs.readFile(path.join(wrong, "package.json"), "utf8"));
  wrongJson.name = "lookalike-artifact-tool";
  await fs.writeFile(path.join(wrong, "package.json"), JSON.stringify(wrongJson), "utf8");
  assert.match((await inspectArtifactToolPackage(wrong)).reason, /expected @oai\/artifact-tool/);
  await fs.rm(path.join(valid, "dist", "artifact_tool.mjs"));
  assert.match((await inspectArtifactToolPackage(valid)).reason, /entrypoint is missing/);
  await fs.mkdir(path.join(valid, "dist", "artifact_tool.mjs"));
  assert.match((await inspectArtifactToolPackage(valid)).reason, /entrypoint is missing/);
});

test("C03 bootstraps directly from a supported bundled runtime without a download", async (t) => {
  const root = await temporaryRoot(t);
  const runtime = await createRuntimeRoot(path.join(root, "codex-primary-runtime"));
  const workspace = path.join(root, "workspace with spaces");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "package.json"), `${JSON.stringify({ private: true, main: "index.cjs" })}\n`, "utf8");
  const report = await bootstrapArtifactWorkspace({
    cwd: workspace,
    home: path.join(root, "clean-home"),
    env: { SLIDEWRIGHT_CODEX_RUNTIME_ROOT: runtime.root },
    platform: "linux",
    release: "6.8.0",
  });
  assert.equal(report.source, "explicit-runtime-root");
  assert.equal(report.hostProfile, "linux");
  assert.equal(report.artifactToolVersion, "2.8.24");
  assert.equal(report.downloaded, false);
  assert.equal(report.rendererSwitched, false);
  assert.equal(await fs.realpath(report.artifactToolPackage), await fs.realpath(runtime.packageDir));
  assert.match(report.resolvedEntrypoint, /artifact_tool\.mjs/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8")), { private: true, main: "index.cjs" });
});

test("C03 invalid explicit configuration fails closed without falling through", async (t) => {
  const root = await temporaryRoot(t);
  const runtime = await createRuntimeRoot(path.join(root, "valid-runtime"));
  await assert.rejects(
    resolveArtifactRuntime({
      cwd: path.join(root, "workspace"),
      home: path.join(root, "home"),
      env: {
        SLIDEWRIGHT_ARTIFACT_TOOL_PATH: path.join(root, "missing-explicit-package"),
        SLIDEWRIGHT_CODEX_RUNTIME_ROOT: runtime.root,
      },
    }),
    (error) => error.code === RUNTIME_OVERRIDE_INVALID_CODE && /downloaded nothing/.test(error.message),
  );
  const workspace = path.join(root, "valid-workspace");
  await createArtifactPackage(path.join(workspace, "node_modules", "@oai", "artifact-tool"));
  await assert.rejects(
    resolveArtifactRuntime({
      cwd: workspace,
      home: path.join(root, "home"),
      env: { SLIDEWRIGHT_ARTIFACT_TOOL_PATH: path.join(root, "still-missing") },
    }),
    (error) => error.code === RUNTIME_OVERRIDE_INVALID_CODE,
  );
});

test("C03 corrupt explicit and bundled runtimes fail through stable actionable codes before workspace mutation", async (t) => {
  const root = await temporaryRoot(t);
  const explicit = await createRuntimeRoot(path.join(root, "explicit-runtime"));
  await fs.writeFile(path.join(explicit.packageDir, "dist", "artifact_tool.mjs"), "export class Presentation {}\n", "utf8");
  const explicitWorkspace = path.join(root, "explicit-workspace");
  await assert.rejects(
    bootstrapArtifactWorkspace({ cwd: explicitWorkspace, env: { SLIDEWRIGHT_CODEX_RUNTIME_ROOT: explicit.root } }),
    (error) => error.code === RUNTIME_OVERRIDE_INVALID_CODE && error.message.split("\n").length === 5 && /Recovery:/.test(error.message) && /downloaded nothing/.test(error.message),
  );
  await assert.rejects(fs.access(explicitWorkspace));

  const home = path.join(root, "bundled-home");
  const bundled = await createRuntimeRoot(path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime"));
  await fs.writeFile(path.join(bundled.packageDir, "dist", "artifact_tool.mjs"), "export class Presentation {}\n", "utf8");
  const bundledWorkspace = path.join(root, "bundled-workspace");
  await assert.rejects(
    bootstrapArtifactWorkspace({ cwd: bundledWorkspace, home, env: {} }),
    (error) => error.code === RUNTIME_UNAVAILABLE_CODE && error.message.split("\n").length === 4 && /Recovery:/.test(error.message) && /downloaded nothing/.test(error.message),
  );
  await assert.rejects(fs.access(bundledWorkspace));
});

test("C03 preflight rejects a lookalike workspace package even when a separate runtime is valid", async (t) => {
  const root = await temporaryRoot(t);
  const runtime = await createRuntimeRoot(path.join(root, "valid-runtime"));
  const workspacePackage = await createArtifactPackage(path.join(root, "workspace", "node_modules", "@oai", "artifact-tool"), "999.0.0");
  const packageJson = JSON.parse(await fs.readFile(path.join(workspacePackage, "package.json"), "utf8"));
  packageJson.name = "lookalike-artifact-tool";
  await fs.writeFile(path.join(workspacePackage, "package.json"), JSON.stringify(packageJson), "utf8");
  const report = await collectPreflight({
    cwd: path.join(root, "workspace"),
    env: { ...process.env, SLIDEWRIGHT_CODEX_RUNTIME_ROOT: runtime.root },
    platform: process.platform,
  });
  assert.equal(report.checks.find((check) => check.id === "artifact-tool").ok, false);
  assert.equal(report.checks.find((check) => check.id === "presentation-renderer").ok, true);
  assert.equal(report.valid, false);
});

test("C03 preflight rejects a syntactically broken renderer entrypoint", async (t) => {
  const root = await temporaryRoot(t);
  const workspacePackage = await createArtifactPackage(path.join(root, "workspace", "node_modules", "@oai", "artifact-tool"));
  await fs.writeFile(path.join(workspacePackage, "dist", "artifact_tool.mjs"), "export this is not valid JavaScript", "utf8");
  const emptyHome = path.join(root, "empty-home");
  const report = await collectPreflight({
    cwd: path.join(root, "workspace"),
    env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome, CODEX_HOME: path.join(emptyHome, ".codex") },
    platform: process.platform,
  });
  assert.equal(report.checks.find((check) => check.id === "artifact-tool").ok, false);
  assert.equal(report.checks.find((check) => check.id === "presentation-renderer").ok, false);
  assert.equal(report.checks.find((check) => check.id === "presentation-renderer").detail.code, RUNTIME_UNAVAILABLE_CODE);
  assert.match(report.checks.find((check) => check.id === "presentation-renderer").detail.message, /Recovery:/);
});

test("C03 clean-host failure is one stable actionable local-only error", async (t) => {
  const root = await temporaryRoot(t);
  const workspace = path.join(root, "workspace-that-does-not-exist");
  await assert.rejects(
    bootstrapArtifactWorkspace({
      cwd: workspace,
      home: path.join(root, "empty-home"),
      env: {},
      platform: "linux",
      release: "6.8.0-microsoft-standard-WSL2",
    }),
    (error) => {
      assert.equal(error.code, RUNTIME_UNAVAILABLE_CODE);
      assert.equal(error.message.split("\n").length, 4);
      assert.match(error.message, /for wsl/);
      assert.match(error.message, /Recovery:/);
      assert.match(error.message, /made no network request, downloaded nothing, and did not switch renderers/);
      assert.ok(Array.isArray(error.attempts));
      return true;
    },
  );
  await assert.rejects(fs.access(workspace));
});

test("C03 refuses a node_modules symlink escape without changing the external directory", async (t) => {
  const root = await temporaryRoot(t);
  const runtime = await createRuntimeRoot(path.join(root, "runtime"));
  const workspace = path.join(root, "workspace");
  const external = path.join(root, "external-node-modules");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(path.join(external, "sentinel.txt"), "preserve", "utf8");
  await fs.symlink(external, path.join(workspace, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    bootstrapArtifactWorkspace({ cwd: workspace, env: { SLIDEWRIGHT_CODEX_RUNTIME_ROOT: runtime.root } }),
    /resolves outside/,
  );
  assert.deepEqual((await fs.readdir(external)).sort(), ["sentinel.txt"]);
});

test("C03 rolls back links and preserves an existing workspace after smoke-import failure", async (t) => {
  const root = await temporaryRoot(t);
  const runtime = await createRuntimeRoot(path.join(root, "runtime"));
  await fs.writeFile(path.join(runtime.packageDir, "dist", "artifact_tool.mjs"), "export class Presentation {}\n", "utf8");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "node_modules", "@oai"), { recursive: true });
  await fs.writeFile(path.join(workspace, "keep.txt"), "keep", "utf8");
  await assert.rejects(
    bootstrapArtifactWorkspace({ cwd: workspace, env: { SLIDEWRIGHT_CODEX_RUNTIME_ROOT: runtime.root } }),
    /does not export Presentation and PresentationFile/,
  );
  assert.deepEqual((await fs.readdir(workspace)).sort(), ["keep.txt", "node_modules"]);
  assert.deepEqual(await fs.readdir(path.join(workspace, "node_modules")), ["@oai"]);
  assert.deepEqual(await fs.readdir(path.join(workspace, "node_modules", "@oai")), []);
});

test("C03 rollback never recursively deletes files created during runtime resolution", async (t) => {
  const root = await temporaryRoot(t);
  const runtime = await createRuntimeRoot(path.join(root, "runtime"));
  const workspace = path.join(root, "new-workspace");
  const sentinel = path.join(workspace, "concurrent-owner.txt");
  const packageJsonPath = path.join(runtime.packageDir, "package.json");
  await fs.writeFile(path.join(runtime.packageDir, "dist", "artifact_tool.mjs"), [
    "import fs from 'node:fs';",
    `fs.mkdirSync(${JSON.stringify(workspace)}, { recursive: true });`,
    `fs.writeFileSync(${JSON.stringify(sentinel)}, 'preserve');`,
    `fs.writeFileSync(${JSON.stringify(packageJsonPath)}, JSON.stringify({ name: '@oai/artifact-tool', version: '2.8.24', type: 'module', exports: { '.': './dist/missing.mjs' } }));`,
    "export class Presentation {}",
    "export class PresentationFile {}",
    "",
  ].join("\n"), "utf8");
  await assert.rejects(
    bootstrapArtifactWorkspace({ cwd: workspace, env: { SLIDEWRIGHT_CODEX_RUNTIME_ROOT: runtime.root } }),
    (error) => error.code === RUNTIME_OVERRIDE_INVALID_CODE && /Recovery:/.test(error.message) && /downloaded nothing/.test(error.message),
  );
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  assert.deepEqual((await fs.readdir(workspace)).sort(), ["concurrent-owner.txt"]);
});

test("C03 scorecard verifier rejects host, runtime, control, source, and command-log drift", () => {
  const valid = validScorecard();
  assert.equal(validateRuntimeScorecard(valid.scorecard, contract, valid.commandLog).valid, true);
  const mutations = [
    (value) => { value.host.platform = "win32"; },
    (value) => { value.fixture.artifactToolVersion = "2.7.2"; },
    (value) => { value.failure.codeOccurrences = 2; },
    (value) => { value.failure.recoveryPresent = false; },
    (value) => { value.invalidOverride.fellThrough = true; },
    (value) => { value.sourceAudit.files[0].sha256 = "c".repeat(64); },
    (value) => { value.commandLog.sha256 = "not-a-hash"; },
    (value) => { value.controls.pop(); },
  ];
  for (const mutate of mutations) {
    const candidate = validScorecard();
    mutate(candidate.scorecard);
    assert.equal(validateRuntimeScorecard(candidate.scorecard, contract, candidate.commandLog).valid, false);
  }
  const commandMutation = validScorecard();
  commandMutation.commandLog.commands[1].stderr = "four\nmeaningless\nlines\nhere\n";
  assert.equal(validateRuntimeScorecard(commandMutation.scorecard, contract, commandMutation.commandLog).valid, false);

  const resolvedMutations = [
    (value) => { value.scorecard.hostOutcome.artifactToolVersion = "2.7.2"; },
    (value) => { value.scorecard.hostOutcome.artifactToolVersion = "2.8.25-01"; },
    (value) => { value.scorecard.hostOutcome.source = "workspace"; },
    (value) => { value.commandLog.commands[3].stdout = value.commandLog.commands[3].stdout.replace(/,"resolvedEntrypoint":"[^"]+"/, ""); value.commandLog.commands[3].stdoutSha256 = sha256Bytes(value.commandLog.commands[3].stdout); },
    (value) => { value.commandLog.commands[3].workspace.existsAfter = false; },
    (value) => { value.commandLog.trees.actual.files[0].size += 1; },
  ];
  for (const mutate of resolvedMutations) {
    const candidate = validResolvedScorecard();
    assert.equal(validateRuntimeScorecard(candidate.scorecard, contract, candidate.commandLog).valid, true);
    mutate(candidate);
    assert.equal(validateRuntimeScorecard(candidate.scorecard, contract, candidate.commandLog).valid, false);
  }

  const release = validScorecard("wsl");
  release.scorecard.git = {
    commit: "b".repeat(40),
    evidenceKind: "github-release",
    evidenceUrl: "https://github.com/example/slidewright/releases/download/c03-proof/runtime-bootstrap-scorecard.json",
    commandLogUrl: "https://github.com/example/slidewright/releases/download/c03-proof/runtime-bootstrap-command-log.json",
    runUrl: null,
  };
  assert.equal(validateRuntimeScorecard(release.scorecard, contract, release.commandLog).valid, true);
  release.scorecard.git.commandLogUrl = release.scorecard.git.commandLogUrl.replace("c03-proof", "forged-tag");
  assert.equal(validateRuntimeScorecard(release.scorecard, contract, release.commandLog).valid, false);
});

test("C03 native aggregate requires exactly three profiles and public GitHub provenance while WSL remains pending", () => {
  const runUrl = "https://github.com/example/slidewright/actions/runs/123";
  const core = {
    schemaVersion: RUNTIME_AGGREGATE_SCHEMA,
    scope: "native",
    complete: false,
    creditEligible: false,
    pendingProfiles: ["wsl"],
    git: { commit: "b".repeat(40), runUrl },
    provenance: { nativeRunUrl: runUrl, wslReleaseUrl: null, wslCommandLogUrl: null, wslPublicFetch: null },
    contractSha256: hash,
    implementationSha256: hash,
    profiles: contract.nativeCiProfiles.map((profile) => ({ profile, scorecardSha256: hash, commandLogSha256: hash })),
  };
  const aggregate = {
    ...core,
    aggregateSha256: sha256Bytes(stableJson(core)),
    valid: true,
  };
  assert.equal(validateRuntimeAggregate(aggregate, contract).valid, true);
  aggregate.profiles.pop();
  assert.equal(validateRuntimeAggregate(aggregate, contract).valid, false);
  const forged = { ...aggregate, profiles: core.profiles, aggregateSha256: hash };
  assert.equal(validateRuntimeAggregate(forged, contract).valid, false);
});

test("C03 public WSL evidence fetch requires matching GitHub release assets and exact bytes", async () => {
  const scorecardUrl = "https://github.com/example/slidewright/releases/download/c03-proof/runtime-bootstrap-scorecard.json";
  const commandLogUrl = "https://github.com/example/slidewright/releases/download/c03-proof/runtime-bootstrap-command-log.json";
  const scorecardBytes = Buffer.from("scorecard\n");
  const commandLogBytes = Buffer.from("command-log\n");
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => (url === scorecardUrl ? scorecardBytes : commandLogBytes),
  });
  const receipt = await fetchAndVerifyRuntimeReleaseAssets({ scorecardUrl, commandLogUrl, expectedScorecardBytes: scorecardBytes, expectedCommandLogBytes: commandLogBytes, fetchImpl });
  assert.equal(receipt.byteMatched, true);
  assert.equal(receipt.scorecardSha256, sha256Bytes(scorecardBytes));
  await assert.rejects(
    fetchAndVerifyRuntimeReleaseAssets({ scorecardUrl, commandLogUrl, expectedScorecardBytes: Buffer.from("forged"), expectedCommandLogBytes: commandLogBytes, fetchImpl }),
    /scorecard bytes do not match/,
  );
  await assert.rejects(
    fetchAndVerifyRuntimeReleaseAssets({ scorecardUrl, commandLogUrl: commandLogUrl.replace("c03-proof", "other-tag"), expectedScorecardBytes: scorecardBytes, expectedCommandLogBytes: commandLogBytes, fetchImpl }),
    /matching public GitHub/,
  );
});

test("C03 complete aggregate binds the public WSL fetch receipt to the same repository and profile hashes", () => {
  const runUrl = "https://github.com/example/slidewright/actions/runs/123";
  const scorecardUrl = "https://github.com/example/slidewright/releases/download/c03-proof/runtime-bootstrap-scorecard.json";
  const commandLogUrl = "https://github.com/example/slidewright/releases/download/c03-proof/runtime-bootstrap-command-log.json";
  const core = {
    schemaVersion: RUNTIME_AGGREGATE_SCHEMA,
    scope: "complete",
    complete: true,
    creditEligible: true,
    pendingProfiles: [],
    git: { commit: "b".repeat(40), runUrl },
    provenance: {
      nativeRunUrl: runUrl,
      wslReleaseUrl: scorecardUrl,
      wslCommandLogUrl: commandLogUrl,
      wslPublicFetch: { scorecardUrl, scorecardSha256: hash, scorecardBytes: 100, commandLogUrl, commandLogSha256: hash, commandLogBytes: 200, byteMatched: true },
    },
    contractSha256: hash,
    implementationSha256: hash,
    profiles: contract.requiredProfiles.map((profile) => ({ profile, scorecardSha256: hash, commandLogSha256: hash })),
  };
  const valid = { ...core, aggregateSha256: sha256Bytes(stableJson(core)), valid: true };
  assert.equal(validateRuntimeAggregate(valid, contract).valid, true);
  for (const mutate of [
    (value) => { value.provenance.wslPublicFetch.byteMatched = false; },
    (value) => { value.provenance.wslPublicFetch.commandLogSha256 = "c".repeat(64); },
    (value) => { value.provenance.wslCommandLogUrl = value.provenance.wslCommandLogUrl.replace("example/slidewright", "other/repo"); },
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    const { aggregateSha256, valid: ignored, ...candidateCore } = candidate;
    candidate.aggregateSha256 = sha256Bytes(stableJson(candidateCore));
    assert.equal(validateRuntimeAggregate(candidate, contract).valid, false);
  }
});

test("C03 evidence writers refuse repository roots and paths outside outputs", async (t) => {
  const root = await temporaryRoot(t);
  assert.equal(assertOwnedOutput(root, path.join(root, "outputs", "runtime")), path.resolve(root, "outputs", "runtime"));
  assert.throws(() => assertOwnedOutput(root, root), /Refusing output outside/);
  assert.throws(() => assertOwnedOutput(root, path.join(root, "elsewhere")), /Refusing output outside/);
});
