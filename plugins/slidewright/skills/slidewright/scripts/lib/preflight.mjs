import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolveArtifactRuntime } from "./artifact-runtime.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function fileSha256(candidate) {
  return createHash("sha256").update(await fs.readFile(candidate)).digest("hex");
}

async function readVersion(manifestPath) {
  try { return JSON.parse(await fs.readFile(manifestPath, "utf8")).version ?? null; } catch { return null; }
}

async function cachedPluginPackages(env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cacheRoot = path.join(codexHome, "plugins", "cache", "slidewright", "slidewright");
  let entries = [];
  try { entries = await fs.readdir(cacheRoot, { withFileTypes: true }); } catch { return []; }
  const packages = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const pluginRoot = path.join(cacheRoot, entry.name);
    const skillPath = path.join(pluginRoot, "skills", "slidewright", "SKILL.md");
    const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
    if (!await exists(skillPath) || !await exists(manifestPath)) continue;
    packages.push({
      pluginRoot,
      skillPath,
      manifestPath,
      version: await readVersion(manifestPath),
      skillSha256: await fileSha256(skillPath),
    });
  }
  return packages.sort((left, right) => (left.version ?? "").localeCompare(right.version ?? ""));
}

export function evaluateCachedPluginIdentity(cachedPackages, repositoryVersion, repositorySkillSha256) {
  const matching = cachedPackages.filter((item) => item.version === repositoryVersion && item.skillSha256 === repositorySkillSha256);
  const sameVersionCollisions = cachedPackages.filter((item) => item.version === repositoryVersion && item.skillSha256 !== repositorySkillSha256);
  return {
    matchingCachedPackages: matching,
    staleCachedPackages: matching.length ? [] : cachedPackages,
    installedCacheMismatch: cachedPackages.length > 0 && matching.length === 0,
    versionCollision: sameVersionCollisions.length > 0,
    sameVersionCollisions,
  };
}

async function pluginIdentity(cwd, env) {
  const skillPath = path.resolve(moduleDir, "..", "..", "SKILL.md");
  const pluginRoot = path.resolve(path.dirname(skillPath), "..", "..");
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const repositorySkillPath = path.join(cwd, "plugins", "slidewright", "skills", "slidewright", "SKILL.md");
  const repositoryManifestPath = path.join(cwd, "plugins", "slidewright", ".codex-plugin", "plugin.json");
  const repositoryPresent = await exists(repositorySkillPath);
  const loadedSkillSha256 = await fileSha256(skillPath);
  const repositorySkillSha256 = repositoryPresent ? await fileSha256(repositorySkillPath) : null;
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  const commit = !git.error && git.status === 0 ? git.stdout.trim() : null;
  const gitStatus = spawnSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8", windowsHide: true });
  const worktreeDirty = !gitStatus.error && gitStatus.status === 0 ? Boolean(gitStatus.stdout.trim()) : null;
  const loadedVersion = await readVersion(manifestPath);
  const repositoryVersion = repositoryPresent ? await readVersion(repositoryManifestPath) : null;
  const loadedMismatch = repositoryPresent && loadedSkillSha256 !== repositorySkillSha256;
  const cachedPackages = await cachedPluginPackages(env);
  const cacheEvaluation = repositoryPresent
    ? evaluateCachedPluginIdentity(cachedPackages, repositoryVersion, repositorySkillSha256)
    : { matchingCachedPackages: [], staleCachedPackages: [], installedCacheMismatch: false, versionCollision: false, sameVersionCollisions: [] };
  const { matchingCachedPackages, staleCachedPackages, installedCacheMismatch, sameVersionCollisions } = cacheEvaluation;
  const cacheMismatch = loadedMismatch || installedCacheMismatch || cacheEvaluation.versionCollision;
  const versionCollision = (loadedMismatch && loadedVersion === repositoryVersion) || cacheEvaluation.versionCollision;
  const loadedWarning = loadedMismatch
    ? `Loaded Slidewright ${loadedVersion ?? "unknown"} at ${skillPath} differs from repository ${repositoryVersion ?? "unknown"} at ${repositorySkillPath}${versionCollision ? " while both claim the same version" : ""}.`
    : null;
  const installedWarning = installedCacheMismatch
    ? `Installed Slidewright cache ${staleCachedPackages.map((item) => `${item.version ?? "unknown"} at ${item.pluginRoot}`).join(", ")} has no package matching repository ${repositoryVersion ?? "unknown"}; reinstall the plugin and restart the client.`
    : sameVersionCollisions.length
      ? `Installed Slidewright cache contains a same-version hash collision for ${repositoryVersion}: ${sameVersionCollisions.map((item) => item.pluginRoot).join(", ")}.`
    : null;
  return {
    loaded: { skillPath, pluginRoot, manifestPath, version: loadedVersion, skillSha256: loadedSkillSha256 },
    repository: repositoryPresent ? { root: cwd, skillPath: repositorySkillPath, manifestPath: repositoryManifestPath, version: repositoryVersion, skillSha256: repositorySkillSha256, commit, worktreeDirty } : null,
    cachedPackages,
    matchingCachedPackages,
    staleCachedPackages,
    sameVersionCollisions,
    loadedMismatch,
    installedCacheMismatch,
    cacheMismatch,
    versionCollision,
    buildIdentifier: commit ? `${commit}${worktreeDirty ? "+dirty" : ""}:${repositorySkillSha256?.slice(0, 12) ?? loadedSkillSha256.slice(0, 12)}` : `${loadedVersion ?? "unknown"}:${loadedSkillSha256.slice(0, 12)}`,
    warning: [loadedWarning, installedWarning].filter(Boolean).join(" ") || null,
  };
}

function commandProbe(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return {
    available: !result.error && result.status === 0,
    detail: (result.stdout || result.stderr || result.error?.message || "").trim().split(/\r?\n/)[0] || null,
  };
}

async function fontProbe(platform) {
  if (platform === "win32") {
    const fonts = {
      Arial: ["arial.ttf", "ARIAL.TTF"],
      Georgia: ["georgia.ttf", "GEORGIA.TTF"],
    };
    const root = path.join(process.env.SystemRoot || "C:\\Windows", "Fonts");
    const results = {};
    for (const [name, files] of Object.entries(fonts)) {
      results[name] = false;
      for (const file of files) {
        if (await exists(path.join(root, file))) {
          results[name] = true;
          break;
        }
      }
    }
    return results;
  }
  const results = {};
  for (const name of ["Arial", "Georgia"]) {
    const probe = spawnSync("fc-match", [name], { encoding: "utf8" });
    results[name] = !probe.error && probe.status === 0 && Boolean(probe.stdout.trim());
  }
  return results;
}

export function buildPreflightReport(probes) {
  const runtimeDetail = probes.presentationRuntime ? {
    source: probes.presentationRuntime.source,
    hostProfile: probes.presentationRuntime.hostProfile,
    version: probes.presentationRuntime.artifactTool?.version ?? probes.presentationRuntime.setup?.version ?? null,
    package: probes.presentationRuntime.artifactTool?.packageDir ?? null,
    setupScript: probes.presentationRuntime.setup?.script ?? null,
    downloaded: false,
    rendererSwitched: false,
  } : probes.runtimeFailure ?? null;
  const checks = [
    { id: "skill", required: true, ok: probes.skill, detail: probes.skillPath, remediation: "Install the Slidewright plugin or run from its repository root." },
    { id: "node", required: true, ok: Number.parseInt(probes.nodeVersion.split(".")[0], 10) >= 20, detail: `Node ${probes.nodeVersion}`, remediation: "Install Node.js 20 or newer." },
    { id: "python", required: true, ok: probes.python.available, detail: probes.python.detail, remediation: "Install Python 3.11+ or set SLIDEWRIGHT_PYTHON to a working executable." },
    { id: "artifact-tool", required: true, ok: Boolean(probes.artifactTool), detail: probes.artifactTool, remediation: probes.presentationRuntime ? "Run 'node <slidewright-skill>/scripts/slidewright.mjs bootstrap' in the target workspace, then rerun preflight." : "Install or repair Codex's bundled Presentations runtime, or set SLIDEWRIGHT_CODEX_RUNTIME_ROOT / SLIDEWRIGHT_ARTIFACT_TOOL_PATH to an existing local runtime." },
    { id: "presentation-renderer", required: true, ok: Boolean(probes.presentationRuntime), detail: runtimeDetail, remediation: "Install or repair Codex's bundled Presentations runtime; Slidewright will not download or silently switch renderers." },
    { id: "fonts", required: true, ok: Object.values(probes.fonts).every(Boolean), detail: probes.fonts, remediation: `Install the missing required fonts: ${Object.entries(probes.fonts).filter(([, ok]) => !ok).map(([name]) => name).join(", ") || "none"}.` },
    { id: "plugin-identity", required: false, ok: probes.pluginIdentity?.cacheMismatch !== true, detail: probes.pluginIdentity ?? null, remediation: "Update or reinstall Slidewright, restart the Codex client, and rerun preflight so the loaded path, version, build identifier, and skill hash match the repository under test." },
    { id: "powerpoint", required: false, ok: probes.powerPoint.available, detail: probes.powerPoint.detail, remediation: "Optional: install Microsoft PowerPoint for application-level round-trip tests." },
    { id: "libreoffice", required: false, ok: probes.libreOffice.available, detail: probes.libreOffice.detail, remediation: "Optional: install LibreOffice only if you explicitly choose its renderer." },
  ];
  return {
    valid: checks.filter((check) => check.required).every((check) => check.ok),
    generatedAt: new Date().toISOString(),
    buildEnvironment: {
      platform: probes.platform ?? process.platform,
      architecture: probes.architecture ?? process.arch,
      selectedRenderer: probes.presentationRuntime ? "codex-presentation-runtime" : null,
      hostProfile: probes.presentationRuntime?.hostProfile ?? probes.hostProfile ?? null,
      rendererSource: probes.presentationRuntime?.source ?? null,
      rendererVersion: probes.presentationRuntime?.artifactTool?.version ?? probes.presentationRuntime?.setup?.version ?? null,
      artifactToolVersion: probes.artifactTool?.version ?? null,
      runtimeDownloaded: false,
      rendererSwitched: false,
      requiredFonts: Object.keys(probes.fonts),
    },
    pluginIdentity: probes.pluginIdentity ?? null,
    warnings: probes.pluginIdentity?.warning ? [probes.pluginIdentity.warning] : [],
    checks,
  };
}

export async function collectPreflight({ cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const skillPath = path.resolve(moduleDir, "..", "..", "SKILL.md");
  const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", platform === "win32" ? "python.exe" : "bin/python");
  const pythonCommand = env.SLIDEWRIGHT_PYTHON || (await exists(bundledPython) ? bundledPython : "python");
  const commonPowerPoint = platform === "win32" ? "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE" : "";
  let presentationRuntime = null;
  let runtimeFailure = null;
  let artifactTool = null;
  try {
    presentationRuntime = await resolveArtifactRuntime({ cwd, env, platform });
    if (presentationRuntime.source === "workspace") {
      artifactTool = { path: presentationRuntime.artifactTool.packagePath, version: presentationRuntime.artifactTool.version };
    }
  } catch (error) {
    presentationRuntime = null;
    runtimeFailure = { code: error.code ?? "SW_RUNTIME_PROBE_FAILED", message: error.message };
  }
  return buildPreflightReport({
    skill: await exists(skillPath),
    skillPath,
    nodeVersion: process.versions.node,
    python: commandProbe(pythonCommand),
    artifactTool,
    presentationRuntime,
    runtimeFailure,
    fonts: await fontProbe(platform),
    powerPoint: platform === "win32" && await exists(commonPowerPoint) ? { available: true, detail: commonPowerPoint } : { available: false, detail: null },
    libreOffice: commandProbe(platform === "win32" ? "soffice.exe" : "soffice"),
    platform,
    architecture: process.arch,
    hostProfile: presentationRuntime?.hostProfile ?? null,
    pluginIdentity: await pluginIdentity(cwd, env),
  });
}
