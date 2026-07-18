#!/usr/bin/env node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cleanupOwnedPowerPoint } from "./lib/owned-process-cleanup.mjs";
import { captureWorkerIdentity, terminateExactWorker } from "./lib/exact-worker-process.mjs";
import { startRunnerWatchdog } from "./lib/runner-watchdog.mjs";
import {
  captureCleanGit,
  collectReceiptTree,
  normalizeCommandArgument,
  sha256File,
  validateNormalWatchdogEvidence,
  verifySemanticSurfaceEvidence,
} from "./lib/semantic-surface-evidence.mjs";
import {
  SEMANTIC_MUTATION_IMPLEMENTATION_PATHS,
  captureSemanticMutationImplementation,
  captureSemanticMutationRuntime,
  publishSemanticMutationEvidence,
  validateRenderedHeaderNegativeControls,
  verifySemanticMutationEvidence,
} from "./lib/semantic-mutation-evidence.mjs";

const root = process.cwd();
const publishedOutput = path.join(root, "outputs", "semantic-mutation");
const publishedRuns = path.join(publishedOutput, "runs");
const output = path.join(publishedRuns, `.staging-${process.pid}-${Date.now()}`);
const semanticSurfaceOutput = path.join(root, "outputs", "semantic-surface");
const scripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");
const semantic = path.join(scripts, "semantic_surface");
const mutationContractPath = path.join(root, "fixtures", "semantic-surface", "v1", "mutation-contract.json");
const mutationWorkerScript = path.join(semantic, "powerpoint_semantic_mutation.ps1");
const mutationAuditScript = path.join(semantic, "audit_semantic_mutation.py");
const renderedHeaderAuditScript = path.join(semantic, "audit_rendered_headers.py");
const negativeControlsScript = path.join(semantic, "semantic_mutation_negative_controls.py");
const isolatedRenderScript = path.join(semantic, "powerpoint_render_isolated.ps1");
const watchdogScript = path.join(semantic, "powerpoint_mutation_runner_watchdog.ps1");
const watchdogCompletionMarker = path.join(root, "outputs", `.semantic-mutation-watchdog-${process.pid}.complete`);
const watchdogReadyMarker = path.join(root, "outputs", `.semantic-mutation-watchdog-${process.pid}.ready`);
const watchdogRecoveryReport = path.join(root, "outputs", `.semantic-mutation-watchdog-${process.pid}.json`);
const watchdogDiagnosticLog = path.join(root, "outputs", `.semantic-mutation-watchdog-${process.pid}.log`);
const baselinePptx = path.join(output, "powerpoint-normalized-baseline.pptx");
const mutationOutputDir = path.join(output, "mutations");
const mutationReportPath = path.join(output, "powerpoint-mutation.json");
const mutationOwnershipPath = path.join(output, "powerpoint-mutation-ownership.json");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }

const activeWorkers = new Map();
const commandReceipts = [];
let signalCleanupStarted = false;

function logicalArgument(value) {
  return normalizeCommandArgument(root, value);
}

function terminateWorkerOnly(workerPid, expectedIdentity) {
  return terminateExactWorker(workerPid, expectedIdentity);
}

async function captureOwnedPowerPointRuntime(ownershipRecordPath, receiptPath, processes = []) {
  let ownership;
  try { ownership = await readJson(ownershipRecordPath); } catch { return null; }
  const expected = { processId: ownership.processId, processName: ownership.processName, processStartTime: ownership.processStartTime };
  const acknowledge = async (receipt) => {
    await writeJson(`${ownershipRecordPath}.runtime-captured`, {
      schemaVersion: "slidewright-runtime-capture-ack/v1",
      ...expected,
      runtimeReceiptSha256: await sha256File(receiptPath),
    });
    return receipt;
  };
  if (processes.some((item) => item.processId === expected.processId && item.processName === expected.processName && item.processStartTime === expected.processStartTime)) {
    return acknowledge({ schemaVersion: "slidewright-owned-powerpoint-runtime/v1", processes });
  }
  const liveBefore = captureWorkerIdentity(expected.processId);
  if (!liveBefore || liveBefore.processName !== expected.processName || liveBefore.processStartTime !== expected.processStartTime) return null;
  const query = spawnSync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${expected.processId} -ErrorAction Stop).Path`], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (query.error || query.status !== 0 || !query.stdout.trim()) return null;
  const executablePath = await fs.realpath(query.stdout.trim());
  const liveAfter = captureWorkerIdentity(expected.processId);
  if (!liveAfter || liveAfter.processName !== expected.processName || liveAfter.processStartTime !== expected.processStartTime) return null;
  const processReceipt = {
    processId: expected.processId,
    processName: expected.processName,
    processStartTime: expected.processStartTime,
    executablePath,
    executableSha256: await sha256File(executablePath),
  };
  const receipt = { schemaVersion: "slidewright-owned-powerpoint-runtime/v1", processes: [...processes, processReceipt] };
  await writeJson(receiptPath, receipt);
  return acknowledge(receipt);
}

function cleanupForSignal(signal) {
  if (signalCleanupStarted) return;
  signalCleanupStarted = true;
  for (const [workerPid, worker] of activeWorkers) {
    terminateWorkerOnly(workerPid, worker.identity);
    if (worker.ownershipRecordPath) cleanupOwnedPowerPoint(worker.ownershipRecordPath, { root });
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

process.once("SIGINT", () => cleanupForSignal("SIGINT"));
process.once("SIGTERM", () => cleanupForSignal("SIGTERM"));

async function appendCommandReceipt({ command, args, exitCode, signal = null, timedOut = false, error = null, stdout, stderr }) {
  const sequence = String(commandReceipts.length + 1).padStart(4, "0");
  const stdoutPath = `command-receipts/${sequence}.stdout.txt`;
  const stderrPath = `command-receipts/${sequence}.stderr.txt`;
  await fs.mkdir(path.join(output, "command-receipts"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(output, ...stdoutPath.split("/")), stdout, "utf8"),
    fs.writeFile(path.join(output, ...stderrPath.split("/")), stderr, "utf8"),
  ]);
  commandReceipts.push({
    command: logicalArgument(command),
    args: args.map(logicalArgument),
    exitCode,
    signal,
    timedOut,
    ...(error ? { error } : {}),
    stdoutPath,
    stderrPath,
    stdoutSha256: crypto.createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: crypto.createHash("sha256").update(stderr).digest("hex"),
  });
}

function run(command, args, {
  capture = false,
  timeoutMs = 120_000,
  ownershipRecordPath = null,
  powerPointRuntimeReceiptPath = null,
  expectedPowerPointRuntimeProcessCount = 0,
  timeoutStartMarkerPath = null,
  timeoutStartDeadlineMs = 120_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const identity = child.pid ? captureWorkerIdentity(child.pid) : null;
    if (child.pid) activeWorkers.set(child.pid, { ownershipRecordPath, identity });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeoutCleanup = null;
    let workerTermination = null;
    let settled = false;
    let timeoutPhase = null;
    let timeoutLimitMs = timeoutMs;
    let powerPointRuntimeReceipt = null;
    let powerPointRuntimeProcesses = [];
    let runtimeCaptureInFlight = null;
    const attemptRuntimeCapture = async () => {
      if (!ownershipRecordPath || !powerPointRuntimeReceiptPath || runtimeCaptureInFlight) return powerPointRuntimeReceipt;
      runtimeCaptureInFlight = captureOwnedPowerPointRuntime(ownershipRecordPath, powerPointRuntimeReceiptPath, powerPointRuntimeProcesses)
        .catch(() => null)
        .then((value) => {
          if (value) { powerPointRuntimeReceipt = value; powerPointRuntimeProcesses = value.processes; }
          return value;
        })
        .finally(() => { runtimeCaptureInFlight = null; });
      return runtimeCaptureInFlight;
    };
    const runtimeCapturePoll = powerPointRuntimeReceiptPath ? setInterval(() => { void attemptRuntimeCapture(); }, 100) : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (!capture) process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (!capture) process.stderr.write(chunk); });
    const timeoutWorker = (phase, limitMs) => {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutPhase = phase;
      timeoutLimitMs = limitMs;
      const terminationIdentity = identity ?? captureWorkerIdentity(child.pid);
      workerTermination = terminateWorkerOnly(child.pid, terminationIdentity);
      if (ownershipRecordPath) timeoutCleanup = cleanupOwnedPowerPoint(ownershipRecordPath, { root });
    };
    let timer = null;
    let readinessTimer = null;
    let readinessPoll = null;
    if (timeoutStartMarkerPath) {
      readinessTimer = setTimeout(() => timeoutWorker("readiness", timeoutStartDeadlineMs), timeoutStartDeadlineMs);
      readinessPoll = setInterval(() => {
        if (!fsSync.existsSync(timeoutStartMarkerPath)) return;
        clearInterval(readinessPoll);
        readinessPoll = null;
        clearTimeout(readinessTimer);
        readinessTimer = null;
        timer = setTimeout(() => timeoutWorker("execution", timeoutMs), timeoutMs);
      }, 100);
    } else {
      timer = setTimeout(() => timeoutWorker("execution", timeoutMs), timeoutMs);
    }
    const clearRunTimers = () => {
      if (timer) clearTimeout(timer);
      if (readinessTimer) clearTimeout(readinessTimer);
      if (readinessPoll) clearInterval(readinessPoll);
      if (runtimeCapturePoll) clearInterval(runtimeCapturePoll);
    };
    child.once("error", async (error) => {
      if (settled) return;
      settled = true;
      clearRunTimers();
      if (child.pid) activeWorkers.delete(child.pid);
      if (ownershipRecordPath && powerPointRuntimeReceiptPath) await fs.rm(`${ownershipRecordPath}.runtime-captured`, { force: true }).catch(() => {});
      try { await appendCommandReceipt({ command, args, exitCode: null, error: error.message, stdout, stderr }); reject(error); }
      catch (receiptError) { reject(receiptError); }
    });
    child.once("close", async (status, signal) => {
      if (settled) return;
      settled = true;
      clearRunTimers();
      if (child.pid) activeWorkers.delete(child.pid);
      if (runtimeCaptureInFlight) await runtimeCaptureInFlight;
      if (powerPointRuntimeReceiptPath) await attemptRuntimeCapture();
      if (ownershipRecordPath && powerPointRuntimeReceiptPath) await fs.rm(`${ownershipRecordPath}.runtime-captured`, { force: true }).catch(() => {});
      let finalOwnership = null;
      try { if (ownershipRecordPath) finalOwnership = await readJson(ownershipRecordPath); } catch { /* fail below */ }
      const finalIdentityCaptured = finalOwnership && powerPointRuntimeProcesses.some((item) => item.processId === finalOwnership.processId
        && item.processName === finalOwnership.processName && item.processStartTime === finalOwnership.processStartTime);
      if (powerPointRuntimeReceiptPath && (!powerPointRuntimeReceipt || !finalIdentityCaptured
        || powerPointRuntimeProcesses.length !== expectedPowerPointRuntimeProcessCount)) {
        reject(new Error(`Could not bind the live owned PowerPoint executable for ${ownershipRecordPath}.`));
        return;
      }
      try { await appendCommandReceipt({ command, args, exitCode: status, signal: signal ?? null, timedOut, stdout, stderr }); }
      catch (receiptError) { reject(receiptError); return; }
      if (timedOut) {
        const error = new Error(`${command} ${args.join(" ")} exceeded ${timeoutLimitMs} ms during ${timeoutPhase}; exact worker termination: ${JSON.stringify(workerTermination)}; owned-process cleanup: ${JSON.stringify(timeoutCleanup)}.`);
        error.timeoutCleanup = timeoutCleanup;
        error.workerTermination = workerTermination;
        error.workerIdentity = identity;
        reject(error);
      } else if (status !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with ${status ?? signal}\n${stderr}`));
      } else {
        resolve({ status, stdout, stderr, workerIdentity: identity });
      }
    });
  });
}

function failOnWarningOutput(result, label) {
  const warningPattern = /\bwarn(?:ing)?\b/iu;
  if (warningPattern.test(result.stderr) || warningPattern.test(result.stdout)) {
    throw new Error(`${label} emitted a warning:\n${result.stderr || result.stdout}`);
  }
}

async function runChecked(command, args, options = {}) {
  const result = await run(command, args, { ...options, capture: true });
  failOnWarningOutput(result, `${command} ${args.join(" ")}`);
  return result;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function canonicalHash(value) {
  const normalize = (item) => Array.isArray(item)
    ? item.map(normalize)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
      : item;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForExactIdentityExit(identity, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const live = captureWorkerIdentity(identity.processId);
    if (!live || live.processName !== identity.processName || live.processStartTime !== identity.processStartTime) {
      return { valid: true, waitedMs: Date.now() - started, exactIdentityAbsent: true };
    }
    await delay(100);
  }
  return { valid: false, waitedMs: Date.now() - started, exactIdentityAbsent: false };
}

async function waitForPowerPointQuiescence(timeoutMs = 120_000) {
  if (process.platform !== "win32") return { valid: true, waitedMs: 0, polls: 0, reason: "non-windows" };
  const started = Date.now();
  let polls = 0;
  let consecutiveClearPolls = 0;
  let lastPids = [];
  while (Date.now() - started <= timeoutMs) {
    polls += 1;
    const result = await runChecked("powershell", [
      "-NoProfile", "-Command",
      "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0",
    ], { timeoutMs: 10_000 });
    lastPids = result.stdout.trim() ? result.stdout.trim().split(",").map((value) => Number(value)).filter(Number.isInteger) : [];
    if (lastPids.length === 0) {
      consecutiveClearPolls += 1;
      if (consecutiveClearPolls >= 2) return { valid: true, waitedMs: Date.now() - started, polls, reason: "two-consecutive-clear-polls" };
    } else {
      consecutiveClearPolls = 0;
    }
    await delay(1_000);
  }
  return { valid: false, waitedMs: Date.now() - started, polls, reason: "powerpoint-remained-active", lastPids };
}

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not locate presentation tool ${name}.`);
}

function requireNoReportWarnings(report, label) {
  if (!Array.isArray(report.warnings)) throw new Error(`${label} does not expose a warnings array.`);
  if (report.warnings.length > 0) throw new Error(`${label} contains warnings: ${JSON.stringify(report.warnings)}`);
}

function normalizedFilePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workerIntentPath(label) {
  return path.join(output, "worker-intents", `${label}-worker-intent.json`);
}

async function validateWorkerIntent(intentPath, expectedPurpose, ownershipRecordPath, expectedIdentity = null) {
  const intent = await readJson(intentPath);
  const validName = ["powershell", "pwsh"].includes(String(intent.workerProcessName ?? "").toLowerCase());
  const identityMatches = !expectedIdentity || (intent.workerProcessId === expectedIdentity.processId
    && intent.workerProcessName.toLowerCase() === expectedIdentity.processName.toLowerCase()
    && intent.workerProcessStartTime === expectedIdentity.processStartTime);
  if (intent.schemaVersion !== "slidewright-worker-intent/v1"
    || intent.state !== "started"
    || intent.purpose !== expectedPurpose
    || !Number.isInteger(intent.workerProcessId)
    || !validName
    || typeof intent.workerProcessStartTime !== "string"
    || normalizedFilePath(intent.ownershipRecordPath) !== normalizedFilePath(ownershipRecordPath)
    || !identityMatches) {
    throw new Error(`Worker intent is invalid for ${expectedPurpose}.`);
  }
  return {
    schemaVersion: intent.schemaVersion,
    purpose: intent.purpose,
    workerProcessId: intent.workerProcessId,
    workerProcessName: intent.workerProcessName,
    workerProcessStartTime: intent.workerProcessStartTime,
    ownershipRecordPath: intent.ownershipRecordPath,
    sha256: await sha256(intentPath),
  };
}

async function resolvePublishedBaseline(mutationContract, slidesTest) {
  const currentPath = path.join(semanticSurfaceOutput, "current.json");
  let current;
  try {
    current = await readJson(currentPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    throw new Error("C18 requires a current hardened C08 baseline. Close PowerPoint normally, run `npm run semantic-surface`, and rerun `npm run semantic-mutation` after outputs/semantic-surface/current.json is published.");
  }
  if (current.schemaVersion !== "slidewright-semantic-current/v1") throw new Error("C08 current pointer uses an unsupported schema.");
  if (!/^[a-f0-9]{64}$/u.test(current.scorecardHash ?? "")) throw new Error("C08 current pointer has an invalid scorecard hash.");
  if (current.run !== `runs/${current.scorecardHash}`) throw new Error("C08 current pointer is not content-addressed to its declared hash.");
  const runDirectory = path.resolve(semanticSurfaceOutput, current.run);
  const expectedDirectory = path.resolve(semanticSurfaceOutput, "runs", current.scorecardHash);
  if (runDirectory !== expectedDirectory) throw new Error("C08 current pointer escaped its immutable run directory.");
  const sourceScorecardPath = path.join(runDirectory, "scorecard.json");
  const sourceScorecard = await readJson(sourceScorecardPath);
  const baselineContractPath = path.resolve(root, mutationContract.baselineContract.path);
  const relativeContract = path.relative(root, baselineContractPath);
  if (relativeContract.startsWith("..") || path.isAbsolute(relativeContract)) throw new Error("Mutation baseline contract escaped the repository root.");
  const baselineContractSha256 = await sha256(baselineContractPath);
  if (baselineContractSha256 !== mutationContract.baselineContract.sha256) {
    throw new Error("Mutation contract baseline SHA does not match the declared semantic contract.");
  }
  const scorecardForHash = { ...sourceScorecard };
  delete scorecardForHash.scorecardHash;
  const computedScorecardHash = canonicalHash(scorecardForHash);
  if (sourceScorecard.schemaVersion !== "slidewright-semantic-surface-scorecard/v2"
    || sourceScorecard.contractSha256 !== baselineContractSha256
    || !sourceScorecard.valid
    || sourceScorecard.scorecardHash !== current.scorecardHash
    || computedScorecardHash !== current.scorecardHash) {
    throw new Error("C08 current pointer does not resolve to a valid, hash-authenticated scorecard.");
  }
  await verifySemanticSurfaceEvidence({ root, runDirectory, python, slidesTest, requireCurrentGit: false });
  const sourceBaseline = path.join(runDirectory, "powerpoint-roundtrip.pptx");
  const sourceBaselineSha256 = await sha256(sourceBaseline);
  if (sourceScorecard.powerpoint?.roundtripPptxSha256 !== sourceBaselineSha256) {
    throw new Error("C08 PowerPoint-normalized baseline is not bound to the current scorecard.");
  }
  return {
    currentPath,
    current,
    sourceScorecardPath,
    sourceScorecard,
    runDirectory,
    sourceBaseline,
    sourceBaselineSha256,
    baselineContractPath,
    baselineContractSha256,
  };
}

const mutationContract = await readJson(mutationContractPath);
if (mutationContract.schemaVersion !== "slidewright-semantic-mutation/v1") throw new Error("Unsupported C18 mutation contract.");
if (mutationContract.realPowerPointRequired !== true || mutationContract.saveReopenRequired !== true) {
  throw new Error("C18 contract must require real PowerPoint save/reopen evidence.");
}
if (!Array.isArray(mutationContract.cases) || mutationContract.cases.length !== 5 || new Set(mutationContract.cases.map((item) => item.id)).size !== 5) {
  throw new Error("C18 contract must declare exactly five unique isolated mutation cases.");
}
if (!Array.isArray(mutationContract.negativeControls) || mutationContract.negativeControls.length !== 9) {
  throw new Error("C18 contract must declare exactly nine destructive controls.");
}

const gitBefore = captureCleanGit(root);
const implementationBefore = await captureSemanticMutationImplementation(root);
const slidesTest = await findPresentationTool("slides_test.py");
const sourceBinding = await resolvePublishedBaseline(mutationContract, slidesTest);
await fs.mkdir(publishedRuns, { recursive: true });
await fs.mkdir(output, { recursive: true });
for (const relative of SEMANTIC_MUTATION_IMPLEMENTATION_PATHS) {
  const snapshot = path.join(output, "implementation-snapshot", ...relative.split("/"));
  await fs.mkdir(path.dirname(snapshot), { recursive: true });
  await fs.copyFile(path.join(root, ...relative.split("/")), snapshot, fs.constants.COPYFILE_EXCL);
}
await fs.copyFile(sourceBinding.sourceBaseline, baselinePptx, fs.constants.COPYFILE_EXCL);
const copiedBaselineSha256 = await sha256(baselinePptx);
if (copiedBaselineSha256 !== sourceBinding.sourceBaselineSha256) throw new Error("Immutable baseline copy changed bytes.");
await writeJson(path.join(output, "source-binding.json"), {
  schemaVersion: "slidewright-semantic-mutation-source-binding/v1",
  valid: true,
  semanticSurfaceScorecardHash: sourceBinding.current.scorecardHash,
  semanticSurfaceScorecardSha256: await sha256(sourceBinding.sourceScorecardPath),
  baselineSourceRun: sourceBinding.current.run,
  baselineSourcePptxSha256: sourceBinding.sourceBaselineSha256,
  copiedBaselinePptxSha256: copiedBaselineSha256,
  mutationContractSha256: await sha256(mutationContractPath),
  baselineContractSha256: sourceBinding.baselineContractSha256,
});

const runnerWatchdog = await startRunnerWatchdog({
  root,
  stagingDir: output,
  watchdogScript,
  cleanupScript: path.join(semantic, "cleanup_owned_powerpoint.ps1"),
  completionMarker: watchdogCompletionMarker,
  readyMarker: watchdogReadyMarker,
  recoveryReport: watchdogRecoveryReport,
  diagnosticLog: watchdogDiagnosticLog,
});
const normalWatchdogDir = path.join(output, "watchdog", "normal");
await fs.mkdir(normalWatchdogDir, { recursive: true });
await fs.copyFile(`${watchdogDiagnosticLog}.identity.json`, path.join(normalWatchdogDir, "identity-receipt.json"));
await fs.copyFile(watchdogReadyMarker, path.join(normalWatchdogDir, "ready.marker"));
const initialQuiescence = await waitForPowerPointQuiescence();
await writeJson(path.join(output, "powerpoint-quiescence.json"), initialQuiescence);
if (!initialQuiescence.valid) {
  throw new Error(`PowerPoint did not become quiescent within two minutes. Refusing to attach to or alter the active session. Active PIDs: ${(initialQuiescence.lastPids ?? []).join(", ")}`);
}

const workerIntents = [];
// Prove that worker timeout cleanup is presentation-aware and never force-kills PowerPoint.
const timeoutProbeRecordPath = path.join(output, "powerpoint-timeout-probe-ownership.json");
const timeoutProbeIntentPath = workerIntentPath("powerpoint-timeout-probe");
const timeoutProbeReadyPath = path.join(output, "powerpoint-timeout-probe.ready");
let timeoutProbeRejected = false;
let timeoutProbeError = "";
let timeoutProbeFirstCleanup = null;
let timeoutProbeWorkerIdentity = null;
try {
  await runChecked("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(semantic, "powerpoint_timeout_probe.ps1"),
    "-OwnershipRecordJson", timeoutProbeRecordPath,
    "-WorkerIntentJson", timeoutProbeIntentPath,
    "-ReadyMarker", timeoutProbeReadyPath,
    "-HoldSeconds", "120",
  ], {
    timeoutMs: 5_000,
    timeoutStartMarkerPath: timeoutProbeReadyPath,
    timeoutStartDeadlineMs: 120_000,
    ownershipRecordPath: timeoutProbeRecordPath,
    powerPointRuntimeReceiptPath: path.join(output, "powerpoint-runtime", "timeout-probe.json"),
    expectedPowerPointRuntimeProcessCount: 1,
  });
} catch (error) {
  timeoutProbeError = error.message;
  timeoutProbeFirstCleanup = error.timeoutCleanup ?? null;
  timeoutProbeWorkerIdentity = error.workerIdentity ?? null;
  timeoutProbeRejected = /exceeded 5000 ms during execution/u.test(timeoutProbeError);
}
workerIntents.push({ stage: "timeout-probe", ...await validateWorkerIntent(timeoutProbeIntentPath, "timeout-cleanup-negative-control", timeoutProbeRecordPath, timeoutProbeWorkerIdentity) });
const timeoutProbePostCleanup = cleanupOwnedPowerPoint(timeoutProbeRecordPath, { root });
let timeoutProbeOwnershipHash = null;
try { timeoutProbeOwnershipHash = await sha256(timeoutProbeRecordPath); } catch { /* invalid below */ }
let timeoutProbeReadyHash = null;
try { timeoutProbeReadyHash = await sha256(timeoutProbeReadyPath); } catch { /* invalid below */ }
const timeoutCleanupControl = {
  valid: timeoutProbeRejected
    && /^[a-f0-9]{64}$/u.test(timeoutProbeReadyHash ?? "")
    && timeoutProbeFirstCleanup?.valid === true
    && timeoutProbeFirstCleanup?.cleaned === true
    && ["owned-process-already-exited", "owned-process-exited-after-com-release", "owned-headless-automation-process-exited-after-quit", "owned-headless-automation-process-exited-after-wm-quit"].includes(timeoutProbeFirstCleanup?.reason)
    && timeoutProbePostCleanup.valid
    && timeoutProbePostCleanup.reason === "owned-process-already-exited",
  workerTimedOut: timeoutProbeRejected,
  firstCleanup: timeoutProbeFirstCleanup,
  ownedProcessAbsentAfterFirstCleanup: timeoutProbeFirstCleanup?.valid === true && timeoutProbeFirstCleanup?.cleaned === true,
  ownedProcessAbsentAfterCleanup: timeoutProbePostCleanup.valid && timeoutProbePostCleanup.reason === "owned-process-already-exited",
  ownershipRecordSha256: timeoutProbeOwnershipHash,
  readyMarkerSha256: timeoutProbeReadyHash,
  postCleanup: timeoutProbePostCleanup,
  errorSha256: crypto.createHash("sha256").update(timeoutProbeError).digest("hex"),
};
await writeJson(path.join(output, "powerpoint-timeout-cleanup-control.json"), timeoutCleanupControl);
if (!timeoutCleanupControl.valid) throw new Error(`PowerPoint timeout cleanup control failed: ${JSON.stringify(timeoutCleanupControl)}`);

await fs.mkdir(mutationOutputDir, { recursive: true });
const mutationIntentPath = workerIntentPath("powerpoint-native-mutation");
const mutationRun = await runChecked("powershell", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", mutationWorkerScript,
  "-InputPptx", baselinePptx,
  "-ContractJson", mutationContractPath,
  "-OutputDir", mutationOutputDir,
  "-ReportJson", mutationReportPath,
  "-OwnershipRecordJson", mutationOwnershipPath,
  "-WorkerIntentJson", mutationIntentPath,
], { timeoutMs: 600_000, ownershipRecordPath: mutationOwnershipPath, powerPointRuntimeReceiptPath: path.join(output, "powerpoint-runtime", "native-mutation.json"), expectedPowerPointRuntimeProcessCount: 1 });
workerIntents.push({ stage: "native-mutation", ...await validateWorkerIntent(mutationIntentPath, "semantic-native-object-mutation", mutationOwnershipPath, mutationRun.workerIdentity) });

const interStagePowerPointQuiescence = [];
const afterMutationQuiescence = await waitForPowerPointQuiescence();
interStagePowerPointQuiescence.push({ stage: "after-native-mutation", ...afterMutationQuiescence });
if (!afterMutationQuiescence.valid) throw new Error("PowerPoint did not exit naturally after native mutations.");

const mutationReport = await readJson(mutationReportPath);
if (!mutationReport.valid
  || mutationReport.application !== "Microsoft PowerPoint"
  || mutationReport.baselineSha256 !== copiedBaselineSha256
  || mutationReport.mutationContractSha256 !== await sha256(mutationContractPath)) {
  throw new Error("PowerPoint mutation report is not valid or source-bound.");
}
if (mutationReport.cases.length !== mutationContract.cases.length) throw new Error("PowerPoint mutation report does not contain all five cases.");
const mutationOwnership = await readJson(mutationOwnershipPath);
const expectedOwnedPaths = [baselinePptx, ...mutationContract.cases.map((item) => path.join(mutationOutputDir, `${item.id}.pptx`))]
  .map(normalizedFilePath)
  .sort();
const actualOwnedPaths = Array.isArray(mutationOwnership.ownedPresentationPaths)
  ? mutationOwnership.ownedPresentationPaths.map(normalizedFilePath).sort()
  : [];
const mutationOwnershipValid = mutationOwnership.schemaVersion === "slidewright-owned-powerpoint/v1"
  && mutationOwnership.processName === "POWERPNT"
  && mutationOwnership.processId === mutationReport.processId
  && mutationOwnership.processStartTime === mutationReport.processStartTime
  && mutationOwnership.purpose === "semantic-native-object-mutation"
  && mutationOwnership.expectedApplicationVisible === false
  && Number.isInteger(mutationOwnership.workerProcessId)
  && ["powershell", "pwsh"].includes(String(mutationOwnership.workerProcessName ?? "").toLowerCase())
  && typeof mutationOwnership.workerProcessStartTime === "string"
  && actualOwnedPaths.length === expectedOwnedPaths.length
  && actualOwnedPaths.every((item, index) => item === expectedOwnedPaths[index]);
if (!mutationOwnershipValid) throw new Error("PowerPoint mutation ownership record is incomplete or does not match the worker report and allowlist.");

const decks = [
  { id: "powerpoint-normalized-baseline", pptx: baselinePptx },
  ...mutationContract.cases.map((item) => ({ id: item.id, pptx: path.join(mutationOutputDir, `${item.id}.pptx`) })),
];
const renderEvidence = [];
for (const deck of decks) {
  const renderDir = path.join(output, "renders", deck.id);
  const renderReportPath = path.join(output, "renders", `${deck.id}.json`);
  const renderOwnershipPath = path.join(output, "renders", `${deck.id}-ownership.json`);
  const renderIntentPath = workerIntentPath(`render-${deck.id}`);
  const renderRun = await runChecked("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", isolatedRenderScript,
    "-InputPptx", deck.pptx,
    "-OutputDir", renderDir,
    "-ReportJson", renderReportPath,
    "-OwnershipRecordJson", renderOwnershipPath,
    "-WorkerIntentJson", renderIntentPath,
  ], { timeoutMs: 600_000, ownershipRecordPath: renderOwnershipPath, powerPointRuntimeReceiptPath: path.join(output, "powerpoint-runtime", `render-${deck.id}.json`), expectedPowerPointRuntimeProcessCount: 5 });
  workerIntents.push({ stage: `render-${deck.id}`, ...await validateWorkerIntent(renderIntentPath, "isolated-powerpoint-render", renderOwnershipPath, renderRun.workerIdentity) });
  const quiescence = await waitForPowerPointQuiescence();
  interStagePowerPointQuiescence.push({ stage: `after-render-${deck.id}`, ...quiescence });
  if (!quiescence.valid) throw new Error(`PowerPoint did not exit naturally after rendering ${deck.id}.`);
  const report = await readJson(renderReportPath);
  if (!report.valid || !report.allSessionsOwned || report.slideCount !== 4 || report.inputSha256 !== await sha256(deck.pptx)) {
    throw new Error(`PowerPoint render evidence is invalid for ${deck.id}.`);
  }
  if (report.renders.some((item) => item.width !== 1600 || item.height !== 900 || !item.sha256 || !item.reviewSha256)) {
    throw new Error(`Full-size review artifacts are incomplete for ${deck.id}.`);
  }
  renderEvidence.push({
    id: deck.id,
    valid: report.valid,
    inputSha256: report.inputSha256,
    slideCount: report.slideCount,
    allSessionsOwned: report.allSessionsOwned,
    isolation: report.isolation,
    sessions: report.sessions,
    ownershipRecordSha256: await sha256(renderOwnershipPath),
    renderReportSha256: await sha256(renderReportPath),
    renders: report.renders,
  });
}

const renderedHeaderContractPath = path.join(output, "rendered-header-contract.json");
const renderedHeaderReportPath = path.join(output, "rendered-header-evidence.json");
const renderedHeaderReferenceRoot = path.join(output, "rendered-header-reference");
const sourceRoundtripRenderReport = await readJson(path.join(sourceBinding.runDirectory, "powerpoint-roundtrip-render.json"));
const sourceReference = sourceRoundtripRenderReport.renders?.find((item) => item.slide === 1);
if (sourceRoundtripRenderReport.valid !== true || !sourceReference?.file || !sourceReference?.reviewFile) {
  throw new Error("C18 could not bind an immutable C08 rendered-header reference.");
}
await fs.mkdir(renderedHeaderReferenceRoot, { recursive: true });
for (const file of [sourceReference.file, sourceReference.reviewFile]) {
  await fs.copyFile(path.join(sourceBinding.runDirectory, "powerpoint-roundtrip-render", file), path.join(renderedHeaderReferenceRoot, file), fs.constants.COPYFILE_EXCL);
}
if (await sha256(path.join(renderedHeaderReferenceRoot, sourceReference.file)) !== sourceReference.sha256
  || await sha256(path.join(renderedHeaderReferenceRoot, sourceReference.reviewFile)) !== sourceReference.reviewSha256) {
  throw new Error("C18 rendered-header reference bytes drifted while copying the C08 proof.");
}
await writeJson(renderedHeaderContractPath, {
  schemaVersion: "slidewright-rendered-header-contract/v1",
  reference: {
    semanticSurfaceScorecardHash: sourceBinding.current.scorecardHash,
    file: sourceReference.file,
    sha256: sourceReference.sha256,
    reviewFile: sourceReference.reviewFile,
    reviewSha256: sourceReference.reviewSha256,
  },
  decks: renderEvidence.map((deck) => ({
    id: deck.id,
    renders: deck.renders.map((render) => ({
      slide: render.slide,
      file: render.file,
      sha256: render.sha256,
      reviewFile: render.reviewFile,
      reviewSha256: render.reviewSha256,
    })),
  })),
});
await runChecked(python, [
  renderedHeaderAuditScript,
  "--contract", renderedHeaderContractPath,
  "--renders-root", path.join(output, "renders"),
  "--reference-renders-root", renderedHeaderReferenceRoot,
  "--json", renderedHeaderReportPath,
]);
const renderedHeaderEvidence = await readJson(renderedHeaderReportPath);
requireNoReportWarnings(renderedHeaderEvidence, "C18 rendered-header visibility audit");
if (renderedHeaderEvidence.schemaVersion !== "slidewright-rendered-header-evidence/v1"
  || renderedHeaderEvidence.valid !== true
  || renderedHeaderEvidence.contractSha256 !== await sha256(renderedHeaderContractPath)
  || renderedHeaderEvidence.imageCount !== 48
  || renderedHeaderEvidence.records?.length !== 48
  || renderedHeaderEvidence.reference?.png?.decodedPrefixSha256 !== renderedHeaderEvidence.sharedPrefixHashes?.png?.[0]
  || renderedHeaderEvidence.reference?.jpeg?.decodedPrefixSha256 !== renderedHeaderEvidence.sharedPrefixHashes?.jpeg?.[0]
  || renderedHeaderEvidence.negativeControls?.length !== 4
  || renderedHeaderEvidence.negativeControls.some((item) => item.rejected !== true || item.failureChecks?.length < 1)
  || renderedHeaderEvidence.failures?.length !== 0) {
  throw new Error("C18 rendered-header visibility evidence is incomplete.");
}
validateRenderedHeaderNegativeControls(renderedHeaderEvidence.negativeControls);

const renderEvidenceDir = path.join(output, "render-evidence");
const renderMeasurements = [];
for (const mutationCase of mutationContract.cases) {
  const variantPptx = path.join(mutationOutputDir, `${mutationCase.id}.pptx`);
  const slideTwoPng = path.join(output, "renders", mutationCase.id, "slide-02.png");
  const evidencePath = path.join(renderEvidenceDir, `${mutationCase.id}.json`);
  await runChecked(python, [
    mutationAuditScript,
    baselinePptx,
    variantPptx,
    mutationContractPath,
    "--case", mutationCase.id,
    "--baseline-contract", sourceBinding.baselineContractPath,
    "--powerpoint-report", mutationReportPath,
    "--measure-render", slideTwoPng,
    "--json", evidencePath,
  ]);
  const evidence = await readJson(evidencePath);
  requireNoReportWarnings(evidence, `C18 render measurement ${mutationCase.id}`);
  const variantSha256 = await sha256(variantPptx);
  const renderPngSha256 = await sha256(slideTwoPng);
  if (evidence.schemaVersion !== "slidewright-semantic-mutation-render-evidence/v1"
    || evidence.valid !== true
    || evidence.caseId !== mutationCase.id
    || evidence.inputPptxSha256 !== variantSha256
    || evidence.renderPngSha256 !== renderPngSha256
    || evidence.slide !== 2
    || evidence.width !== 1600
    || evidence.height !== 900
    || !Array.isArray(evidence.charts)
    || evidence.charts.length !== 2) {
    throw new Error(`C18 render-derived readability evidence is invalid for ${mutationCase.id}.`);
  }
  renderMeasurements.push({
    id: mutationCase.id,
    valid: evidence.valid,
    variantSha256,
    renderPngSha256,
    evidenceSha256: await sha256(evidencePath),
    charts: evidence.charts,
    warnings: evidence.warnings,
  });
}

const auditReports = [];
for (const mutationCase of mutationContract.cases) {
  const variantPptx = path.join(mutationOutputDir, `${mutationCase.id}.pptx`);
  const evidencePath = path.join(renderEvidenceDir, `${mutationCase.id}.json`);
  const auditPath = path.join(output, "audits", `${mutationCase.id}.json`);
  await runChecked(python, [
    mutationAuditScript,
    baselinePptx,
    variantPptx,
    mutationContractPath,
    "--case", mutationCase.id,
    "--baseline-contract", sourceBinding.baselineContractPath,
    "--powerpoint-report", mutationReportPath,
    "--render-evidence", evidencePath,
    "--json", auditPath,
  ]);
  const report = await readJson(auditPath);
  requireNoReportWarnings(report, `C18 audit ${mutationCase.id}`);
  if (!report.valid || report.caseId !== mutationCase.id) throw new Error(`C18 structural/readability audit failed for ${mutationCase.id}.`);
  auditReports.push({
    id: mutationCase.id,
    valid: report.valid,
    variantSha256: await sha256(variantPptx),
    renderEvidenceSha256: await sha256(evidencePath),
    reportSha256: await sha256(auditPath),
    sourceBinding: report.sourceBinding,
    checks: report.checks,
    summary: report.summary,
    readability: report.readability,
    warnings: report.warnings,
  });
}

const negativeReportPath = path.join(output, "negative-controls.json");
const negativeOutputDir = path.join(output, "negative-controls");
await runChecked(python, [
  negativeControlsScript,
  baselinePptx,
  mutationOutputDir,
  mutationContractPath,
  sourceBinding.baselineContractPath,
  mutationReportPath,
  renderEvidenceDir,
  negativeOutputDir,
  "--audit-script", mutationAuditScript,
  "--json", negativeReportPath,
], { timeoutMs: 300_000 });
const negativeControls = await readJson(negativeReportPath);
if (!negativeControls.valid || !Array.isArray(negativeControls.controls)) throw new Error("C18 destructive-control harness failed.");
const actualControlIds = negativeControls.controls.map((item) => item.id);
if (actualControlIds.length !== mutationContract.negativeControls.length
  || actualControlIds.some((item, index) => item !== mutationContract.negativeControls[index])
  || negativeControls.controls.some((item) => !item.rejected || !Array.isArray(item.failureCodes) || item.failureCodes.length === 0)) {
  throw new Error("C18 destructive controls did not reject the exact nine contracted defects.");
}
for (const control of negativeControls.controls) {
  const controlAuditPath = path.join(negativeOutputDir, control.id, "audit.json");
  const controlAudit = await readJson(controlAuditPath);
  requireNoReportWarnings(controlAudit, `C18 negative-control audit ${control.id}`);
  control.auditReportSha256 = await sha256(controlAuditPath);
}

const overflowChecks = [];
for (const deck of decks) {
  const result = await runChecked(python, [slidesTest, deck.pptx], { timeoutMs: 120_000 });
  const reportPath = path.join(output, "overflow", `${deck.id}.json`);
  const report = {
    schemaVersion: "slidewright-semantic-mutation-overflow/v1",
    valid: result.status === 0,
    target: deck.id,
    inputSha256: await sha256(deck.pptx),
    command: "slides_test.py",
    exitCode: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    warnings: [],
  };
  await writeJson(reportPath, report);
  overflowChecks.push({ target: deck.id, valid: report.valid, inputSha256: report.inputSha256, reportSha256: await sha256(reportPath) });
}

await writeJson(path.join(output, "powerpoint-interstage-quiescence.json"), {
  schemaVersion: "slidewright-powerpoint-quiescence-checkpoints/v1",
  valid: interStagePowerPointQuiescence.length === 7 && interStagePowerPointQuiescence.every((item) => item.valid),
  checkpoints: interStagePowerPointQuiescence,
});

const finalPowerPointQuiescence = await waitForPowerPointQuiescence();
if (!finalPowerPointQuiescence.valid || activeWorkers.size !== 0) throw new Error("C18 final process quiescence failed before watchdog completion.");
const finalWatchdogIdentity = captureWorkerIdentity(runnerWatchdog.processId);
const exactWatchdogIdentityPreserved = Boolean(finalWatchdogIdentity
  && finalWatchdogIdentity.processId === runnerWatchdog.processId
  && finalWatchdogIdentity.processName === runnerWatchdog.processName
  && finalWatchdogIdentity.processStartTime === runnerWatchdog.processStartTime);
let normalRecoveryReportAbsent = false;
try { await fs.access(watchdogRecoveryReport); } catch (error) { if (error?.code === "ENOENT") normalRecoveryReportAbsent = true; else throw error; }
if (!exactWatchdogIdentityPreserved || !normalRecoveryReportAbsent) throw new Error("C18 normal watchdog identity or recovery state drifted before completion.");
await fs.writeFile(watchdogCompletionMarker, "complete\n", "utf8");
await fs.copyFile(watchdogCompletionMarker, path.join(normalWatchdogDir, "completion.marker"));
const watchdogExit = await waitForExactIdentityExit(runnerWatchdog, 15_000);
let recoveryReportAbsentAfterExit = false;
try { await fs.access(watchdogRecoveryReport); } catch (error) { if (error?.code === "ENOENT") recoveryReportAbsentAfterExit = true; else throw error; }
if (!watchdogExit.valid || !recoveryReportAbsentAfterExit) throw new Error("C18 normal watchdog did not exit cleanly without a recovery report.");
try { await fs.copyFile(watchdogDiagnosticLog, path.join(normalWatchdogDir, "diagnostic.log")); }
catch (error) { if (error?.code === "ENOENT") await fs.writeFile(path.join(normalWatchdogDir, "diagnostic.log"), "", "utf8"); else throw error; }
const normalIdentityReceipt = await readJson(path.join(normalWatchdogDir, "identity-receipt.json"));
const normalReadyText = (await fs.readFile(path.join(normalWatchdogDir, "ready.marker"), "utf8")).replace(/^\uFEFF/u, "").trim();
const normalCompletionText = await fs.readFile(path.join(normalWatchdogDir, "completion.marker"), "utf8");
const normalWatchdog = {
  schemaVersion: "slidewright-watchdog-normal-run/v1",
  valid: runnerWatchdog.enabled === true
    && exactWatchdogIdentityPreserved
    && normalRecoveryReportAbsent
    && watchdogExit.valid
    && recoveryReportAbsentAfterExit
    && finalPowerPointQuiescence.valid
    && activeWorkers.size === 0
    && normalIdentityReceipt.schemaVersion === "slidewright-runner-watchdog-identity/v1"
    && normalIdentityReceipt.processId === runnerWatchdog.processId
    && normalIdentityReceipt.processName === runnerWatchdog.processName
    && normalIdentityReceipt.processStartTime === runnerWatchdog.processStartTime
    && await sha256File(path.join(normalWatchdogDir, "identity-receipt.json")) === runnerWatchdog.identityReceiptSha256
    && await sha256File(path.join(normalWatchdogDir, "ready.marker")) === runnerWatchdog.readyMarkerSha256
    && normalReadyText === "ready"
    && normalCompletionText === "complete\n",
  startup: runnerWatchdog,
  finalIdentity: finalWatchdogIdentity,
  exactIdentityPreservedAtFinalization: exactWatchdogIdentityPreserved,
  watchdogExit,
  watchdogProcessAbsentAfterCompletion: watchdogExit.exactIdentityAbsent,
  finalPowerPointQuiescence,
  activeWorkerCount: activeWorkers.size,
  recoveryReportAbsent: normalRecoveryReportAbsent,
  recoveryReportAbsentAfterExit,
  identityReceiptExact: normalIdentityReceipt.schemaVersion === "slidewright-runner-watchdog-identity/v1"
    && normalIdentityReceipt.processId === runnerWatchdog.processId
    && normalIdentityReceipt.processName === runnerWatchdog.processName
    && normalIdentityReceipt.processStartTime === runnerWatchdog.processStartTime,
  readyMarkerExact: normalReadyText === "ready",
  completionMarkerExact: normalCompletionText === "complete\n",
  identityReceiptSha256: await sha256File(path.join(normalWatchdogDir, "identity-receipt.json")),
  readyMarkerSha256: await sha256File(path.join(normalWatchdogDir, "ready.marker")),
  completionMarkerSha256: await sha256File(path.join(normalWatchdogDir, "completion.marker")),
  diagnosticLogSha256: await sha256File(path.join(normalWatchdogDir, "diagnostic.log")),
};
await writeJson(path.join(normalWatchdogDir, "summary.json"), normalWatchdog);
validateNormalWatchdogEvidence({
  summary: normalWatchdog,
  identityReceipt: normalIdentityReceipt,
  readyText: await fs.readFile(path.join(normalWatchdogDir, "ready.marker"), "utf8"),
  completionText: normalCompletionText,
  diagnosticSha256: normalWatchdog.diagnosticLogSha256,
});
if (!normalWatchdog.valid) throw new Error("C18 normal watchdog completion proof is invalid.");

await writeJson(path.join(output, "command-log.json"), {
  schemaVersion: "slidewright-command-receipts/v1",
  logicalCommand: "npm run semantic-mutation",
  commands: commandReceipts,
});
const gitAfter = captureCleanGit(root);
const implementationAfter = await captureSemanticMutationImplementation(root);
if (gitAfter.commit !== gitBefore.commit || canonicalHash(implementationAfter) !== canonicalHash(implementationBefore)) {
  throw new Error("C18 Git commit or implementation closure changed during the run.");
}
const runtimeBindings = await captureSemanticMutationRuntime({ root, python, slidesTest });
const receipts = await collectReceiptTree(output);
const powerPointRuntimeReceipts = [
  { stage: "timeout-probe", path: "powerpoint-runtime/timeout-probe.json" },
  { stage: "native-mutation", path: "powerpoint-runtime/native-mutation.json" },
  ...decks.map((deck) => ({ stage: `render-${deck.id}`, path: `powerpoint-runtime/render-${deck.id}.json` })),
];
for (const item of powerPointRuntimeReceipts) item.sha256 = await sha256(path.join(output, ...item.path.split("/")));

const sourceBindingReport = await readJson(path.join(output, "source-binding.json"));
const currentAtFinalize = await readJson(path.join(semanticSurfaceOutput, "current.json"));
if (currentAtFinalize.scorecardHash !== sourceBinding.current.scorecardHash
  || currentAtFinalize.run !== sourceBinding.current.run) {
  throw new Error("C08 current pointer changed during C18; refusing to publish evidence against a superseded baseline.");
}
const scorecard = {
  schemaVersion: "slidewright-semantic-mutation-scorecard/v2",
  valid: false,
  provenance: {
    git: { commit: gitBefore.commit, cleanBefore: gitBefore.clean, cleanAfter: gitAfter.clean, sameCommit: gitBefore.commit === gitAfter.commit },
    logicalCommand: "npm run semantic-mutation",
    implementation: implementationBefore,
    runtime: runtimeBindings,
  },
  receipts,
  scope: mutationContract.scope,
  sourceBinding: sourceBindingReport,
  mutationContractSha256: await sha256(mutationContractPath),
  baselineContractSha256: sourceBinding.baselineContractSha256,
  baselinePptxSha256: copiedBaselineSha256,
  watchdog: { normal: normalWatchdog },
  initialPowerPointQuiescence: initialQuiescence,
  interStagePowerPointQuiescence,
  timeoutCleanupControl,
  powerPointRuntimeReceipts,
  powerPointRuntimeReceiptsValid: powerPointRuntimeReceipts.length === 8 && powerPointRuntimeReceipts.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)),
  workerIntents,
  workerIntentsValid: workerIntents.length === 8 && workerIntents.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)),
  nativePowerPointMutation: {
    valid: mutationReport.valid,
    automationProcessOwned: mutationOwnershipValid,
    application: mutationReport.application,
    version: mutationReport.version,
    build: mutationReport.build,
    baselineSha256: mutationReport.baselineSha256,
    ownershipRecordSha256: await sha256(mutationOwnershipPath),
    reportSha256: await sha256(mutationReportPath),
    saveReopenCases: mutationReport.cases.map((item) => ({ id: item.id, sha256: item.sha256, afterSaveReopen: item.afterSaveReopen })),
  },
  renderMeasurements,
  renderMeasurementsValid: renderMeasurements.length === 5
    && renderMeasurements.every((item, index) => item.id === mutationContract.cases[index].id
      && item.valid
      && item.warnings.length === 0
      && /^[a-f0-9]{64}$/u.test(item.evidenceSha256)
      && item.charts.length === 2),
  mutationAudits: auditReports,
  mutationAuditsValid: auditReports.length === 5
    && auditReports.every((item, index) => item.id === mutationContract.cases[index].id
      && item.valid
      && item.warnings.length === 0
      && item.renderEvidenceSha256 === renderMeasurements[index]?.evidenceSha256),
  negativeControls: negativeControls.controls.map((item) => ({
    id: item.id,
    rejected: item.rejected,
    failureCodes: item.failureCodes,
    failureCount: item.failureCount,
    artifactSha256: item.artifactSha256,
    contractSha256: item.contractSha256,
    powerPointReportSha256: item.powerPointReportSha256,
    renderEvidenceSha256: item.renderEvidenceSha256,
    auditReportSha256: item.auditReportSha256,
  })),
  negativeControlsReportSha256: await sha256(negativeReportPath),
  negativeControlsValid: negativeControls.valid,
  overflowChecks,
  overflowChecksValid: overflowChecks.length === 6 && overflowChecks.every((item) => item.valid),
  renderEvidence,
  renderedHeaderVisibility: {
    valid: renderedHeaderEvidence.valid,
    contractSha256: await sha256(renderedHeaderContractPath),
    reportSha256: await sha256(renderedHeaderReportPath),
    imageCount: renderedHeaderEvidence.imageCount,
    sharedPrefixHashes: renderedHeaderEvidence.sharedPrefixHashes,
    negativeControls: renderedHeaderEvidence.negativeControls,
  },
  renderedHeaderVisibilityValid: renderedHeaderEvidence.valid === true
    && renderedHeaderEvidence.imageCount === 48
    && renderedHeaderEvidence.records.length === 48
    && validateRenderedHeaderNegativeControls(renderedHeaderEvidence.negativeControls),
  visualReviewRequiredDecks: mutationContract.visualReview.requiredDecks,
  reviewArtifactsReady: mutationContract.visualReview.inspectEverySlideAtFullSize === true
    && renderEvidence.length === 6
    && renderEvidence.every((item, index) => item.id === mutationContract.visualReview.requiredDecks[index]
      && item.valid
      && item.slideCount === 4
      && item.renders.length === 4
      && item.renders.every((render) => render.width === 1600 && render.height === 900 && render.sha256 && render.reviewSha256)),
  warnings: [],
};
scorecard.valid = scorecard.sourceBinding.valid
  && scorecard.sourceBinding.semanticSurfaceScorecardHash === sourceBinding.current.scorecardHash
  && scorecard.sourceBinding.baselineSourcePptxSha256 === scorecard.baselinePptxSha256
  && scorecard.provenance.git.cleanBefore
  && scorecard.provenance.git.cleanAfter
  && scorecard.provenance.git.sameCommit
  && scorecard.provenance.implementation.sha256 === implementationAfter.sha256
  && scorecard.receipts.files.length > 0
  && /^[a-f0-9]{64}$/u.test(scorecard.receipts.treeSha256)
  && (process.platform !== "win32" || scorecard.watchdog.normal.valid)
  && scorecard.initialPowerPointQuiescence.valid
  && scorecard.interStagePowerPointQuiescence.length === 7
  && scorecard.interStagePowerPointQuiescence.every((item) => item.valid)
  && scorecard.timeoutCleanupControl.valid
  && scorecard.powerPointRuntimeReceiptsValid
  && scorecard.workerIntentsValid
  && scorecard.nativePowerPointMutation.valid
  && scorecard.nativePowerPointMutation.automationProcessOwned
  && scorecard.nativePowerPointMutation.application === "Microsoft PowerPoint"
  && scorecard.nativePowerPointMutation.baselineSha256 === scorecard.baselinePptxSha256
  && scorecard.nativePowerPointMutation.saveReopenCases.length === 5
  && scorecard.nativePowerPointMutation.saveReopenCases.every((item, index) => item.id === mutationContract.cases[index].id
    && item.sha256 === scorecard.mutationAudits[index]?.variantSha256)
  && scorecard.renderMeasurementsValid
  && scorecard.mutationAuditsValid
  && scorecard.negativeControls.length === 9
  && scorecard.negativeControlsValid
  && scorecard.negativeControls.every((item) => item.rejected
    && item.failureCodes.length > 0
    && /^[a-f0-9]{64}$/u.test(item.artifactSha256)
    && /^[a-f0-9]{64}$/u.test(item.contractSha256)
    && /^[a-f0-9]{64}$/u.test(item.powerPointReportSha256)
    && /^[a-f0-9]{64}$/u.test(item.renderEvidenceSha256)
    && /^[a-f0-9]{64}$/u.test(item.auditReportSha256))
  && scorecard.overflowChecksValid
  && scorecard.renderedHeaderVisibilityValid
  && scorecard.reviewArtifactsReady
  && scorecard.warnings.length === 0;
scorecard.scorecardHash = canonicalHash(scorecard);
await writeJson(path.join(output, "scorecard.json"), scorecard);
if (!scorecard.valid) throw new Error("C18 semantic-mutation scorecard is incomplete.");
await verifySemanticMutationEvidence({ root, runDirectory: output, python, slidesTest, requireSourceCurrent: true });
await publishSemanticMutationEvidence({
  staging: output,
  published: publishedOutput,
  scorecardHash: scorecard.scorecardHash,
  verify: (candidate) => verifySemanticMutationEvidence({ root, runDirectory: candidate, python, slidesTest, requireSourceCurrent: true }),
});
process.stdout.write(`C18 semantic-mutation benchmark passed with scorecard ${scorecard.scorecardHash}\n`);
