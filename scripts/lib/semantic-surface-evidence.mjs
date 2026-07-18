import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { captureWorkerIdentity, captureWorkerIdentityWithRetry, terminateExactWorker } from "./exact-worker-process.mjs";
import { cleanupOwnedPowerPoint } from "./owned-process-cleanup.mjs";

export const SEMANTIC_IMPLEMENTATION_PATHS = [
  "package.json",
  "package-lock.json",
  "scripts/setup-artifact-runtime.mjs",
  "scripts/run-semantic-surface-benchmark.mjs",
  "scripts/fixtures/arm-powerpoint-watchdog-control.mjs",
  "scripts/lib/semantic-surface-evidence.mjs",
  "scripts/lib/owned-process-cleanup.mjs",
  "scripts/lib/exact-worker-process.mjs",
  "scripts/lib/runner-watchdog.mjs",
  "plugins/slidewright/skills/slidewright/scripts/lib/artifact-runtime.mjs",
  "plugins/slidewright/skills/slidewright/scripts/lib/normalize_pptx.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/render_semantic_surface.mjs",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/structure_semantic_surface.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_surface.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/semantic_surface_negative_controls.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_semantic_roundtrip.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_render_isolated.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_timeout_probe.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/cleanup_owned_powerpoint.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/presentation_path_identity.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_runner_watchdog.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_runner_watchdog_entrypoint.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/start_powerpoint_runner_watchdog.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/start_powerpoint_timeout_probe_control.ps1",
  "fixtures/semantic-surface/v1/semantic-contract.json",
  "fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png",
  "tests/semantic-surface.test.mjs",
  "tests/runner-watchdog.test.mjs",
  "tests/presentation-path-identity.test.mjs",
  "tests/fixtures/start-runner-watchdog.mjs",
  "tests/fixtures/never-arm-watchdog.mjs",
].sort();

export function canonicalHash(value) {
  const normalize = (item) => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
      : item;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export async function sha256File(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export function normalizeCommandArgument(root, value) {
  const text = String(value);
  if (!path.isAbsolute(text)) return text;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(text);
  if (resolved === resolvedRoot) return "<repo>";
  if (resolved.startsWith(`${resolvedRoot}${path.sep}`)) return `<repo>/${path.relative(resolvedRoot, resolved).split(path.sep).join("/")}`;
  return `<external>/${path.basename(resolved)}`;
}

async function fileRecord(root, relative) {
  const absolute = path.resolve(root, ...relative.split("/"));
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Evidence file must be a regular non-link file: ${relative}`);
  return { path: relative, bytes: stat.size, sha256: await sha256File(absolute) };
}

export async function captureSemanticImplementation(root) {
  const files = [];
  for (const relative of SEMANTIC_IMPLEMENTATION_PATHS) files.push(await fileRecord(root, relative));
  return { files, sha256: canonicalHash(files) };
}

async function captureSemanticImplementationSnapshot(runDirectory, recorded) {
  requireEvidence(Array.isArray(recorded?.files) && recorded.files.length > 0, "C08 recorded implementation closure is missing.");
  const files = [];
  const snapshotRoot = path.resolve(runDirectory, "implementation-snapshot");
  for (const item of recorded.files) {
    requireEvidence(typeof item?.path === "string" && !item.path.startsWith("/") && !item.path.split("/").includes(".."), "C08 recorded implementation path is unsafe.");
    const absolute = path.resolve(snapshotRoot, ...item.path.split("/"));
    const relative = path.relative(snapshotRoot, absolute);
    requireEvidence(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), "C08 implementation snapshot escaped its immutable directory.");
    const stat = await fs.lstat(absolute);
    requireEvidence(stat.isFile() && !stat.isSymbolicLink(), `C08 implementation snapshot is not a regular file: ${item.path}`);
    files.push({ path: item.path, bytes: stat.size, sha256: await sha256File(absolute) });
  }
  const result = { files, sha256: canonicalHash(files) };
  requireEvidence(canonicalHash(result) === canonicalHash(recorded), "C08 historical implementation snapshot drifted.");
  return result;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function captureCleanGit(root) {
  const topLevel = path.resolve(git(root, ["rev-parse", "--show-toplevel"]));
  const commit = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  const canonical = (directory) => {
    const real = fsSync.realpathSync.native(path.resolve(directory));
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  const requestedRoot = canonical(root);
  const repositoryRoot = canonical(topLevel);
  const clean = repositoryRoot === requestedRoot && /^[a-f0-9]{40}$/u.test(commit) && status === "";
  if (!clean) {
    throw new Error(`C08 requires a clean exact Git checkout; commit=${commit}, status=${JSON.stringify(status)}, requestedRoot=${JSON.stringify(requestedRoot)}, repositoryRoot=${JSON.stringify(repositoryRoot)}.`);
  }
  return { commit, clean: true };
}

async function treeBinding(directory) {
  const files = [];
  async function visit(current, prefix = "") {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(await fileRecord(directory, relative));
      else throw new Error(`Runtime tree contains a non-regular entry: ${relative}`);
    }
  }
  await visit(directory);
  return { fileCount: files.length, treeSha256: canonicalHash(files) };
}

export async function captureSemanticRuntime({ root, python, slidesTest }) {
  const artifactRoot = await fs.realpath(path.join(root, "node_modules", "@oai", "artifact-tool"));
  const packageJson = JSON.parse(await fs.readFile(path.join(artifactRoot, "package.json"), "utf8"));
  const entrypoint = path.join(artifactRoot, packageJson.exports["."]);
  const pythonResult = spawnSync(python, ["--version"], { encoding: "utf8", windowsHide: true });
  const powerShellResult = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", windowsHide: true });
  if (pythonResult.error || pythonResult.status !== 0 || powerShellResult.error || powerShellResult.status !== 0) throw new Error("Could not bind C08 Python or PowerShell runtime.");
  return {
    node: { version: process.version, platform: process.platform, arch: process.arch, osRelease: os.release() },
    python: pythonResult.stdout.trim() || pythonResult.stderr.trim(),
    powerShell: powerShellResult.stdout.trim(),
    artifactTool: {
      version: packageJson.version,
      ...await treeBinding(artifactRoot),
      entrypointSha256: await sha256File(entrypoint),
    },
    slidesTestSha256: await sha256File(slidesTest),
  };
}

export async function collectReceiptTree(runDirectory) {
  const files = [];
  async function visit(current, prefix = "") {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === "scorecard.json") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(await fileRecord(runDirectory, relative));
      else throw new Error(`C08 receipt tree contains a non-regular entry: ${relative}`);
    }
  }
  await visit(runDirectory);
  return { files, treeSha256: canonicalHash(files) };
}

export function expectedSemanticReceiptPaths(contract, implementationPaths = SEMANTIC_IMPLEMENTATION_PATHS) {
  const paths = [
    "artifact-previews/montage.webp",
    "command-log.json",
    "freeze-report.json",
    "frozen-manifest.json",
    "negative-controls.json",
    "overflow-roundtrip.json",
    "overflow-source.json",
    "powerpoint-interstage-quiescence.json",
    "powerpoint-quiescence.json",
    "powerpoint-roundtrip-audit.json",
    "powerpoint-roundtrip-ownership.json",
    "powerpoint-roundtrip-render-ownership.json",
    "powerpoint-roundtrip-render.json",
    "powerpoint-roundtrip.json",
    "powerpoint-roundtrip.pptx",
    "powerpoint-source-render-ownership.json",
    "powerpoint-source-render.json",
    "powerpoint-timeout-cleanup-control.json",
    "powerpoint-timeout-probe-ownership.json",
    "powerpoint-timeout-probe.ready",
    "semantic-surface.pptx",
    "watchdog/forced-parent/armed.json",
    "watchdog/forced-parent/forced-parent-identity.json",
    "watchdog/forced-parent/forced-parent-ownership.json",
    "watchdog/forced-parent/forced-parent-worker-identity.json",
    "watchdog/forced-parent/forced-parent-worker.ready",
    "watchdog/forced-parent/summary.json",
    "watchdog/forced-parent/watchdog/diagnostic.log",
    "watchdog/forced-parent/watchdog/diagnostic.log.identity.json",
    "watchdog/forced-parent/watchdog/ready-snapshot.marker",
    "watchdog/forced-parent/watchdog/recovery.json",
    "watchdog/forced-parent/worker-intents/forced-parent-worker-intent.json",
    "watchdog/normal/completion.marker",
    "watchdog/normal/diagnostic.log",
    "watchdog/normal/identity-receipt.json",
    "watchdog/normal/ready.marker",
    "watchdog/normal/summary.json",
    "worker-intents/powerpoint-roundtrip-render-worker-intent.json",
    "worker-intents/powerpoint-roundtrip-worker-intent.json",
    "worker-intents/powerpoint-source-render-worker-intent.json",
    "worker-intents/powerpoint-timeout-probe-worker-intent.json",
  ];
  for (let index = 1; index <= 4; index += 1) {
    const slide = String(index).padStart(2, "0");
    paths.push(`artifact-previews/slide-${slide}.png`);
    for (const stem of ["powerpoint-source-render", "powerpoint-roundtrip-render"]) {
      paths.push(`${stem}/slide-${slide}.jpg`, `${stem}/slide-${slide}.png`);
    }
  }
  for (let index = 1; index <= 3; index += 1) {
    paths.push(
      `export-${index}-audit.json`,
      `export-${index}-base.pptx`,
      `export-${index}-base.pptx.inspect.ndjson`,
      `export-${index}-structured.pptx`,
      `normalize-${index}.json`,
    );
    if (index > 1) paths.push(`export-${index}.pptx`);
  }
  for (const id of contract.negativeControls) paths.push(`negative-controls/${id}.audit.json`, `negative-controls/${id}.pptx`);
  for (const relative of implementationPaths) paths.push(`implementation-snapshot/${relative}`);
  return paths.sort();
}

export function exactPathInventoryMatches(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const normalize = (items) => [...items].sort();
  return canonicalHash(normalize(actual)) === canonicalHash(normalize(expected));
}

async function listRegularFiles(root, directory = root) {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`C08 publication contains a non-regular entry: ${absolute}`);
  }
  return files;
}

async function assertIdenticalTrees(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listRegularFiles(left), listRegularFiles(right)]);
  requireEvidence(canonicalHash(leftFiles) === canonicalHash(rightFiles), "Existing C08 run has a different file inventory.");
  for (const relative of leftFiles) {
    const [leftBytes, rightBytes] = await Promise.all([fs.readFile(path.join(left, ...relative.split("/"))), fs.readFile(path.join(right, ...relative.split("/")))]);
    requireEvidence(leftBytes.equals(rightBytes), `Existing C08 run differs at ${relative}.`);
  }
}

async function replaceFileAtomically(target, contents) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, contents, "utf8");
  try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
}

export async function moveSemanticEvidenceDirectory({
  staging,
  finalRun,
  rename = fs.rename,
  access = fs.access,
  sleep = delay,
  maxAttempts = 12,
  retryDelayMs = 250,
}) {
  requireEvidence(Number.isInteger(maxAttempts) && maxAttempts > 0, "C08 publication retry count is invalid.");
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(staging, finalRun);
      return "moved";
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      const targetExists = await access(finalRun).then(
        () => true,
        (accessError) => {
          if (accessError.code === "ENOENT") return false;
          throw accessError;
        },
      );
      if (targetExists) return "existing";
      // OneDrive and antivirus filters can transiently hold a just-written
      // directory on Windows. EPERM without a destination is not an existing
      // immutable run, so retry the atomic rename instead of comparing a path
      // that does not exist.
      if (error.code !== "EPERM" || attempt === maxAttempts) throw error;
      await sleep(retryDelayMs * attempt);
    }
  }
  throw new Error("C08 publication rename retry loop exhausted unexpectedly.");
}

export async function publishVerifiedSemanticEvidence({ staging, published, scorecardHash, verify }) {
  const finalRun = path.join(published, "runs", scorecardHash);
  await fs.mkdir(path.dirname(finalRun), { recursive: true });
  const scorecard = JSON.parse((await fs.readFile(path.join(staging, "scorecard.json"), "utf8")).replace(/^\uFEFF/u, ""));
  requireEvidence(scorecard.scorecardHash === scorecardHash, "C08 staging scorecard does not match its publication key.");
  const disposition = await moveSemanticEvidenceDirectory({ staging, finalRun });
  if (disposition === "existing") {
    await assertIdenticalTrees(staging, finalRun);
    await fs.rm(staging, { recursive: true, force: true });
  }
  await verify(finalRun);
  const current = { schemaVersion: "slidewright-semantic-current/v1", scorecardHash, run: `runs/${scorecardHash}` };
  await replaceFileAtomically(path.join(published, "current.json"), `${JSON.stringify(current, null, 2)}\n`);
  await replaceFileAtomically(path.join(published, "scorecard.json"), await fs.readFile(path.join(finalRun, "scorecard.json"), "utf8"));
  return finalRun;
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitForJson(file, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "")); } catch { await delay(250); }
  }
  throw new Error(`Timed out waiting for watchdog recovery report ${file}.`);
}

async function readJsonIfPresent(file) {
  try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "")); } catch { return null; }
}

async function waitForIdentityExit(identity, timeoutMs = 15_000) {
  if (!identity?.processId || !identity.processName || !identity.processStartTime) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = captureWorkerIdentity(identity.processId);
    if (!live || live.processName !== identity.processName || live.processStartTime !== identity.processStartTime) return true;
    await delay(100);
  }
  return false;
}

async function waitForIdentityReceipt(file, processId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await readJsonIfPresent(file);
    if (receipt?.schemaVersion === "slidewright-forced-parent-identity/v1" && receipt.processId === processId) {
      const live = await captureWorkerIdentityWithRetry(processId, { timeoutMs: 500, pollMs: 50 });
      if (sameIdentity(receipt, live)) return receipt;
    }
    await delay(100);
  }
  return null;
}

function powerPointIdentities() {
  const script = "$p=@(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object {[ordered]@{processId=[int]$_.Id;processName=[string]$_.ProcessName;processStartTime=$_.StartTime.ToUniversalTime().ToString('o')}}); $p | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error("Could not inspect PowerPoint identities.");
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.processId === right.processId && left.processName === right.processName && left.processStartTime === right.processStartTime);
}

export async function runForcedParentWatchdogControl({
  root,
  output,
  semanticDir,
  fixture = path.join(root, "scripts", "fixtures", "arm-powerpoint-watchdog-control.mjs"),
  armingTimeoutMs = 180_000,
  recoveryTimeoutMs = 180_000,
} = {}) {
  if (process.platform !== "win32") return { enabled: false, valid: true, reason: "non-windows" };
  const controlDir = path.join(output, "watchdog", "forced-parent");
  await fs.mkdir(controlDir, { recursive: true });
  const initialPowerPoint = powerPointIdentities();
  const parentIdentityReceiptPath = path.join(controlDir, "forced-parent-identity.json");
  const child = spawn(process.execPath, [fixture, root, controlDir, semanticDir, parentIdentityReceiptPath], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let parentIdentity = null;
  let stdout = "";
  let stderr = "";
  let armed = null;
  let recovery = null;
  let parentTermination = null;
  let summary = null;
  let failure = null;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const recoveryPath = path.join(controlDir, "watchdog", "recovery.json");
  const ownershipPath = path.join(controlDir, "forced-parent-ownership.json");
  try {
    parentIdentity = await waitForIdentityReceipt(parentIdentityReceiptPath, child.pid);
    if (!parentIdentity) throw new Error("Forced-parent fixture did not publish a verified exact identity receipt.");
    const armedDeadline = Date.now() + armingTimeoutMs;
    while (!stdout.includes("\n") && Date.now() < armedDeadline) {
      if (child.exitCode !== null) throw new Error(`Forced-parent fixture exited before arming: ${stderr}`);
      await delay(100);
    }
    if (!stdout.includes("\n")) throw new Error(`Forced-parent fixture did not arm within ${armingTimeoutMs} ms.`);
    armed = JSON.parse(stdout.split(/\r?\n/u)[0]);
    if (!armed.valid || !sameIdentity(armed.parentIdentity, parentIdentity)) throw new Error("Forced-parent fixture identity did not bind to the exact live parent.");
    parentTermination = terminateExactWorker(parentIdentity.processId, parentIdentity);
    if (!parentTermination.matched || !parentTermination.terminated) throw new Error(`Could not terminate the exact forced-parent control process: ${JSON.stringify(parentTermination)}`);
    recovery = await waitForJson(recoveryPath, recoveryTimeoutMs);
  } catch (error) {
    failure = error;
  } finally {
    armed ??= await readJsonIfPresent(path.join(controlDir, "armed.json"));
    parentIdentity ??= await waitForIdentityReceipt(parentIdentityReceiptPath, child.pid, 1_000);
    parentIdentity ??= await captureWorkerIdentityWithRetry(child.pid, { timeoutMs: 2_000, pollMs: 100 });
    if (parentIdentity && !await waitForIdentityExit(parentIdentity, 250)) {
      parentTermination ??= terminateExactWorker(parentIdentity.processId, parentIdentity);
    } else if (!parentIdentity && child.exitCode === null) {
      // A missing identity is never absence proof. This emergency best effort
      // prevents an unreceipted fixture from being abandoned, while the
      // resulting control remains invalid and cannot be published.
      child.kill();
    }
    if (!recovery) {
      try { recovery = await waitForJson(recoveryPath, recoveryTimeoutMs); } catch { /* exact fallback below */ }
    }
    const workerIdentity = armed?.workerIdentity ?? await readJsonIfPresent(path.join(controlDir, "forced-parent-worker-identity.json"));
    const watchdogIdentity = armed?.watchdog ? {
      processId: armed.watchdog.processId,
      processName: armed.watchdog.processName,
      processStartTime: armed.watchdog.processStartTime,
    } : await readJsonIfPresent(path.join(controlDir, "watchdog", "diagnostic.log.identity.json"));
    if (!await waitForIdentityExit(workerIdentity, 250) && workerIdentity) terminateExactWorker(workerIdentity.processId, workerIdentity);
    const ownershipCleanup = await readJsonIfPresent(ownershipPath) ? cleanupOwnedPowerPoint(ownershipPath, { root }) : null;
    if (!await waitForIdentityExit(watchdogIdentity, 2_000) && watchdogIdentity) terminateExactWorker(watchdogIdentity.processId, watchdogIdentity);
    const processAbsence = {
      parent: await waitForIdentityExit(parentIdentity, 5_000),
      worker: await waitForIdentityExit(workerIdentity, 5_000),
      watchdog: await waitForIdentityExit(watchdogIdentity, 5_000),
    };
    const finalPowerPoint = powerPointIdentities();
    const newPowerPoint = finalPowerPoint.filter((candidate) => !initialPowerPoint.some((initial) => sameIdentity(candidate, initial)));
    const recoveryValid = Boolean(recovery
      && recovery.schemaVersion === "slidewright-runner-watchdog/v1"
      && recovery.valid === true && recovery.safe === true && recovery.recovered === true
      && recovery.parentIdentityMatched === true && recovery.parentExitedWithoutCompletionMarker === true
      && recovery.intentsFound >= 1 && recovery.recordsFound >= 1
      && recovery.recoveries.some((item) => item.workerMatched === true && item.workerTerminated === true)
      && recovery.recoveries.some((item) => item.cleanup?.valid === true && item.cleanup?.cleaned === true)
      && recovery.liveWorkerIdentities.length === 0 && recovery.newPowerPointProcesses.length === 0
      && recovery.problems.length === 0);
    const valid = !failure && recoveryValid && Object.values(processAbsence).every(Boolean) && newPowerPoint.length === 0;
    summary = {
      schemaVersion: "slidewright-watchdog-forced-parent-control/v1",
      valid,
      parentIdentity,
      parentIdentityReceiptSha256: await sha256File(parentIdentityReceiptPath).catch(() => null),
      parentTermination,
      armed,
      recoveryValid,
      recoveryReportSha256: recovery ? await sha256File(recoveryPath) : null,
      processAbsence,
      initialPowerPoint,
      finalPowerPoint,
      newPowerPoint,
      ownershipCleanup,
      failure: failure?.message ?? null,
    };
    await fs.writeFile(path.join(controlDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  if (!summary.valid) throw new Error(`Forced-parent watchdog control failed after exact teardown: ${JSON.stringify(summary)}`);
  return summary;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateNormalWatchdogEvidence({ summary, identityReceipt, readyText, completionText, diagnosticSha256 }) {
  const startup = summary?.startup;
  requireEvidence(summary?.schemaVersion === "slidewright-watchdog-normal-run/v1" && summary.valid === true, "C08 normal watchdog summary is invalid.");
  requireEvidence(startup?.enabled === true && Number.isInteger(startup.processId) && typeof startup.processStartTime === "string", "C08 normal watchdog startup identity is invalid.");
  requireEvidence(identityReceipt?.schemaVersion === "slidewright-runner-watchdog-identity/v1" && sameIdentity(identityReceipt, startup), "C08 normal watchdog identity receipt is forged.");
  requireEvidence(sameIdentity(summary.finalIdentity, startup) && summary.exactIdentityPreservedAtFinalization === true, "C08 normal watchdog final identity drifted.");
  requireEvidence(summary.identityReceiptSha256 === startup.identityReceiptSha256 && summary.readyMarkerSha256 === startup.readyMarkerSha256, "C08 normal watchdog startup hashes drifted.");
  requireEvidence(summary.identityReceiptExact === true && summary.readyMarkerExact === true && summary.completionMarkerExact === true, "C08 normal watchdog exact-marker flags drifted.");
  requireEvidence(readyText.replace(/^\uFEFF/u, "").trim() === "ready" && summary.readyMarkerExact === true, "C08 normal watchdog ready marker is invalid.");
  requireEvidence(completionText === "complete\n" && summary.completionMarkerExact === true, "C08 normal watchdog completion marker is invalid.");
  requireEvidence(summary.diagnosticLogSha256 === diagnosticSha256 && summary.recoveryReportAbsent === true, "C08 normal watchdog diagnostic or recovery state is invalid.");
  requireEvidence(summary.finalPowerPointQuiescence?.valid === true && summary.activeWorkerCount === 0, "C08 normal watchdog final process quiescence is invalid.");
  return true;
}

export function validateForcedParentWatchdogEvidence({
  summary,
  armed,
  recovery,
  ownership,
  intent,
  parentIdentityReceipt,
  workerIdentityReceipt,
  watchdogIdentityReceipt,
  watchdogIdentityReceiptSha256,
  readyMarkerSha256,
  readyText,
}) {
  requireEvidence(summary?.schemaVersion === "slidewright-watchdog-forced-parent-control/v1" && summary.valid === true && summary.failure === null, "C08 forced-parent summary is invalid.");
  requireEvidence(armed?.schemaVersion === "slidewright-watchdog-forced-parent-armed/v1" && armed.valid === true, "C08 forced-parent armed receipt is invalid.");
  requireEvidence(parentIdentityReceipt?.schemaVersion === "slidewright-forced-parent-identity/v1"
    && sameIdentity(summary.parentIdentity, parentIdentityReceipt)
    && sameIdentity(summary.parentIdentity, armed.parentIdentity), "C08 forced-parent identity binding drifted.");
  requireEvidence(summary.parentTermination?.matched === true && summary.parentTermination?.terminated === true, "C08 forced parent was not exactly terminated.");
  requireEvidence(sameIdentity(armed.workerIdentity, workerIdentityReceipt), "C08 forced-parent worker identity receipt drifted.");
  requireEvidence(sameIdentity(armed.watchdog, watchdogIdentityReceipt), "C08 forced-parent watchdog identity receipt drifted.");
  requireEvidence(armed.watchdog.identityReceiptSha256 === watchdogIdentityReceiptSha256
    && armed.watchdog.readyMarkerSha256 === readyMarkerSha256
    && readyText.replace(/^\uFEFF/u, "").trim() === "ready", "C08 forced-parent watchdog identity or ready-marker bytes drifted.");
  requireEvidence(intent?.schemaVersion === "slidewright-worker-intent/v1" && sameIdentity({ processId: intent.workerProcessId, processName: intent.workerProcessName, processStartTime: intent.workerProcessStartTime }, armed.workerIdentity), "C08 forced-parent worker intent drifted.");
  requireEvidence(ownership?.schemaVersion === "slidewright-owned-powerpoint/v1"
    && ownership.processName === "POWERPNT"
    && ownership.expectedApplicationVisible === false
    && ownership.workerProcessId === intent.workerProcessId
    && ownership.workerProcessName === intent.workerProcessName
    && ownership.workerProcessStartTime === intent.workerProcessStartTime, "C08 forced-parent ownership receipt drifted.");
  requireEvidence(recovery?.schemaVersion === "slidewright-runner-watchdog/v1"
    && recovery.valid === true && recovery.safe === true && recovery.recovered === true
    && recovery.parentProcessId === summary.parentIdentity.processId
    && recovery.parentIdentityMatched === true && recovery.parentExitedWithoutCompletionMarker === true
    && recovery.intentsFound >= 1 && recovery.recordsFound >= 1
    && recovery.recoveries.some((item) => item.workerMatched === true && item.workerTerminated === true)
    && recovery.recoveries.some((item) => item.cleanup?.valid === true && item.cleanup?.cleaned === true)
    && recovery.liveWorkerIdentities.length === 0 && recovery.newPowerPointProcesses.length === 0
    && recovery.problems.length === 0, "C08 forced-parent recovery report is invalid.");
  requireEvidence(summary.recoveryValid === true
    && Object.values(summary.processAbsence ?? {}).length === 3
    && Object.values(summary.processAbsence).every((item) => item === true)
    && Array.isArray(summary.initialPowerPoint) && Array.isArray(summary.finalPowerPoint)
    && Array.isArray(summary.newPowerPoint) && summary.newPowerPoint.length === 0
    && summary.ownershipCleanup?.valid === true && summary.ownershipCleanup?.cleaned === true, "C08 forced-parent survivor proof is invalid.");
  return true;
}

function validateQuiescenceCheckpoint(item, platform) {
  requireEvidence(item?.valid === true && Number.isInteger(item.waitedMs) && item.waitedMs >= 0
    && Number.isInteger(item.polls) && item.polls >= 0
    && (!Object.hasOwn(item, "lastPids") || (Array.isArray(item.lastPids) && item.lastPids.length === 0)), "C08 PowerPoint quiescence checkpoint is malformed.");
  if (platform === "win32") {
    requireEvidence(item.reason === "two-consecutive-clear-polls" && item.polls >= 2, "C08 Windows PowerPoint quiescence was not proven by two clear polls.");
  } else {
    requireEvidence(item.reason === "non-windows" && item.polls === 0 && item.waitedMs === 0, "C08 non-Windows PowerPoint quiescence receipt is invalid.");
  }
}

export function validatePowerPointQuiescenceEvidence({ initial, interStage, scorecardInitial, scorecardInterStage, platform = process.platform }) {
  requireEvidence(canonicalHash(initial) === canonicalHash(scorecardInitial), "C08 initial PowerPoint quiescence scorecard binding drifted.");
  validateQuiescenceCheckpoint(initial, platform);
  requireEvidence(interStage?.schemaVersion === "slidewright-powerpoint-quiescence-checkpoints/v1"
    && interStage.valid === true && Array.isArray(interStage.checkpoints)
    && interStage.checkpoints.length === 3, "C08 inter-stage PowerPoint quiescence receipt is invalid.");
  requireEvidence(canonicalHash(interStage.checkpoints) === canonicalHash(scorecardInterStage), "C08 inter-stage PowerPoint quiescence scorecard binding drifted.");
  const expectedStages = ["after-semantic-roundtrip", "between-source-and-roundtrip-render", "after-roundtrip-render"];
  for (let index = 0; index < expectedStages.length; index += 1) {
    requireEvidence(interStage.checkpoints[index]?.stage === expectedStages[index], "C08 inter-stage PowerPoint quiescence sequence drifted.");
    validateQuiescenceCheckpoint(interStage.checkpoints[index], platform);
  }
  return true;
}

const ALLOWED_TIMEOUT_CLEANUP_REASONS = new Set([
  "owned-process-already-exited",
  "owned-process-exited-after-com-release",
  "owned-headless-automation-process-exited-after-quit",
  "owned-headless-automation-process-exited-after-wm-quit",
]);

export function validateTimeoutCleanupEvidence({ control, ownership, ownershipSha256, readyMarkerSha256, readyText }) {
  requireEvidence(control?.valid === true && control.workerTimedOut === true, "C08 timeout cleanup control did not prove the intended timeout.");
  requireEvidence(ownership?.schemaVersion === "slidewright-owned-powerpoint/v1"
    && ownership.processName === "POWERPNT" && Number.isInteger(ownership.processId) && ownership.processId > 0
    && typeof ownership.processStartTime === "string" && ownership.processStartTime.length > 0
    && ownership.purpose === "timeout-cleanup-negative-control"
    && ownership.expectedApplicationVisible === false && Array.isArray(ownership.ownedPresentationPaths), "C08 timeout ownership receipt is invalid.");
  requireEvidence(control.ownershipRecordSha256 === ownershipSha256
    && control.readyMarkerSha256 === readyMarkerSha256
    && readyText.replace(/^\uFEFF/u, "").trim() === "ready", "C08 timeout ownership or ready-marker bytes drifted.");
  requireEvidence(control.firstCleanup?.valid === true && control.firstCleanup.cleaned === true
    && control.firstCleanup.safeRefusal === false
    && ALLOWED_TIMEOUT_CLEANUP_REASONS.has(control.firstCleanup.reason), "C08 first timeout cleanup result is invalid.");
  requireEvidence(control.ownedProcessAbsentAfterFirstCleanup === true
    && control.ownedProcessAbsentAfterCleanup === true, "C08 timeout cleanup absence claims are invalid.");
  requireEvidence(control.postCleanup?.valid === true && control.postCleanup.cleaned === true
    && control.postCleanup.safeRefusal === false
    && control.postCleanup.reason === "owned-process-already-exited", "C08 timeout post-cleanup result is invalid.");
  requireEvidence(/^[a-f0-9]{64}$/u.test(control.errorSha256), "C08 timeout error hash is invalid.");
  return true;
}

const EXPECTED_COLLAPSED_COMMAND_SEQUENCE = [
  "render", "structure", "normalize",
  "render", "structure", "normalize",
  "render", "structure", "normalize",
  "audit", "audit", "audit", "audit", "negative", "poll",
  "timeout", "roundtrip", "audit", "poll",
  "isolated-render", "poll",
  "isolated-render", "poll",
  "slides-test", "slides-test", "poll",
];

const POLL_ARGS = ["-NoProfile", "-Command", "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0"];

function expectedNonPollCommands(output, nodeCommand, pythonCommand) {
  const semantic = "<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface";
  const render = `${semantic}/render_semantic_surface.mjs`;
  const structure = `${semantic}/structure_semantic_surface.py`;
  const normalize = "<repo>/plugins/slidewright/skills/slidewright/scripts/lib/normalize_pptx.py";
  const audit = `${semantic}/audit_semantic_surface.py`;
  const negative = `${semantic}/semantic_surface_negative_controls.py`;
  const contract = "<repo>/fixtures/semantic-surface/v1/semantic-contract.json";
  const asset = "<repo>/fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png";
  const manifest = `${output}/frozen-manifest.json`;
  const source = `${output}/semantic-surface.pptx`;
  const roundtrip = `${output}/powerpoint-roundtrip.pptx`;
  const records = [];
  for (let index = 1; index <= 3; index += 1) {
    const base = `${output}/export-${index}-base.pptx`;
    const raw = `${output}/export-${index}-structured.pptx`;
    const structured = index === 1 ? source : `${output}/export-${index}.pptx`;
    records.push(
      { label: "render", command: nodeCommand, args: [render, base, index === 1 ? `${output}/artifact-previews` : "", asset] },
      { label: "structure", command: pythonCommand, args: [structure, base, raw, "--contract", contract] },
      { label: "normalize", command: pythonCommand, args: [normalize, raw, "--out", structured, "--report-json", `${output}/normalize-${index}.json`] },
    );
  }
  records.push(
    { label: "audit", command: pythonCommand, args: [audit, source, "--contract", contract, "--freeze-manifest", manifest, "--json", `${output}/freeze-report.json`] },
    { label: "audit", command: pythonCommand, args: [audit, source, "--manifest", manifest, "--contract", contract, "--json", `${output}/export-1-audit.json`] },
    { label: "audit", command: pythonCommand, args: [audit, `${output}/export-2.pptx`, "--manifest", manifest, "--contract", contract, "--json", `${output}/export-2-audit.json`] },
    { label: "audit", command: pythonCommand, args: [audit, `${output}/export-3.pptx`, "--manifest", manifest, "--contract", contract, "--json", `${output}/export-3-audit.json`] },
    { label: "negative", command: pythonCommand, args: [negative, source, manifest, `${output}/negative-controls`, "--json", `${output}/negative-controls.json`] },
    { label: "timeout", command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_timeout_probe.ps1`, "-OwnershipRecordJson", `${output}/powerpoint-timeout-probe-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-timeout-probe-worker-intent.json`, "-ReadyMarker", `${output}/powerpoint-timeout-probe.ready`, "-HoldSeconds", "120"] },
    { label: "roundtrip", command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_semantic_roundtrip.ps1`, "-InputPptx", source, "-OutputPptx", roundtrip, "-ReportJson", `${output}/powerpoint-roundtrip.json`, "-OwnershipRecordJson", `${output}/powerpoint-roundtrip-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-roundtrip-worker-intent.json`] },
    { label: "audit", command: pythonCommand, args: [audit, roundtrip, "--manifest", manifest, "--contract", contract, "--allow-relationship-rebase", "--json", `${output}/powerpoint-roundtrip-audit.json`] },
    { label: "isolated-render", command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_render_isolated.ps1`, "-InputPptx", source, "-OutputDir", `${output}/powerpoint-source-render`, "-ReportJson", `${output}/powerpoint-source-render.json`, "-OwnershipRecordJson", `${output}/powerpoint-source-render-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-source-render-worker-intent.json`] },
    { label: "isolated-render", command: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_render_isolated.ps1`, "-InputPptx", roundtrip, "-OutputDir", `${output}/powerpoint-roundtrip-render`, "-ReportJson", `${output}/powerpoint-roundtrip-render.json`, "-OwnershipRecordJson", `${output}/powerpoint-roundtrip-render-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-roundtrip-render-worker-intent.json`] },
    { label: "slides-test", command: pythonCommand, args: ["<external>/slides_test.py", source] },
    { label: "slides-test", command: pythonCommand, args: ["<external>/slides_test.py", roundtrip] },
  );
  return records;
}

export function validateCommandReceipts(log) {
  requireEvidence(log?.schemaVersion === "slidewright-command-receipts/v1" && log.logicalCommand === "npm run semantic-surface" && Array.isArray(log.commands), "C08 command receipt log is incomplete.");
  const first = log.commands[0];
  const outputMatch = first?.args?.[1]?.match(/^(<repo>\/outputs\/semantic-surface\/runs\/\.staging-\d+-\d+)\/export-1-base\.pptx$/u);
  requireEvidence(outputMatch, "C08 command log does not bind the exact staging output path.");
  const nodeCommand = first.command;
  const pythonCommand = log.commands.find((item) => item.args?.[0] === "<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface/structure_semantic_surface.py")?.command;
  requireEvidence(/^node(?:\.exe)?$/u.test(nodeCommand.split("/").at(-1).toLowerCase())
    && /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(pythonCommand?.split("/").at(-1).toLowerCase() ?? ""), "C08 command runtime identities are invalid.");
  const expected = expectedNonPollCommands(outputMatch[1], nodeCommand, pythonCommand);
  const labels = [];
  const pollRunLengths = [];
  let nonPollIndex = 0;
  for (const item of log.commands) {
    requireEvidence(typeof item.command === "string" && Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string")
      && /^[a-f0-9]{64}$/u.test(item.stdoutSha256) && /^[a-f0-9]{64}$/u.test(item.stderrSha256), "C08 command receipt is malformed.");
    requireEvidence(!item.args.some((arg) => /^<repo>\/(?:-|\d+$)/u.test(arg)), "C08 command argv normalization fabricated a path from a flag or scalar.");
    const poll = item.command === "powershell" && canonicalHash(item.args) === canonicalHash(POLL_ARGS);
    if (poll) {
      requireEvidence(item.timedOut === false && item.exitCode === 0, "C08 PowerPoint poll command failed or timed out.");
      if (labels.at(-1) === "poll") pollRunLengths[pollRunLengths.length - 1] += 1;
      else { labels.push("poll"); pollRunLengths.push(1); }
    } else {
      const descriptor = expected[nonPollIndex];
      requireEvidence(descriptor && item.command === descriptor.command && canonicalHash(item.args) === canonicalHash(descriptor.args), "C08 command receipt contains an unexpected command or argv sequence.");
      labels.push(descriptor.label);
      nonPollIndex += 1;
      if (descriptor.label === "timeout") requireEvidence(item.timedOut === true && item.exitCode !== 0, "C08 intended timeout command did not time out.");
      else requireEvidence(item.timedOut === false && item.exitCode === 0, "C08 command log contains an unexpected failure.");
    }
  }
  requireEvidence(nonPollIndex === expected.length, "C08 command receipt log is missing a required command.");
  requireEvidence(canonicalHash(labels) === canonicalHash(EXPECTED_COLLAPSED_COMMAND_SEQUENCE), "C08 command receipt sequence drifted.");
  requireEvidence(pollRunLengths.length === 5 && pollRunLengths.every((count) => count >= 2), "C08 command log did not prove five two-poll PowerPoint quiescence gates.");
  return true;
}

export async function verifySemanticSurfaceEvidence({ root, runDirectory, python, slidesTest, requireCurrentGit = true }) {
  const scorecard = JSON.parse((await fs.readFile(path.join(runDirectory, "scorecard.json"), "utf8")).replace(/^\uFEFF/u, ""));
  const core = structuredClone(scorecard); delete core.scorecardHash;
  if (scorecard.schemaVersion !== "slidewright-semantic-surface-scorecard/v2" || scorecard.scorecardHash !== canonicalHash(core)) throw new Error("C08 scorecard hash or schema is invalid.");
  const implementation = requireCurrentGit
    ? await captureSemanticImplementation(root)
    : await captureSemanticImplementationSnapshot(runDirectory, scorecard.provenance.implementation);
  if (canonicalHash(implementation) !== canonicalHash(scorecard.provenance.implementation)) throw new Error("C08 implementation closure drifted.");
  if (requireCurrentGit) {
    const gitState = captureCleanGit(root);
    if (gitState.commit !== scorecard.provenance.git.commit || !scorecard.provenance.git.cleanBefore || !scorecard.provenance.git.cleanAfter || !scorecard.provenance.git.sameCommit) throw new Error("C08 Git provenance drifted.");
  }
  const runtime = await captureSemanticRuntime({ root, python, slidesTest });
  if (canonicalHash(runtime) !== canonicalHash(scorecard.provenance.runtime)) throw new Error("C08 runtime binding drifted.");
  const receipts = await collectReceiptTree(runDirectory);
  if (canonicalHash(receipts) !== canonicalHash(scorecard.receipts)) throw new Error("C08 receipt tree drifted.");
  const paths = new Set(receipts.files.map((item) => item.path));
  const required = [
    "command-log.json", "freeze-report.json", "frozen-manifest.json", "negative-controls.json",
    "powerpoint-roundtrip.pptx", "powerpoint-roundtrip.json", "powerpoint-roundtrip-audit.json",
    "overflow-source.json", "overflow-roundtrip.json", "powerpoint-quiescence.json", "powerpoint-interstage-quiescence.json", "watchdog/normal/summary.json",
    "watchdog/normal/identity-receipt.json", "watchdog/normal/ready.marker", "watchdog/normal/completion.marker", "watchdog/normal/diagnostic.log",
    "watchdog/forced-parent/summary.json", "watchdog/forced-parent/armed.json", "watchdog/forced-parent/forced-parent-identity.json",
    "watchdog/forced-parent/forced-parent-ownership.json", "watchdog/forced-parent/forced-parent-worker-identity.json",
    "watchdog/forced-parent/forced-parent-worker.ready", "watchdog/forced-parent/worker-intents/forced-parent-worker-intent.json",
    "watchdog/forced-parent/watchdog/diagnostic.log", "watchdog/forced-parent/watchdog/diagnostic.log.identity.json",
    "watchdog/forced-parent/watchdog/ready-snapshot.marker", "watchdog/forced-parent/watchdog/recovery.json",
    "powerpoint-timeout-cleanup-control.json", "powerpoint-timeout-probe-ownership.json", "powerpoint-timeout-probe.ready",
    "powerpoint-roundtrip-ownership.json", "powerpoint-source-render-ownership.json", "powerpoint-roundtrip-render-ownership.json",
  ];
  for (const item of required) if (!paths.has(item)) throw new Error(`C08 receipt tree is missing ${item}.`);
  for (let index = 1; index <= 3; index += 1) {
    if (!paths.has(`normalize-${index}.json`) || !paths.has(`export-${index}-audit.json`)) throw new Error(`C08 deterministic export ${index} receipts are incomplete.`);
  }
  const negativeDecks = receipts.files.filter((item) => /^negative-controls\/[^/]+\.pptx$/u.test(item.path));
  const negativeAudits = receipts.files.filter((item) => /^negative-controls\/[^/]+\.audit\.json$/u.test(item.path));
  const renderPngs = receipts.files.filter((item) => /^powerpoint-(?:source|roundtrip)-render\/slide-\d{2}\.png$/u.test(item.path));
  const renderJpegs = receipts.files.filter((item) => /^powerpoint-(?:source|roundtrip)-render\/slide-\d{2}\.jpg$/u.test(item.path));
  const mainWorkerIntents = receipts.files.filter((item) => /^worker-intents\/[^/]+-worker-intent\.json$/u.test(item.path));
  if (negativeDecks.length !== 9 || negativeAudits.length !== 9 || renderPngs.length !== 8 || renderJpegs.length !== 8 || mainWorkerIntents.length !== 4) {
    throw new Error("C08 negative-control, render, or worker-intent receipt count is incomplete.");
  }
  const runFile = (relative) => path.join(runDirectory, ...relative.split("/"));
  const runJson = async (relative) => JSON.parse((await fs.readFile(runFile(relative), "utf8")).replace(/^\uFEFF/u, ""));

  const [normalSummary, normalIdentity, forcedSummary, forcedArmed, forcedRecovery, forcedOwnership, forcedIntent, forcedParentIdentity, forcedWorkerIdentity, forcedWatchdogIdentity] = await Promise.all([
    runJson("watchdog/normal/summary.json"),
    runJson("watchdog/normal/identity-receipt.json"),
    runJson("watchdog/forced-parent/summary.json"),
    runJson("watchdog/forced-parent/armed.json"),
    runJson("watchdog/forced-parent/watchdog/recovery.json"),
    runJson("watchdog/forced-parent/forced-parent-ownership.json"),
    runJson("watchdog/forced-parent/worker-intents/forced-parent-worker-intent.json"),
    runJson("watchdog/forced-parent/forced-parent-identity.json"),
    runJson("watchdog/forced-parent/forced-parent-worker-identity.json"),
    runJson("watchdog/forced-parent/watchdog/diagnostic.log.identity.json"),
  ]);
  requireEvidence(canonicalHash(normalSummary) === canonicalHash(scorecard.watchdog.normal), "C08 normal watchdog scorecard summary drifted.");
  requireEvidence(canonicalHash(forcedSummary) === canonicalHash(scorecard.watchdog.forcedParent), "C08 forced-parent scorecard summary drifted.");
  validateNormalWatchdogEvidence({
    summary: normalSummary,
    identityReceipt: normalIdentity,
    readyText: await fs.readFile(runFile("watchdog/normal/ready.marker"), "utf8"),
    completionText: await fs.readFile(runFile("watchdog/normal/completion.marker"), "utf8"),
    diagnosticSha256: await sha256File(runFile("watchdog/normal/diagnostic.log")),
  });
  requireEvidence(normalSummary.identityReceiptSha256 === await sha256File(runFile("watchdog/normal/identity-receipt.json"))
    && normalSummary.readyMarkerSha256 === await sha256File(runFile("watchdog/normal/ready.marker"))
    && normalSummary.completionMarkerSha256 === await sha256File(runFile("watchdog/normal/completion.marker")), "C08 normal watchdog marker hashes drifted.");
  validateForcedParentWatchdogEvidence({
    summary: forcedSummary,
    armed: forcedArmed,
    recovery: forcedRecovery,
    ownership: forcedOwnership,
    intent: forcedIntent,
    parentIdentityReceipt: forcedParentIdentity,
    workerIdentityReceipt: forcedWorkerIdentity,
    watchdogIdentityReceipt: forcedWatchdogIdentity,
    watchdogIdentityReceiptSha256: await sha256File(runFile("watchdog/forced-parent/watchdog/diagnostic.log.identity.json")),
    readyMarkerSha256: await sha256File(runFile("watchdog/forced-parent/watchdog/ready-snapshot.marker")),
    readyText: await fs.readFile(runFile("watchdog/forced-parent/watchdog/ready-snapshot.marker"), "utf8"),
  });
  requireEvidence(forcedSummary.parentIdentityReceiptSha256 === await sha256File(runFile("watchdog/forced-parent/forced-parent-identity.json"))
    && forcedSummary.recoveryReportSha256 === await sha256File(runFile("watchdog/forced-parent/watchdog/recovery.json")), "C08 forced-parent identity or recovery hash drifted.");
  for (const identity of [forcedSummary.parentIdentity, forcedArmed.workerIdentity, forcedArmed.watchdog]) {
    requireEvidence(await waitForIdentityExit(identity, 250), "C08 forced-parent exact process identity is still alive.");
  }
  if (requireCurrentGit) {
    const currentPowerPoint = powerPointIdentities();
    requireEvidence(currentPowerPoint.every((candidate) => forcedSummary.initialPowerPoint.some((initial) => sameIdentity(candidate, initial))), "C08 forced-parent control left a new PowerPoint process.");
  }
  validateCommandReceipts(await runJson("command-log.json"));
  validatePowerPointQuiescenceEvidence({
    initial: await runJson("powerpoint-quiescence.json"),
    interStage: await runJson("powerpoint-interstage-quiescence.json"),
    scorecardInitial: scorecard.powerPointQuiescence,
    scorecardInterStage: scorecard.interStagePowerPointQuiescence,
  });

  const evidenceRoot = requireCurrentGit ? root : path.join(runDirectory, "implementation-snapshot");
  const contractPath = path.join(evidenceRoot, "fixtures", "semantic-surface", "v1", "semantic-contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  const recordedImplementationPaths = implementation.files.map((item) => item.path);
  requireEvidence(exactPathInventoryMatches(receipts.files.map((item) => item.path), expectedSemanticReceiptPaths(contract, recordedImplementationPaths)), "C08 receipt inventory has a missing or unexpected file.");
  requireEvidence(scorecard.contractSha256 === await sha256File(contractPath), "C08 contract hash drifted.");
  const imageSource = contract.slides.find((slide) => slide.image)?.image?.source;
  requireEvidence(typeof imageSource === "string", "C08 contract has no declared source image.");
  const sourceAsset = path.resolve(evidenceRoot, ...imageSource.split("/"));
  const sourceAssetRelative = path.relative(evidenceRoot, sourceAsset);
  requireEvidence(sourceAssetRelative !== "" && !sourceAssetRelative.startsWith("..") && !path.isAbsolute(sourceAssetRelative), "C08 declared source asset escaped the evidence root.");
  requireEvidence(scorecard.sourceAssetSha256 === await sha256File(sourceAsset), "C08 declared source asset hash drifted.");
  const freeze = await runJson("freeze-report.json");
  requireEvidence(freeze.valid === true && freeze.contractValid === true && freeze.manifestWritten === true
    && canonicalHash(freeze.summary) === canonicalHash(scorecard.semanticSummary), "C08 frozen semantic report drifted.");
  requireEvidence(scorecard.frozenManifestSha256 === await sha256File(runFile("frozen-manifest.json")), "C08 frozen manifest hash drifted.");
  const exportFiles = ["semantic-surface.pptx", "export-2.pptx", "export-3.pptx"];
  for (let index = 0; index < 3; index += 1) {
    const exportAudit = await runJson(`export-${index + 1}-audit.json`);
    const exportHash = await sha256File(runFile(exportFiles[index]));
    requireEvidence(exportAudit.valid === true && exportAudit.checks?.authoredContract === true
      && scorecard.deterministicExports[index]?.export === index + 1
      && scorecard.deterministicExports[index]?.sha256 === exportHash, `C08 export ${index + 1} audit or hash drifted.`);
  }
  requireEvidence(new Set(scorecard.deterministicExports.map((item) => item.sha256)).size === 1 && scorecard.exactByteDeterminism === true, "C08 deterministic export proof drifted.");

  const negatives = await runJson("negative-controls.json");
  requireEvidence(negatives.valid === true && negatives.baselineValid === true
    && canonicalHash(negatives.controls.map((item) => item.id)) === canonicalHash(contract.negativeControls), "C08 negative-control inventory drifted.");
  for (let index = 0; index < contract.negativeControls.length; index += 1) {
    const id = contract.negativeControls[index];
    const item = negatives.controls[index];
    const audit = await runJson(`negative-controls/${id}.audit.json`);
    requireEvidence(item.id === id && item.output === `${id}.pptx` && item.audit === `${id}.audit.json`
      && item.rejected === true && item.failureCount > 0 && audit.valid === false
      && item.outputSha256 === await sha256File(runFile(`negative-controls/${id}.pptx`))
      && item.auditSha256 === await sha256File(runFile(`negative-controls/${id}.audit.json`))
      && canonicalHash(item.failureCodes) === canonicalHash([...new Set(audit.failures.map((failure) => failure.code))].sort())
      && canonicalHash(scorecard.negativeControls[index]) === canonicalHash({ id, rejected: true, failureCodes: item.failureCodes, outputSha256: item.outputSha256, auditSha256: item.auditSha256 }), `C08 negative control ${id} drifted.`);
  }

  const timeoutControl = await runJson("powerpoint-timeout-cleanup-control.json");
  const timeoutOwnership = await runJson("powerpoint-timeout-probe-ownership.json");
  requireEvidence(canonicalHash(timeoutControl) === canonicalHash(scorecard.timeoutCleanupControl), "C08 timeout cleanup control drifted.");
  validateTimeoutCleanupEvidence({
    control: timeoutControl,
    ownership: timeoutOwnership,
    ownershipSha256: await sha256File(runFile("powerpoint-timeout-probe-ownership.json")),
    readyMarkerSha256: await sha256File(runFile("powerpoint-timeout-probe.ready")),
    readyText: await fs.readFile(runFile("powerpoint-timeout-probe.ready"), "utf8"),
  });
  const workerBindings = [
    ["timeout-probe", "powerpoint-timeout-probe", "powerpoint-timeout-probe-ownership.json"],
    ["roundtrip", "powerpoint-roundtrip", "powerpoint-roundtrip-ownership.json"],
    ["source-render", "powerpoint-source-render", "powerpoint-source-render-ownership.json"],
    ["roundtrip-render", "powerpoint-roundtrip-render", "powerpoint-roundtrip-render-ownership.json"],
  ];
  for (let index = 0; index < workerBindings.length; index += 1) {
    const [stage, stem, ownershipFile] = workerBindings[index];
    const intentPath = `worker-intents/${stem}-worker-intent.json`;
    const [intent, ownership] = await Promise.all([runJson(intentPath), runJson(ownershipFile)]);
    requireEvidence(intent.schemaVersion === "slidewright-worker-intent/v1" && intent.state === "started"
      && ownership.schemaVersion === "slidewright-owned-powerpoint/v1" && ownership.processName === "POWERPNT"
      && ownership.expectedApplicationVisible === false && Array.isArray(ownership.ownedPresentationPaths)
      && ownership.workerProcessId === intent.workerProcessId && ownership.workerProcessName === intent.workerProcessName
      && ownership.workerProcessStartTime === intent.workerProcessStartTime
      && scorecard.workerIntents[index]?.stage === stage
      && scorecard.workerIntents[index]?.sha256 === await sha256File(runFile(intentPath)), `C08 worker intent or ownership drifted for ${stage}.`);
  }
  const sourcePptxSha = await sha256File(runFile("semantic-surface.pptx"));
  const roundtripPptxSha = await sha256File(runFile("powerpoint-roundtrip.pptx"));
  const powerPoint = await runJson("powerpoint-roundtrip.json");
  const roundtripAudit = await runJson("powerpoint-roundtrip-audit.json");
  requireEvidence(powerPoint.valid === true && powerPoint.serializedBySaveAs === true && powerPoint.exactTopLevelStatePreserved === true
    && powerPoint.automationProcessOwned === true && powerPoint.outputSha256 === roundtripPptxSha
    && roundtripAudit.valid === true && roundtripAudit.checks?.authoredContract === true
    && scorecard.powerpoint.roundtripPptxSha256 === roundtripPptxSha
    && scorecard.powerpoint.serializedBySaveAs === powerPoint.serializedBySaveAs
    && scorecard.powerpoint.exactTopLevelStatePreserved === powerPoint.exactTopLevelStatePreserved
    && scorecard.powerpoint.ownershipRecordHashes.roundtrip === await sha256File(runFile("powerpoint-roundtrip-ownership.json"))
    && scorecard.powerpoint.ownershipRecordHashes.sourceRender === await sha256File(runFile("powerpoint-source-render-ownership.json"))
    && scorecard.powerpoint.ownershipRecordHashes.roundtripRender === await sha256File(runFile("powerpoint-roundtrip-render-ownership.json")), "C08 PowerPoint round-trip evidence drifted.");

  const sourceRender = await runJson("powerpoint-source-render.json");
  const roundtripRender = await runJson("powerpoint-roundtrip-render.json");
  requireEvidence(sourceRender.valid === true && roundtripRender.valid === true && sourceRender.inputSha256 === sourcePptxSha && roundtripRender.inputSha256 === roundtripPptxSha
    && sourceRender.allSessionsOwned === true && roundtripRender.allSessionsOwned === true
    && sourceRender.sessions.every((item) => item.automationProcessOwned === true) && roundtripRender.sessions.every((item) => item.automationProcessOwned === true)
    && sourceRender.renders.length === 4 && roundtripRender.renders.length === 4, "C08 PowerPoint render reports drifted.");
  for (let index = 0; index < 4; index += 1) {
    const sourceItem = sourceRender.renders[index];
    const roundtripItem = roundtripRender.renders[index];
    const slide = String(index + 1).padStart(2, "0");
    requireEvidence(sourceItem.file === `slide-${slide}.png` && sourceItem.reviewFile === `slide-${slide}.jpg`
      && roundtripItem.file === `slide-${slide}.png` && roundtripItem.reviewFile === `slide-${slide}.jpg`
      && sourceItem.width === 1600 && sourceItem.height === 900 && roundtripItem.width === 1600 && roundtripItem.height === 900
      && sourceItem.sha256 === await sha256File(runFile(`powerpoint-source-render/slide-${slide}.png`))
      && sourceItem.reviewSha256 === await sha256File(runFile(`powerpoint-source-render/slide-${slide}.jpg`))
      && roundtripItem.sha256 === await sha256File(runFile(`powerpoint-roundtrip-render/slide-${slide}.png`))
      && roundtripItem.reviewSha256 === await sha256File(runFile(`powerpoint-roundtrip-render/slide-${slide}.jpg`))
      && sourceItem.sha256 === roundtripItem.sha256 && sourceItem.reviewSha256 === roundtripItem.reviewSha256, `C08 PowerPoint render ${slide} drifted.`);
  }
  requireEvidence(scorecard.powerpoint.exactFullSizeRenderParity === true
    && canonicalHash(scorecard.powerpoint.sourceRenderHashes) === canonicalHash(sourceRender.renders.map((item) => item.sha256))
    && canonicalHash(scorecard.powerpoint.roundtripRenderHashes) === canonicalHash(roundtripRender.renders.map((item) => item.sha256))
    && canonicalHash(scorecard.powerpoint.sourceReviewHashes) === canonicalHash(sourceRender.renders.map((item) => item.reviewSha256))
    && canonicalHash(scorecard.powerpoint.roundtripReviewHashes) === canonicalHash(roundtripRender.renders.map((item) => item.reviewSha256)), "C08 scorecard render derivation drifted.");
  for (const [label, pptxSha] of [["source", sourcePptxSha], ["roundtrip", roundtripPptxSha]]) {
    const overflow = await runJson(`overflow-${label}.json`);
    requireEvidence(overflow.valid === true && overflow.exitCode === 0 && overflow.inputSha256 === pptxSha, `C08 overflow ${label} drifted.`);
  }
  requireEvidence(scorecard.valid === true && scorecard.watchdog.normal.valid === true && scorecard.watchdog.forcedParent.valid === true
    && scorecard.exportAuditsValid === true && scorecard.powerpointSemanticAuditValid === true && scorecard.overflowChecksValid === true, "C08 derived scorecard gates are invalid.");
  return { valid: true, scorecardHash: scorecard.scorecardHash, receiptCount: receipts.files.length };
}
