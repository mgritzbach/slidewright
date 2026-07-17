import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { closeAppServerClients, CodexAppServerClient } from "./lib/codex-app-server-client.mjs";
import {
  assertInstallScorecard,
  computeInstallImplementationBinding,
  exists,
  finalizeInstallScorecard,
  findAppServerPlugin,
  findCliPlugin,
  findSkill,
  hashTree,
  isPathInside,
  listRegularFiles,
} from "./lib/install-evidence.mjs";
import { sha256, stable } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await fs.readFile(path.join(root, "evidence", "install-contract.json"), "utf8"));
const ownedOutput = path.resolve(root, "outputs", "installation");
const requestedOutput = process.env.SLIDEWRIGHT_INSTALL_OUTPUT ? path.resolve(process.env.SLIDEWRIGHT_INSTALL_OUTPUT) : ownedOutput;
const output = ownedOutput;
const requestedMarketplaceSource = process.env.SLIDEWRIGHT_MARKETPLACE_SOURCE || null;
const marketplaceRef = process.env.SLIDEWRIGHT_MARKETPLACE_REF || null;

if (requestedOutput !== ownedOutput) {
  throw new Error(`Refusing to reset any path except the owned installation output ${ownedOutput}.`);
}

const gitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const checkoutHead = gitResult.status === 0 ? gitResult.stdout.trim() : null;
if (!/^[a-f0-9]{40}$/.test(checkoutHead ?? "")) throw new Error("Could not resolve the checked-out exact Git commit.");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== checkoutHead) throw new Error("GITHUB_SHA does not match the checked-out exact Git commit.");
if (requestedMarketplaceSource && marketplaceRef !== checkoutHead) throw new Error("Remote marketplace installation must use the checked-out exact Git commit as --ref.");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(output, "logs"), { recursive: true });
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-installation-"));
const codexHome = path.join(sandbox, "codex-home");
const probeWorkspace = path.join(sandbox, "cli-workspace");
const desktopWorkspace = path.join(sandbox, "desktop-workspace");
const ideWorkspace = path.join(sandbox, "ide-workspace");
const localMarketplaceRoot = path.join(sandbox, "marketplace-source");
const sourcePackageRoot = path.join(sandbox, "source-package");
await fs.mkdir(codexHome, { recursive: true });
await fs.mkdir(probeWorkspace, { recursive: true });
await fs.mkdir(desktopWorkspace, { recursive: true });
await fs.mkdir(ideWorkspace, { recursive: true });
const packageSourceFilter = (candidate) => {
  const segments = candidate.split(path.sep);
  return !segments.includes("node_modules") && !segments.includes("__pycache__") && !candidate.endsWith(".pyc");
};
await fs.cp(path.join(root, "plugins", contract.pluginName), sourcePackageRoot, {
  recursive: true,
  filter: packageSourceFilter,
});
for (const relative of await listRegularFiles(sourcePackageRoot)) {
  const absolute = path.join(sourcePackageRoot, ...relative.split("/"));
  const bytes = await fs.readFile(absolute);
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { continue; }
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized !== text) await fs.writeFile(absolute, normalized, "utf8");
}
if (!requestedMarketplaceSource) {
  await fs.mkdir(path.join(localMarketplaceRoot, ".agents", "plugins"), { recursive: true });
  await fs.mkdir(path.join(localMarketplaceRoot, "plugins"), { recursive: true });
  await fs.copyFile(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    path.join(localMarketplaceRoot, ".agents", "plugins", "marketplace.json"),
  );
  await fs.cp(sourcePackageRoot, path.join(localMarketplaceRoot, "plugins", contract.pluginName), { recursive: true });
}
const marketplaceSource = requestedMarketplaceSource || localMarketplaceRoot;
const initialCodexEntries = await fs.readdir(codexHome);
const initiallyEmpty = initialCodexEntries.length === 0;
const inheritedConfig = initialCodexEntries.includes("config.toml");
const inheritedPluginState = initialCodexEntries.includes("plugins");
const env = { ...process.env, CODEX_HOME: codexHome, NO_COLOR: "1" };
const commands = [];

function recordCommand(id, displayArgs, result) {
  const stdout = result.stdout || "";
  const stderr = `${result.stderr || ""}${result.error ? `${result.error.stack || result.error.message}\n` : ""}`;
  fsSync.writeFileSync(path.join(output, "logs", `${id}.stdout.log`), stdout, "utf8");
  fsSync.writeFileSync(path.join(output, "logs", `${id}.stderr.log`), stderr, "utf8");
  commands.push({
    id,
    argv: displayArgs,
    exitCode: result.status ?? 1,
    stdoutHash: sha256(stdout),
    stderrHash: sha256(stderr),
  });
}

function run(id, command, args, { expect = 0, parseJson = false, cwd = probeWorkspace, displayArgs = ["codex", ...args] } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true });
  recordCommand(id, displayArgs, result);
  const combined = `${result.stdout || ""}${result.stderr || ""}`;
  if (expect === 0 && (result.error || result.status !== 0)) throw result.error ?? new Error(`${id} failed: ${combined}`);
  if (expect !== 0 && result.status !== expect) throw new Error(`${id} exited ${result.status}; expected ${expect}. ${combined}`);
  if (!parseJson) return { ...result, combined };
  try { return { ...result, combined, json: JSON.parse(result.stdout) }; }
  catch (error) { throw new Error(`${id} did not emit JSON: ${result.stdout}`, { cause: error }); }
}

let desktopClient;
let ideClient;
try {
  const toolRoot = path.join(root, "tools", "installation");
  const codexEntrypoint = path.join(toolRoot, "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!await exists(codexEntrypoint)) throw new Error(`Codex entrypoint missing at ${codexEntrypoint}.`);
  const installedCodexPackage = JSON.parse(await fs.readFile(path.join(toolRoot, "node_modules", "@openai", "codex", "package.json"), "utf8"));
  if (installedCodexPackage.version !== contract.codexVersion) throw new Error(`Installed Codex version ${installedCodexPackage.version} does not match ${contract.codexVersion}.`);
  run("verify-codex", process.execPath, [codexEntrypoint, "--version"], { displayArgs: ["codex", "--version"] });
  const codex = (id, args, options = {}) => run(id, process.execPath, [codexEntrypoint, ...args], { ...options, displayArgs: options.displayArgs ?? ["codex", ...args] });

  const pristine = codex("pristine-list", ["plugin", "list", "--available", "--json"], { parseJson: true });
  const missingBeforeMarketplace = codex("missing-before-marketplace", ["plugin", "add", contract.pluginId, "--json"], { expect: 1 });
  const addArgs = ["plugin", "marketplace", "add", marketplaceSource];
  if (marketplaceRef) addArgs.push("--ref", marketplaceRef);
  addArgs.push("--json");
  const displayAddArgs = ["codex", "plugin", "marketplace", "add", path.isAbsolute(marketplaceSource) ? "<LOCAL_MARKETPLACE>" : marketplaceSource];
  if (marketplaceRef) displayAddArgs.push("--ref", marketplaceRef);
  displayAddArgs.push("--json");
  const added = codex("marketplace-add", addArgs, { parseJson: true, displayArgs: displayAddArgs });
  const markets = codex("marketplace-list", ["plugin", "marketplace", "list", "--json"], { parseJson: true });
  const available = codex("available-list", ["plugin", "list", "--available", "--json"], { parseJson: true });
  const availablePlugin = findCliPlugin(available.json, contract.pluginId);
  const install = codex("plugin-add", ["plugin", "add", contract.pluginId, "--json"], { parseJson: true });
  const installed = codex("installed-list", ["plugin", "list", "--json"], { parseJson: true });
  const installedPlugin = findCliPlugin(installed.json, contract.pluginId);
  const wrongPlugin = codex("wrong-plugin", ["plugin", "add", `slidewright-missing@${contract.marketplaceName}`, "--json"], { expect: 1 });

  desktopClient = new CodexAppServerClient({ codexEntrypoint, cwd: desktopWorkspace, env, clientName: "desktop-app" });
  const desktopInitialize = await desktopClient.initialize();
  const desktopPlugins = await desktopClient.request("plugin/list", { cwds: [desktopWorkspace], marketplaceKinds: ["local"] });
  const desktopPlugin = findAppServerPlugin(desktopPlugins, contract.pluginId);
  const desktopDetail = await desktopClient.request("plugin/read", { pluginName: contract.pluginName, marketplacePath: desktopPlugin?.marketplace.path });
  const desktopSkill = desktopDetail.plugin?.skills?.find((skill) => skill.name === contract.qualifiedSkillName) ?? null;

  ideClient = new CodexAppServerClient({ codexEntrypoint, cwd: ideWorkspace, env, clientName: "codex-vscode" });
  const ideInitialize = await ideClient.initialize();
  const idePlugins = await ideClient.request("plugin/list", { cwds: [ideWorkspace], marketplaceKinds: ["local"] });
  const idePlugin = findAppServerPlugin(idePlugins, contract.pluginId);
  const ideDetail = await ideClient.request("plugin/read", { pluginName: contract.pluginName, marketplacePath: idePlugin?.marketplace.path });
  const ideSkills = await ideClient.request("skills/list", { cwds: [ideWorkspace], forceReload: true });
  const idePluginSkill = ideDetail.plugin?.skills?.find((skill) => skill.name === contract.qualifiedSkillName) ?? null;
  const ideSkill = findSkill(ideSkills, contract.skillName);

  const sourceTree = await hashTree(sourcePackageRoot);
  const installedPath = await fs.realpath(path.resolve(install.json.installedPath));
  const canonicalCodexHome = await fs.realpath(codexHome);
  const installedPathInsideCodexHome = isPathInside(canonicalCodexHome, installedPath);
  const installedTree = await hashTree(installedPath);
  const requiredFiles = contract.requiredPluginFiles.map((relative) => ({
    relative,
    present: installedTree.entries.some((item) => item.relative === relative),
  }));
  const desktopLoadErrors = desktopPlugins.marketplaceLoadErrors?.length ?? 0;
  const ideErrors = ideSkills.data?.reduce((sum, entry) => sum + (entry.errors?.length ?? 0), 0) ?? 0;
  const ideLoadErrors = idePlugins.marketplaceLoadErrors?.length ?? 0;
  const sourceKind = path.isAbsolute(marketplaceSource) ? "local" : "git";
  const implementation = await computeInstallImplementationBinding(root);
  const contractHash = sha256(stable(contract));
  const scorecard = {
    schemaVersion: "slidewright-installation-scorecard/v1",
    valid: true,
    codex: { package: contract.codexPackage, version: contract.codexVersion },
    binding: {
      contractHash,
      implementationHash: implementation.implementationHash,
      implementationFiles: implementation.files,
    },
    environment: {
      platform: process.env.RUNNER_OS || process.platform,
      osPlatform: process.platform,
      architecture: process.arch,
      node: process.version,
      gitSha: checkoutHead,
      githubRunId: process.env.GITHUB_RUN_ID || null,
      repository: process.env.GITHUB_REPOSITORY || null,
      runUrl: process.env.GITHUB_RUN_ID && process.env.GITHUB_REPOSITORY
        ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : null,
    },
    isolation: {
      freshCodexHome: initiallyEmpty,
      inheritedConfig,
      inheritedPlugins: inheritedPluginState || pristine.json.installed?.length > 0 || pristine.json.available?.length > 0,
      workspacesOutsideRepository: [probeWorkspace, desktopWorkspace, ideWorkspace].every((workspace) => !workspace.startsWith(`${root}${path.sep}`)),
    },
    marketplace: {
      sourceKind,
      source: sourceKind === "git" ? marketplaceSource : "<LOCAL_CHECKOUT>",
      ref: marketplaceRef,
      added: added.json.marketplaceName === contract.marketplaceName,
      listed: markets.json.marketplaces?.some((marketplace) => marketplace.name === contract.marketplaceName) ?? false,
      discoverableBeforeInstall: availablePlugin?.installed === false && availablePlugin?.version === contract.pluginVersion,
      policy: {
        installation: availablePlugin?.installPolicy ?? null,
        authentication: availablePlugin?.authPolicy ?? null,
      },
    },
    cli: {
      installed: installedPlugin?.installed === true,
      enabled: installedPlugin?.enabled === true,
      version: installedPlugin?.version ?? null,
      installPathInsideCodexHome: installedPathInsideCodexHome,
    },
    desktop: {
      protocolClient: "desktop-app",
      platformOs: desktopInitialize.platformOs,
      pluginListed: Boolean(desktopPlugin),
      installed: desktopPlugin?.plugin.installed === true,
      enabled: desktopPlugin?.plugin.enabled === true,
      skillListed: Boolean(desktopSkill),
      skillEnabled: desktopSkill?.enabled === true,
      qualifiedSkillName: desktopSkill?.name ?? null,
      category: desktopDetail.plugin?.summary?.interface?.category ?? null,
      loadErrors: desktopLoadErrors,
      discoveredOutsideRepository: !desktopWorkspace.startsWith(`${root}${path.sep}`),
    },
    ide: {
      protocolClient: "codex-vscode",
      platformOs: ideInitialize.platformOs,
      pluginListed: Boolean(idePlugin),
      installed: idePlugin?.plugin.installed === true,
      enabled: idePlugin?.plugin.enabled === true,
      skillListed: Boolean(idePluginSkill),
      skillEnabled: idePluginSkill?.enabled === true,
      qualifiedSkillName: idePluginSkill?.name ?? null,
      category: ideDetail.plugin?.summary?.interface?.category ?? null,
      loadErrors: ideLoadErrors,
      authoringSkillListed: Boolean(ideSkill),
      authoringSkillScope: ideSkill?.skill.scope ?? null,
      skillsListErrors: ideErrors,
      discoveredOutsideRepository: !ideWorkspace.startsWith(`${root}${path.sep}`),
    },
    package: {
      fileCount: installedTree.fileCount,
      sourceTreeHash: sourceTree.treeHash,
      installedTreeHash: installedTree.treeHash,
      requiredFiles,
    },
    controls: [
      { id: "empty-home-has-no-plugins", passed: pristine.json.installed?.length === 0 && pristine.json.available?.length === 0 },
      { id: "install-before-marketplace-rejected", passed: missingBeforeMarketplace.status !== 0 },
      { id: "unknown-plugin-rejected", passed: wrongPlugin.status !== 0 },
      { id: "installed-path-confined-to-codex-home", passed: installedPathInsideCodexHome },
      { id: "marketplace-ui-not-used", passed: true },
    ],
    commands,
  };
  finalizeInstallScorecard(scorecard);
  try { assertInstallScorecard(scorecard, contract, { expectedImplementationHash: implementation.implementationHash }); }
  catch (error) {
    scorecard.valid = false;
    scorecard.diagnostic = error.message;
    finalizeInstallScorecard(scorecard);
    await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
    throw error;
  }
  await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ valid: scorecard.valid, scorecardHash: scorecard.scorecardHash, surfaces: contract.requiredSurfaces, controls: scorecard.controls.length })}\n`);
} finally {
  const cleanupErrors = [];
  try { await closeAppServerClients([desktopClient, ideClient]); }
  catch (error) { cleanupErrors.push(error); }
  try {
    const tempRoot = path.resolve(os.tmpdir());
    if (!path.resolve(sandbox).startsWith(`${tempRoot}${path.sep}slidewright-installation-`)) throw new Error(`Refusing to remove unexpected sandbox ${sandbox}.`);
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Slidewright installation benchmark cleanup failed.");
}
