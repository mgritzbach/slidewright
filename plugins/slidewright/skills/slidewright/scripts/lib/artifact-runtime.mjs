import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const MIN_ARTIFACT_TOOL_VERSION = "2.7.3";
export const RUNTIME_UNAVAILABLE_CODE = "SW_RUNTIME_UNAVAILABLE";
export const RUNTIME_OVERRIDE_INVALID_CODE = "SW_RUNTIME_OVERRIDE_INVALID";

const ARTIFACT_PACKAGE = "@oai/artifact-tool";

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function hostHome(env, explicitHome) {
  return path.resolve(explicitHome || env.HOME || env.USERPROFILE || os.homedir());
}

export function detectHostProfile({ platform = process.platform, release = os.release(), env = process.env } = {}) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(release))) return "wsl";
  if (platform === "linux") return "linux";
  return `unsupported:${platform}`;
}

function parseSemver(value) {
  const match = String(value ?? "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split(".") : null;
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease,
  };
}

function comparePrerelease(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const delta = Number(left[index]) - Number(right[index]);
      if (delta !== 0) return delta;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else {
      const delta = left[index].localeCompare(right[index]);
      if (delta !== 0) return delta;
    }
  }
  return 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    const delta = left.core[index] - right.core[index];
    if (delta !== 0) return delta;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function artifactEntrypoint(packageDir, packageJson) {
  const exported = typeof packageJson.exports === "string"
    ? packageJson.exports
    : typeof packageJson.exports?.["."] === "string"
      ? packageJson.exports["."]
      : null;
  const candidates = [
    exported ? path.resolve(packageDir, exported) : null,
    path.join(packageDir, "dist", "artifact_tool.mjs"),
    path.join(packageDir, "dist", "node", "artifact_tool.mjs"),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    const relative = path.relative(packageDir, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !fsSync.existsSync(candidate)) return false;
    try {
      return fsSync.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

export async function inspectArtifactToolPackage(packageDir, { minimumVersion = MIN_ARTIFACT_TOOL_VERSION } = {}) {
  const resolved = path.resolve(packageDir);
  const packagePath = path.join(resolved, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
  } catch (error) {
    return { valid: false, packageDir: resolved, reason: `missing or invalid package.json: ${error.code ?? error.message}` };
  }
  if (packageJson.name !== ARTIFACT_PACKAGE) {
    return { valid: false, packageDir: resolved, reason: `expected ${ARTIFACT_PACKAGE}; found ${packageJson.name ?? "unnamed package"}` };
  }
  const comparison = compareSemver(packageJson.version, minimumVersion);
  if (comparison === null) {
    return { valid: false, packageDir: resolved, version: packageJson.version ?? null, reason: `invalid semantic version; requires ${ARTIFACT_PACKAGE} >= ${minimumVersion}` };
  }
  if (comparison < 0) {
    return { valid: false, packageDir: resolved, version: packageJson.version ?? null, reason: `requires ${ARTIFACT_PACKAGE} >= ${minimumVersion}` };
  }
  const entrypoint = artifactEntrypoint(resolved, packageJson);
  if (!entrypoint) {
    return { valid: false, packageDir: resolved, version: packageJson.version ?? null, reason: "built artifact-tool entrypoint is missing" };
  }
  return {
    valid: true,
    packageDir: resolved,
    packagePath,
    version: packageJson.version,
    entrypoint: path.resolve(entrypoint),
  };
}

export async function smokeArtifactToolPackage(packageDir) {
  const inspection = await inspectArtifactToolPackage(packageDir);
  if (!inspection.valid) return inspection;
  try {
    const artifact = await import(`${pathToFileURL(inspection.entrypoint).href}?slidewright_package_probe=${Date.now()}`);
    if (!artifact.Presentation || !artifact.PresentationFile) {
      return { ...inspection, valid: false, reason: `resolved ${ARTIFACT_PACKAGE} does not export Presentation and PresentationFile` };
    }
    return { ...inspection, valid: true };
  } catch (error) {
    return { ...inspection, valid: false, reason: `artifact-tool smoke import failed: ${error.message}` };
  }
}

function runtimePackagePath(runtimeRoot) {
  return path.join(runtimeRoot, "dependencies", "node", "node_modules", "@oai", "artifact-tool");
}

function optionalRuntimePackagePath(runtimeRoot, packageName) {
  return path.join(runtimeRoot, "dependencies", "node", "node_modules", ...packageName.split("/"));
}

function explicitOverrideError(name, candidate, reason) {
  const error = new Error([
    `[${RUNTIME_OVERRIDE_INVALID_CODE}] ${name} is set but does not identify a supported local Codex presentation runtime.`,
    `Checked: ${candidate}`,
    `Reason: ${reason}`,
    `Recovery: correct or unset ${name}, then run 'node <slidewright-skill>/scripts/slidewright.mjs bootstrap' again.`,
    "Policy: Slidewright made no network request, downloaded nothing, and did not switch renderers.",
  ].join("\n"));
  error.code = RUNTIME_OVERRIDE_INVALID_CODE;
  error.recovery = `correct-or-unset:${name}`;
  error.localOnly = true;
  return error;
}

function runtimeUnavailableError(profile, attempts) {
  const error = new Error([
    `[${RUNTIME_UNAVAILABLE_CODE}] No supported local Codex presentation runtime was found for ${profile}.`,
    `Checked ${attempts.length} local candidate(s) for ${ARTIFACT_PACKAGE} >= ${MIN_ARTIFACT_TOOL_VERSION}.`,
    "Recovery: open or repair Codex with the Presentations runtime installed, or set SLIDEWRIGHT_CODEX_RUNTIME_ROOT / SLIDEWRIGHT_ARTIFACT_TOOL_PATH to an existing local runtime; then rerun 'node <slidewright-skill>/scripts/slidewright.mjs bootstrap'.",
    "Policy: Slidewright made no network request, downloaded nothing, and did not switch renderers.",
  ].join("\n"));
  error.code = RUNTIME_UNAVAILABLE_CODE;
  error.recovery = "install-or-select-local-codex-presentations-runtime";
  error.localOnly = true;
  error.attempts = attempts;
  return error;
}

function selectedRuntimeInvalidError(resolution, env, reason) {
  if (resolution.source === "explicit-package") {
    return explicitOverrideError("SLIDEWRIGHT_ARTIFACT_TOOL_PATH", env.SLIDEWRIGHT_ARTIFACT_TOOL_PATH, reason);
  }
  if (resolution.source === "explicit-runtime-root") {
    return explicitOverrideError("SLIDEWRIGHT_CODEX_RUNTIME_ROOT", env.SLIDEWRIGHT_CODEX_RUNTIME_ROOT, reason);
  }
  return runtimeUnavailableError(resolution.hostProfile, resolution.attempts);
}

export async function resolveArtifactRuntime({ cwd = process.cwd(), env = process.env, home, platform = process.platform, release = os.release() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const profile = detectHostProfile({ platform, release, env });
  const attempts = [];

  if (env.SLIDEWRIGHT_ARTIFACT_TOOL_PATH) {
    const candidate = path.resolve(env.SLIDEWRIGHT_ARTIFACT_TOOL_PATH);
    const inspection = await smokeArtifactToolPackage(candidate);
    attempts.push({ source: "explicit-package", candidate, valid: inspection.valid, reason: inspection.reason ?? null });
    if (!inspection.valid) throw explicitOverrideError("SLIDEWRIGHT_ARTIFACT_TOOL_PATH", candidate, inspection.reason);
    return { kind: "package", source: "explicit-package", hostProfile: profile, attempts, artifactTool: inspection, runtimeRoot: null };
  }

  if (env.SLIDEWRIGHT_CODEX_RUNTIME_ROOT) {
    const runtimeRoot = path.resolve(env.SLIDEWRIGHT_CODEX_RUNTIME_ROOT);
    const candidate = runtimePackagePath(runtimeRoot);
    const inspection = await smokeArtifactToolPackage(candidate);
    attempts.push({ source: "explicit-runtime-root", candidate, valid: inspection.valid, reason: inspection.reason ?? null });
    if (!inspection.valid) throw explicitOverrideError("SLIDEWRIGHT_CODEX_RUNTIME_ROOT", runtimeRoot, inspection.reason);
    return { kind: "package", source: "explicit-runtime-root", hostProfile: profile, attempts, artifactTool: inspection, runtimeRoot };
  }

  const workspacePackage = path.join(resolvedCwd, "node_modules", "@oai", "artifact-tool");
  const workspaceInspection = await smokeArtifactToolPackage(workspacePackage);
  attempts.push({ source: "workspace", candidate: workspacePackage, valid: workspaceInspection.valid, reason: workspaceInspection.reason ?? null });
  if (workspaceInspection.valid) {
    return { kind: "package", source: "workspace", hostProfile: profile, attempts, artifactTool: workspaceInspection, runtimeRoot: null };
  }

  const runtimeRoot = path.join(hostHome(env, home), ".cache", "codex-runtimes", "codex-primary-runtime");
  const bundledPackage = runtimePackagePath(runtimeRoot);
  const bundledInspection = await smokeArtifactToolPackage(bundledPackage);
  attempts.push({ source: "codex-bundled-runtime", candidate: bundledPackage, valid: bundledInspection.valid, reason: bundledInspection.reason ?? null });
  if (bundledInspection.valid) {
    return { kind: "package", source: "codex-bundled-runtime", hostProfile: profile, attempts, artifactTool: bundledInspection, runtimeRoot };
  }

  throw runtimeUnavailableError(profile, attempts);
}

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (!await exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for ${candidate}.`);
    current = parent;
  }
  return current;
}

async function assertContainedLinkParent(cwd, target) {
  const workspaceReal = await fs.realpath(cwd);
  const ancestor = await nearestExistingAncestor(path.dirname(target));
  const ancestorReal = await fs.realpath(ancestor);
  if (!isContained(workspaceReal, ancestorReal)) {
    throw new Error(`Refusing runtime link through a workspace path that resolves outside ${workspaceReal}: ${ancestorReal}`);
  }
}

async function ensureDirectoryTracked(cwd, directory, createdDirectories) {
  const missing = [];
  let current = path.resolve(directory);
  while (current !== path.resolve(cwd) && !await exists(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current || !isContained(path.resolve(cwd), parent)) throw new Error(`Refusing to create runtime directory outside ${cwd}: ${current}`);
    current = parent;
  }
  await fs.mkdir(directory, { recursive: true });
  createdDirectories.push(...missing.reverse());
}

async function linkPackage(cwd, packageName, sourcePackage, createdTargets, createdDirectories) {
  const target = path.join(cwd, "node_modules", ...packageName.split("/"));
  await assertContainedLinkParent(cwd, target);
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) {
    try {
      if (await fs.realpath(target) === await fs.realpath(sourcePackage)) return target;
    } catch {
      // Report the existing incompatible path below.
    }
    throw new Error(`${target} already exists and is not the selected ${packageName}; Slidewright left it unchanged.`);
  }
  await ensureDirectoryTracked(cwd, path.dirname(target), createdDirectories);
  await assertContainedLinkParent(cwd, target);
  await fs.symlink(path.resolve(sourcePackage), target, process.platform === "win32" ? "junction" : "dir");
  createdTargets.push(target);
  return target;
}

async function resolveBoundWorkspaceArtifactTool(cwd, expectedEntrypoint) {
  const targetRequire = createRequire(path.join(cwd, "__slidewright_runtime_probe__.cjs"));
  const resolved = targetRequire.resolve(ARTIFACT_PACKAGE);
  const [resolvedReal, expectedReal] = await Promise.all([fs.realpath(resolved), fs.realpath(expectedEntrypoint)]);
  if (resolvedReal !== expectedReal) throw new Error(`Workspace resolved ${ARTIFACT_PACKAGE} to ${resolvedReal}, not the smoke-validated entrypoint ${expectedReal}.`);
  return resolved;
}

async function rollbackLinks(cwd, targets, createdDirectories, removeWorkspace) {
  for (const target of [...targets].reverse()) await fs.rm(target, { recursive: true, force: true });
  for (const candidate of [...createdDirectories].reverse()) await fs.rmdir(candidate).catch(() => {});
  if (removeWorkspace) await fs.rmdir(cwd).catch(() => {});
}

export async function bootstrapArtifactWorkspace({ cwd = process.cwd(), env = process.env, home, platform = process.platform, release = os.release() } = {}) {
  const resolvedCwd = path.resolve(cwd);
  const resolution = await resolveArtifactRuntime({ cwd: resolvedCwd, env, home, platform, release });
  if (resolution.source === "workspace") {
    let resolvedEntrypoint;
    try {
      resolvedEntrypoint = await resolveBoundWorkspaceArtifactTool(resolvedCwd, resolution.artifactTool.entrypoint);
    } catch (error) {
      throw selectedRuntimeInvalidError(resolution, env, error.message);
    }
    return {
      cwd: resolvedCwd,
      hostProfile: resolution.hostProfile,
      source: resolution.source,
      runtimeVersion: resolution.artifactTool.version,
      artifactToolVersion: resolution.artifactTool.version,
      artifactToolPackage: resolution.artifactTool.packageDir,
      resolvedEntrypoint,
      downloaded: false,
      rendererSwitched: false,
      attempts: resolution.attempts,
    };
  }

  const workspaceExisted = await exists(resolvedCwd);
  const createdTargets = [];
  const createdDirectories = [];
  try {
    await fs.mkdir(resolvedCwd, { recursive: true });
    await linkPackage(resolvedCwd, ARTIFACT_PACKAGE, resolution.artifactTool.packageDir, createdTargets, createdDirectories);
    if (resolution.runtimeRoot) {
      const lucide = optionalRuntimePackagePath(resolution.runtimeRoot, "lucide");
      if (await exists(path.join(lucide, "package.json"))) await linkPackage(resolvedCwd, "lucide", lucide, createdTargets, createdDirectories);
    }
    let linkedInspection;
    let resolvedEntrypoint;
    try {
      linkedInspection = await inspectArtifactToolPackage(path.join(resolvedCwd, "node_modules", "@oai", "artifact-tool"));
      if (!linkedInspection.valid) throw new Error(`Runtime bootstrap did not produce a valid workspace ${ARTIFACT_PACKAGE}: ${linkedInspection.reason}`);
      resolvedEntrypoint = await resolveBoundWorkspaceArtifactTool(resolvedCwd, resolution.artifactTool.entrypoint);
    } catch (error) {
      throw selectedRuntimeInvalidError(resolution, env, error.message);
    }
    return {
      cwd: resolvedCwd,
      hostProfile: resolution.hostProfile,
      source: resolution.source,
      runtimeVersion: linkedInspection.version,
      artifactToolVersion: linkedInspection.version,
      artifactToolPackage: linkedInspection.packageDir,
      resolvedEntrypoint,
      downloaded: false,
      rendererSwitched: false,
      attempts: resolution.attempts,
    };
  } catch (error) {
    await rollbackLinks(resolvedCwd, createdTargets, createdDirectories, !workspaceExisted);
    throw error;
  }
}

export async function loadArtifactTool({ cwd = process.cwd() } = {}) {
  const targetRequire = createRequire(path.join(path.resolve(cwd), "package.json"));
  try {
    const resolved = targetRequire.resolve(ARTIFACT_PACKAGE);
    return await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new Error(`${ARTIFACT_PACKAGE} is not linked in this workspace. Run 'node <slidewright-skill>/scripts/slidewright.mjs bootstrap', then rerun preflight.`, { cause: error });
  }
}
