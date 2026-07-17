import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { contentHash, stable } from "../public-evidence-lib.mjs";

export const INSTALL_IMPLEMENTATION_FILES = [
  "scripts/run-installation-benchmark.mjs",
  "scripts/aggregate-installation-evidence.mjs",
  "scripts/lib/codex-app-server-client.mjs",
  "scripts/lib/install-evidence.mjs",
  "tests/installation.test.mjs",
  "evidence/install-contract.json",
  ".agents/plugins/marketplace.json",
  ".github/workflows/ci.yml",
  "package.json",
  "tools/installation/package.json",
  "tools/installation/package-lock.json",
];

export async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function listRegularFiles(root, directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Unsupported filesystem entry in plugin package: ${absolute}`);
  }
  return files;
}

export async function hashFile(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export async function hashTree(root) {
  const files = await listRegularFiles(root);
  const entries = [];
  for (const relative of files) {
    entries.push({ relative, sha256: await hashFile(path.join(root, ...relative.split("/"))) });
  }
  return {
    fileCount: entries.length,
    treeHash: crypto.createHash("sha256").update(stable(entries)).digest("hex"),
    entries,
  };
}

export async function computeInstallImplementationBinding(root) {
  const files = [];
  for (const relative of INSTALL_IMPLEMENTATION_FILES) {
    files.push({ relative, sha256: await hashFile(path.join(root, ...relative.split("/"))) });
  }
  return {
    files,
    implementationHash: crypto.createHash("sha256").update(stable(files)).digest("hex"),
  };
}

export function findCliPlugin(payload, pluginId) {
  return [...(payload?.installed ?? []), ...(payload?.available ?? [])].find((plugin) => plugin.pluginId === pluginId) ?? null;
}

export function findAppServerPlugin(payload, pluginId) {
  for (const marketplace of payload?.marketplaces ?? []) {
    const plugin = (marketplace.plugins ?? []).find((candidate) => candidate.id === pluginId);
    if (plugin) return { marketplace, plugin };
  }
  return null;
}

export function findSkill(payload, skillName) {
  for (const entry of payload?.data ?? []) {
    const skill = (entry.skills ?? []).find((candidate) => candidate.name === skillName);
    if (skill) return { entry, skill };
  }
  return null;
}

export function finalizeInstallScorecard(scorecard) {
  const copy = structuredClone(scorecard);
  delete copy.scorecardHash;
  scorecard.scorecardHash = contentHash(copy, "unused");
  return scorecard;
}

const isSha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isGitSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const equal = (left, right) => stable(left) === stable(right);

function expectedCommandArgv(requirement, scorecard, contract) {
  if (requirement.argv) return requirement.argv;
  const template = requirement.argvBySourceKind?.[scorecard.marketplace?.sourceKind];
  if (!template) return null;
  return template.map((value) => {
    if (value === "<PUBLIC_REPOSITORY>") return contract.publicRepository;
    if (value === "<GIT_SHA>") return scorecard.environment?.gitSha;
    return value;
  });
}

export function assertInstallScorecard(scorecard, contract, { expectedImplementationHash = scorecard?.binding?.implementationHash } = {}) {
  const failures = [];
  if (scorecard.schemaVersion !== "slidewright-installation-scorecard/v1") failures.push("unsupported scorecard schema");
  if (scorecard.codex?.package !== contract.codexPackage || scorecard.codex?.version !== contract.codexVersion) failures.push("Codex package/version drift");
  const contractHash = crypto.createHash("sha256").update(stable(contract)).digest("hex");
  if (scorecard.binding?.contractHash !== contractHash || scorecard.binding?.implementationHash !== expectedImplementationHash) failures.push("contract or implementation binding mismatch");
  const implementationFiles = scorecard.binding?.implementationFiles ?? [];
  if (implementationFiles.length !== INSTALL_IMPLEMENTATION_FILES.length || implementationFiles.some((file, index) => file.relative !== INSTALL_IMPLEMENTATION_FILES[index] || !isSha256(file.sha256)) || crypto.createHash("sha256").update(stable(implementationFiles)).digest("hex") !== scorecard.binding?.implementationHash) failures.push("implementation file closure mismatch");
  if (!scorecard.isolation?.freshCodexHome || scorecard.isolation?.inheritedConfig || scorecard.isolation?.inheritedPlugins || !scorecard.isolation?.workspacesOutsideRepository) failures.push("Codex home was not isolated");
  if (!scorecard.marketplace?.added || !scorecard.marketplace?.listed || !scorecard.marketplace?.discoverableBeforeInstall) failures.push("marketplace discovery failed");
  if (scorecard.marketplace?.policy?.installation !== contract.expectedMarketplacePolicy.installation || scorecard.marketplace?.policy?.authentication !== contract.expectedMarketplacePolicy.authentication) failures.push("marketplace policy drift");
  if (!scorecard.cli?.installed || !scorecard.cli?.enabled || scorecard.cli?.version !== contract.pluginVersion || !scorecard.cli?.installPathInsideCodexHome) failures.push("CLI install failed");
  if (!scorecard.desktop?.pluginListed || !scorecard.desktop?.installed || !scorecard.desktop?.enabled || !scorecard.desktop?.skillListed || !scorecard.desktop?.skillEnabled || scorecard.desktop?.qualifiedSkillName !== contract.qualifiedSkillName || scorecard.desktop?.category !== contract.expectedMarketplacePolicy.category || scorecard.desktop?.loadErrors !== 0 || !scorecard.desktop?.discoveredOutsideRepository) failures.push("desktop app-server discovery failed");
  if (!scorecard.ide?.pluginListed || !scorecard.ide?.installed || !scorecard.ide?.enabled || !scorecard.ide?.skillListed || !scorecard.ide?.skillEnabled || scorecard.ide?.qualifiedSkillName !== contract.qualifiedSkillName || scorecard.ide?.category !== contract.expectedMarketplacePolicy.category || scorecard.ide?.loadErrors !== 0 || scorecard.ide?.skillsListErrors !== 0 || !scorecard.ide?.discoveredOutsideRepository) failures.push("IDE app-server discovery failed");
  if (!Number.isInteger(scorecard.package?.fileCount) || scorecard.package.fileCount < contract.minimumPluginFiles) failures.push("installed plugin file count is too small");
  if (!isSha256(scorecard.package?.sourceTreeHash) || !isSha256(scorecard.package?.installedTreeHash) || scorecard.package.sourceTreeHash !== scorecard.package.installedTreeHash) failures.push("installed plugin differs from source");
  const requiredFiles = scorecard.package?.requiredFiles ?? [];
  if (requiredFiles.length !== contract.requiredPluginFiles.length || requiredFiles.some((item, index) => item.relative !== contract.requiredPluginFiles[index] || item.present !== true)) failures.push("required plugin files are missing or reordered");
  const controlIds = (scorecard.controls ?? []).map((control) => control.id);
  if (controlIds.length !== contract.requiredControlIds.length || controlIds.some((id, index) => id !== contract.requiredControlIds[index]) || !(scorecard.controls ?? []).every((control) => control.passed === true)) failures.push("negative control contract failed");
  const emptyHash = crypto.createHash("sha256").update("").digest("hex");
  const commands = scorecard.commands ?? [];
  const requiredCommands = contract.requiredCommands ?? [];
  if (commands.length !== requiredCommands.length || commands.some((command, index) => {
    const requirement = requiredCommands[index];
    const expectedArgv = expectedCommandArgv(requirement, scorecard, contract);
    return command.id !== requirement.id
      || command.exitCode !== requirement.exitCode
      || !expectedArgv
      || !equal(command.argv, expectedArgv)
      || command.argv.some((value) => typeof value !== "string" || /(?:[A-Za-z]:\\|\/Users\/|\/home\/runner\/|slidewright-installation-)/.test(value))
      || !isSha256(command.stdoutHash)
      || !isSha256(command.stderrHash)
      || (requirement.exitCode !== 0 && command.stdoutHash === emptyHash && command.stderrHash === emptyHash);
  })) failures.push("command receipt contract failed");
  const expectedHash = contentHash(Object.fromEntries(Object.entries(scorecard).filter(([key]) => key !== "scorecardHash")), "unused");
  if (scorecard.scorecardHash !== expectedHash) failures.push("scorecard hash mismatch");
  if (scorecard.valid !== (failures.length === 0)) failures.push("valid flag mismatch");
  if (failures.length) throw new Error(`Installation scorecard rejected: ${failures.join("; ")}`);
  return true;
}

export function aggregateInstallationScorecards(scorecards, contract, { expectedImplementationHash, expectedGitSha } = {}) {
  if (!Array.isArray(scorecards) || scorecards.length === 0) throw new Error("No installation scorecards were supplied.");
  if (!isSha256(expectedImplementationHash)) throw new Error("Aggregate requires the current implementation hash.");
  if (!isGitSha(expectedGitSha)) throw new Error("Aggregate requires the checked-out exact Git commit.");
  for (const scorecard of scorecards) assertInstallScorecard(scorecard, contract, { expectedImplementationHash });
  const platforms = [...new Set(scorecards.map((scorecard) => scorecard.environment?.osPlatform))].sort();
  const missingPlatforms = contract.requiredHostPlatforms.filter((platform) => !platforms.includes(platform));
  if (missingPlatforms.length || scorecards.length !== contract.requiredHostPlatforms.length || platforms.length !== contract.requiredHostPlatforms.length) throw new Error(`Installation evidence must contain exactly one scorecard for every host platform; missing: ${missingPlatforms.join(", ") || "none"}.`);
  const gitShas = [...new Set(scorecards.map((scorecard) => scorecard.environment?.gitSha))];
  if (gitShas.length !== 1 || gitShas[0] !== expectedGitSha) throw new Error("Installation evidence does not bind the checked-out exact Git commit.");
  const sourceHashes = [...new Set(scorecards.map((scorecard) => scorecard.package?.sourceTreeHash))];
  const installedHashes = [...new Set(scorecards.map((scorecard) => scorecard.package?.installedTreeHash))];
  if (sourceHashes.length !== 1 || installedHashes.length !== 1 || sourceHashes[0] !== installedHashes[0]) {
    throw new Error("Cross-platform installed plugin trees are not byte-identical.");
  }
  const codexVersions = [...new Set(scorecards.map((scorecard) => scorecard.codex?.version))];
  if (codexVersions.length !== 1 || codexVersions[0] !== contract.codexVersion) throw new Error("Cross-platform Codex version drift.");
  const runIds = [...new Set(scorecards.map((scorecard) => scorecard.environment?.githubRunId))];
  if (runIds.length !== 1 || !/^\d+$/.test(runIds[0] ?? "")) throw new Error("Installation evidence does not bind one GitHub Actions run.");
  if (scorecards.some((scorecard) => scorecard.marketplace?.sourceKind !== "git" || scorecard.marketplace?.source !== contract.publicRepository || scorecard.marketplace?.ref !== expectedGitSha || scorecard.environment?.repository !== contract.publicRepository || scorecard.environment?.runUrl !== `https://github.com/${contract.publicRepository}/actions/runs/${runIds[0]}`)) {
    throw new Error("Installation evidence is not bound to the public exact-commit GitHub run.");
  }
  const aggregate = {
    schemaVersion: "slidewright-installation-aggregate/v1",
    valid: true,
    gitSha: gitShas[0],
    codex: { package: contract.codexPackage, version: contract.codexVersion },
    platforms,
    surfaces: contract.requiredSurfaces,
    pluginTreeHash: sourceHashes[0],
    contractHash: scorecards[0].binding.contractHash,
    implementationHash: expectedImplementationHash,
    hosts: scorecards
      .map((scorecard) => ({
        platform: scorecard.environment.osPlatform,
        architecture: scorecard.environment.architecture,
        scorecardHash: scorecard.scorecardHash,
        githubRunId: scorecard.environment.githubRunId,
      }))
      .sort((left, right) => left.platform.localeCompare(right.platform)),
  };
  aggregate.aggregateHash = contentHash(aggregate, "aggregateHash");
  return aggregate;
}
