import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeAppServerClients, CodexAppServerClient } from "../scripts/lib/codex-app-server-client.mjs";
import {
  INSTALL_IMPLEMENTATION_FILES,
  aggregateInstallationScorecards,
  assertDeclaredCheckoutSha,
  assertInstallReleaseVersions,
  assertPluginInterfaceContract,
  assertInstallScorecard,
  finalizeInstallScorecard,
  findAppServerPlugin,
  findCliPlugin,
  findSkill,
  hashPortableImplementationFile,
  isPathInside,
} from "../scripts/lib/install-evidence.mjs";
import { sha256, stable } from "../scripts/public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(fs.readFileSync(path.join(root, "evidence", "install-contract.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const pluginManifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", contract.pluginName, ".codex-plugin", "plugin.json"), "utf8"));
const testGitSha = "a".repeat(40);

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitUntil(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function commandReceipts(scorecard) {
  return contract.requiredCommands.map((requirement) => {
    const template = requirement.argv ?? requirement.argvBySourceKind[scorecard.marketplace.sourceKind];
    const argv = template.map((value) => value === "<PUBLIC_REPOSITORY>"
      ? contract.publicRepository
      : value === "<GIT_SHA>" ? scorecard.environment.gitSha : value);
    return {
      id: requirement.id,
      argv,
      exitCode: requirement.exitCode,
      stdoutHash: requirement.exitCode === 0 ? sha256("") : sha256("failure"),
      stderrHash: sha256(""),
    };
  });
}

function validScorecard() {
  const implementationFiles = INSTALL_IMPLEMENTATION_FILES.map((relative) => ({ relative, sha256: "a".repeat(64) }));
  const implementationHash = sha256(stable(implementationFiles));
  const scorecard = {
    schemaVersion: "slidewright-installation-scorecard/v1",
    valid: true,
    codex: { package: contract.codexPackage, version: contract.codexVersion },
    binding: { contractHash: sha256(stable(contract)), implementationHash, implementationFiles },
    environment: { osPlatform: "win32", architecture: "x64", gitSha: testGitSha, githubRunId: null, repository: null, runUrl: null },
    isolation: { freshCodexHome: true, inheritedConfig: false, inheritedPlugins: false, workspacesOutsideRepository: true },
    marketplace: { sourceKind: "local", source: "<LOCAL_CHECKOUT>", ref: null, added: true, listed: true, discoverableBeforeInstall: true, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" } },
    cli: { installed: true, enabled: true, version: contract.pluginVersion, installPathInsideCodexHome: true },
    desktop: { pluginListed: true, installed: true, enabled: true, skillListed: true, skillEnabled: true, qualifiedSkillName: contract.qualifiedSkillName, category: "Productivity", loadErrors: 0, discoveredOutsideRepository: true },
    ide: { pluginListed: true, installed: true, enabled: true, skillListed: true, skillEnabled: true, qualifiedSkillName: contract.qualifiedSkillName, category: "Productivity", loadErrors: 0, skillsListErrors: 0, discoveredOutsideRepository: true },
    package: {
      fileCount: contract.minimumPluginFiles,
      sourceTreeHash: "b".repeat(64),
      installedTreeHash: "b".repeat(64),
      requiredFiles: contract.requiredPluginFiles.map((relative) => ({ relative, present: true })),
    },
    controls: contract.requiredControlIds.map((id) => ({ id, passed: true })),
  };
  scorecard.commands = commandReceipts(scorecard);
  return finalizeInstallScorecard(scorecard);
}

test("C02 parsers find the exact plugin and skill across CLI, desktop, and IDE payloads", () => {
  assert.equal(findCliPlugin({ installed: [{ pluginId: contract.pluginId }] }, contract.pluginId)?.pluginId, contract.pluginId);
  assert.equal(findAppServerPlugin({ marketplaces: [{ name: "slidewright", plugins: [{ id: contract.pluginId }] }] }, contract.pluginId)?.plugin.id, contract.pluginId);
  assert.equal(findSkill({ data: [{ cwd: "/tmp", errors: [], skills: [{ name: contract.skillName }] }] }, contract.skillName)?.skill.name, contract.skillName);
});

test("C02 release version is identical across the contract, package, lockfile, and plugin manifest", () => {
  assert.deepEqual(assertInstallReleaseVersions(contract, { packageJson, packageLock, pluginManifest }), {
    contract: contract.pluginVersion,
    package: contract.pluginVersion,
    packageLockTopLevel: contract.pluginVersion,
    packageLockRoot: contract.pluginVersion,
    plugin: contract.pluginVersion,
  });
  const mutations = [
    ["contract", { contract: { ...contract, pluginVersion: "9.9.9" } }],
    ["package", { packageJson: { ...packageJson, version: "9.9.9" } }],
    ["packageLockTopLevel", { packageLock: { ...packageLock, version: "9.9.9" } }],
    ["packageLockRoot", { packageLock: { ...packageLock, packages: { ...packageLock.packages, "": { ...packageLock.packages[""], version: "9.9.9" } } } }],
    ["plugin", { pluginManifest: { ...pluginManifest, version: "9.9.9" } }],
  ];
  for (const [field, mutation] of mutations) {
    assert.throws(
      () => assertInstallReleaseVersions(
        mutation.contract ?? contract,
        {
          packageJson: mutation.packageJson ?? packageJson,
          packageLock: mutation.packageLock ?? packageLock,
          pluginManifest: mutation.pluginManifest ?? pluginManifest,
        },
      ),
      new RegExp(`Install release version drift:.*${field}=9\\.9\\.9`, "u"),
    );
  }
});

test("C02 plugin starter prompts stay within the actual Codex client limit", () => {
  assert.equal(assertPluginInterfaceContract(pluginManifest).length, 3);
  assert.throws(
    () => assertPluginInterfaceContract({ interface: { defaultPrompt: ["one", "two", "three", "four"] } }),
    /between 1 and 3 prompts/u,
  );
  assert.throws(
    () => assertPluginInterfaceContract({ interface: { defaultPrompt: ["one", " "] } }),
    /non-empty strings of at most 128 characters/u,
  );
  assert.throws(
    () => assertPluginInterfaceContract({ interface: { defaultPrompt: ["x".repeat(129)] } }),
    /at most 128 characters/u,
  );
  assert.throws(
    () => assertPluginInterfaceContract({ interface: { defaultPrompt: ["same", "same"] } }),
    /must be unique/u,
  );
});

test("C02 exact-checkout binding supports GitHub pull-request head commits without trusting the synthetic merge SHA", () => {
  assert.equal(assertDeclaredCheckoutSha(testGitSha, { GITHUB_SHA: testGitSha }), testGitSha);
  assert.equal(assertDeclaredCheckoutSha(testGitSha, { GITHUB_SHA: "b".repeat(40), SLIDEWRIGHT_CHECKOUT_SHA: testGitSha }), testGitSha);
  assert.throws(
    () => assertDeclaredCheckoutSha(testGitSha, { GITHUB_SHA: "b".repeat(40) }),
    /GITHUB_SHA does not match the checked-out exact Git commit/u,
  );
  assert.throws(
    () => assertDeclaredCheckoutSha(testGitSha, { GITHUB_SHA: testGitSha, SLIDEWRIGHT_CHECKOUT_SHA: "b".repeat(40) }),
    /SLIDEWRIGHT_CHECKOUT_SHA does not match the checked-out exact Git commit/u,
  );
});

test("C02 path confinement accepts a true descendant and rejects equality, siblings, and prefix collisions", () => {
  const parent = path.resolve(os.tmpdir(), "slidewright-codex-home");
  assert.equal(isPathInside(parent, path.join(parent, "plugins", "slidewright")), true);
  assert.equal(isPathInside(parent, parent), false);
  assert.equal(isPathInside(parent, path.resolve(parent, "..", "other-home")), false);
  assert.equal(isPathInside(parent, `${parent}-escape`), false);
});

test("C02 implementation binding treats LF and CRLF checkouts identically", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slidewright-portable-hash-"));
  const lf = path.join(directory, "lf.txt");
  const crlf = path.join(directory, "crlf.txt");
  try {
    fs.writeFileSync(lf, "alpha\nbeta\n", "utf8");
    fs.writeFileSync(crlf, "alpha\r\nbeta\r\n", "utf8");
    assert.equal(await hashPortableImplementationFile(lf), await hashPortableImplementationFile(crlf));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("C02 installation scorecard requires real CLI install and both declared app-server backends", () => {
  const scorecard = validScorecard();
  assert.equal(assertInstallScorecard(scorecard, contract), true);
  scorecard.ide.pluginListed = false;
  finalizeInstallScorecard(scorecard);
  assert.throws(() => assertInstallScorecard(scorecard, contract), /IDE app-server discovery failed/);
});

test("C02 installation scorecard rejects copied package drift", () => {
  const scorecard = validScorecard();
  scorecard.package.installedTreeHash = "tampered";
  finalizeInstallScorecard(scorecard);
  assert.throws(() => assertInstallScorecard(scorecard, contract), /installed plugin differs from source/);
});

test("C02 installation scorecard rejects missing file receipts, malformed tree hashes, and fabricated command arguments", () => {
  const mutations = [
    ["missing required-file receipts", (scorecard) => { scorecard.package.requiredFiles = []; }, /required plugin files/],
    ["malformed source tree hash", (scorecard) => { scorecard.package.sourceTreeHash = "not-a-sha256"; scorecard.package.installedTreeHash = "not-a-sha256"; }, /installed plugin differs/],
    ["fabricated command arguments", (scorecard) => { scorecard.commands[0].argv = ["codex", "fake-command"]; }, /command receipt contract/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const scorecard = validScorecard();
    mutate(scorecard);
    finalizeInstallScorecard(scorecard);
    assert.throws(() => assertInstallScorecard(scorecard, contract), expected, label);
  }
});

test("C02 installation scorecard rejects removed destructive controls", () => {
  const scorecard = validScorecard();
  scorecard.controls.pop();
  finalizeInstallScorecard(scorecard);
  assert.throws(() => assertInstallScorecard(scorecard, contract), /negative control contract failed/);
});

test("C02 installation scorecard gates isolation, policy, version, paths, skills, and command receipts", () => {
  const mutations = [
    ["inherited plugins", (scorecard) => { scorecard.isolation.inheritedPlugins = true; }],
    ["marketplace listing", (scorecard) => { scorecard.marketplace.listed = false; }],
    ["marketplace policy", (scorecard) => { scorecard.marketplace.policy.installation = "NOT_AVAILABLE"; }],
    ["plugin version", (scorecard) => { scorecard.cli.version = "0.0.0"; }],
    ["install confinement", (scorecard) => { scorecard.cli.installPathInsideCodexHome = false; }],
    ["desktop skill", (scorecard) => { scorecard.desktop.skillListed = false; }],
    ["IDE skill", (scorecard) => { scorecard.ide.skillListed = false; }],
    ["outside-repo discovery", (scorecard) => { scorecard.ide.discoveredOutsideRepository = false; }],
    ["command sequence", (scorecard) => { scorecard.commands.pop(); }],
  ];
  for (const [label, mutate] of mutations) {
    const scorecard = validScorecard();
    mutate(scorecard);
    finalizeInstallScorecard(scorecard);
    assert.throws(() => assertInstallScorecard(scorecard, contract), undefined, label);
  }
});

test("C02 aggregate requires Linux, Windows, and macOS byte-identical installs", () => {
  const runId = "123456";
  const scorecards = contract.requiredHostPlatforms.map((platform) => {
    const scorecard = validScorecard();
    scorecard.environment = {
      osPlatform: platform,
      architecture: "x64",
      gitSha: testGitSha,
      githubRunId: runId,
      repository: contract.publicRepository,
      runUrl: `https://github.com/${contract.publicRepository}/actions/runs/${runId}`,
    };
    scorecard.marketplace.sourceKind = "git";
    scorecard.marketplace.source = contract.publicRepository;
    scorecard.marketplace.ref = testGitSha;
    scorecard.commands = commandReceipts(scorecard);
    finalizeInstallScorecard(scorecard);
    return scorecard;
  });
  const options = { expectedImplementationHash: scorecards[0].binding.implementationHash, expectedGitSha: testGitSha };
  const aggregate = aggregateInstallationScorecards(scorecards, contract, options);
  assert.deepEqual(aggregate.platforms, ["darwin", "linux", "win32"]);
  assert.equal(aggregate.valid, true);
  assert.throws(() => aggregateInstallationScorecards(scorecards.slice(1), contract, options), /exactly one scorecard/);
  scorecards[0].package.sourceTreeHash = "drift";
  scorecards[0].package.installedTreeHash = "drift";
  finalizeInstallScorecard(scorecards[0]);
  assert.throws(() => aggregateInstallationScorecards(scorecards, contract, options));
});

test("C02 aggregate rejects a shared but non-checkout commit and fabricated GitHub provenance", () => {
  const scorecards = contract.requiredHostPlatforms.map((platform) => {
    const scorecard = validScorecard();
    scorecard.environment = {
      osPlatform: platform,
      architecture: "x64",
      gitSha: testGitSha,
      githubRunId: "123456",
      repository: contract.publicRepository,
      runUrl: `https://github.com/${contract.publicRepository}/actions/runs/123456`,
    };
    scorecard.marketplace = { ...scorecard.marketplace, sourceKind: "git", source: contract.publicRepository, ref: testGitSha };
    scorecard.commands = commandReceipts(scorecard);
    finalizeInstallScorecard(scorecard);
    return scorecard;
  });
  const options = { expectedImplementationHash: scorecards[0].binding.implementationHash, expectedGitSha: "c".repeat(40) };
  assert.throws(() => aggregateInstallationScorecards(scorecards, contract, options), /checked-out exact Git commit/);
  const currentOptions = { ...options, expectedGitSha: testGitSha };
  scorecards[0].environment.runUrl = "https://example.invalid/fabricated";
  finalizeInstallScorecard(scorecards[0]);
  assert.throws(() => aggregateInstallationScorecards(scorecards, contract, currentOptions), /public exact-commit GitHub run/);
});

test("C02 installation and aggregate runners refuse destructive output paths outside the repository outputs directory", () => {
  const unsafe = path.join(os.tmpdir(), "slidewright-installation-unsafe-output");
  const install = spawnSync(process.execPath, ["scripts/run-installation-benchmark.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SLIDEWRIGHT_INSTALL_OUTPUT: unsafe },
  });
  assert.equal(install.status, 1);
  assert.match(install.stderr, /Refusing to reset any path except/);
  const aggregate = spawnSync(process.execPath, ["scripts/aggregate-installation-evidence.mjs", "--input", "outputs/installation-hosts", "--out", unsafe], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(aggregate.status, 1);
  assert.match(aggregate.stderr, /Refusing any output except/);
  const overlap = spawnSync(process.execPath, ["scripts/aggregate-installation-evidence.mjs", "--input", "outputs/installation-hosts", "--out", "outputs/installation-hosts"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(overlap.status, 1);
  assert.match(overlap.stderr, /Refusing overlapping installation input and output paths/);
  const nestedOverlap = spawnSync(process.execPath, ["scripts/aggregate-installation-evidence.mjs", "--input", "outputs/installation-hosts", "--out", "outputs/installation-hosts/aggregate"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(nestedOverlap.status, 1);
  assert.match(nestedOverlap.stderr, /Refusing overlapping installation input and output paths/);
});

test("C02 app-server cleanup terminates a hung launcher and its descendant", { timeout: 15_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slidewright-app-server-cleanup-"));
  const fixture = path.join(directory, "hung-launcher.mjs");
  const pidFile = path.join(directory, "descendant.pid");
  fs.writeFileSync(fixture, [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'fs.writeFileSync(process.env.SLIDEWRIGHT_DESCENDANT_PID_FILE, String(child.pid));',
    'process.stdin.resume();',
    'setInterval(() => {}, 1000);',
  ].join("\n"), "utf8");
  let client;
  let descendantPid;
  try {
    client = new CodexAppServerClient({
      codexEntrypoint: fixture,
      cwd: directory,
      env: { ...process.env, SLIDEWRIGHT_DESCENDANT_PID_FILE: pidFile },
      clientName: "cleanup-test",
      gracefulShutdownMs: 100,
      forceShutdownMs: 2_000,
    });
    assert.equal(await waitUntil(() => fs.existsSync(pidFile)), true, "hung launcher did not publish its descendant PID");
    descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.equal(processExists(client.pid), true);
    assert.equal(processExists(descendantPid), true);
    await client.close();
    assert.equal(await waitUntil(() => !processExists(client.pid) && !processExists(descendantPid), 3_000), true, "owned launcher tree survived cleanup");
  } finally {
    if (client?.pid && processExists(client.pid)) {
      if (process.platform === "win32") spawnSync("taskkill.exe", ["/PID", String(client.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else { try { process.kill(-client.pid, "SIGKILL"); } catch {} }
    }
    if (descendantPid && processExists(descendantPid)) { try { process.kill(descendantPid, "SIGKILL"); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("C02 app-server cleanup attempts every client and propagates rejection", async () => {
  const called = [];
  const clients = [
    { close: async () => { called.push("desktop"); throw new Error("desktop cleanup failed"); } },
    { close: async () => { called.push("ide"); } },
  ];
  await assert.rejects(closeAppServerClients(clients), /Failed to clean up 1 Codex app-server client/);
  assert.deepEqual(called.sort(), ["desktop", "ide"]);
});
