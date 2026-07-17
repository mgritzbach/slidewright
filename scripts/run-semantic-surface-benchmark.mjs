#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { cleanupOwnedPowerPoint } from "./lib/owned-process-cleanup.mjs";
import { publishVersionedEvidence } from "./lib/versioned-evidence-publish.mjs";
import { captureWorkerIdentity, terminateExactWorker } from "./lib/exact-worker-process.mjs";

const root = process.cwd();
const publishedOutput = path.join(root, "outputs", "semantic-surface");
const publishedRuns = path.join(publishedOutput, "runs");
const output = path.join(publishedRuns, `.staging-${process.pid}-${Date.now()}`);
const scripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");
const semantic = path.join(scripts, "semantic_surface");
const watchdogScript = path.join(semantic, "powerpoint_runner_watchdog.ps1");
const watchdogCompletionMarker = path.join(root, "outputs", `.semantic-watchdog-${process.pid}.complete`);
const watchdogReadyMarker = path.join(root, "outputs", `.semantic-watchdog-${process.pid}.ready`);
const watchdogRecoveryReport = path.join(root, "outputs", `.semantic-watchdog-${process.pid}.json`);
const contractPath = path.join(root, "fixtures", "semantic-surface", "v1", "semantic-contract.json");
const assetPath = path.join(root, "fixtures", "independent", "7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png");
const manifestPath = path.join(output, "frozen-manifest.json");
const sourcePptx = path.join(output, "semantic-surface.pptx");
const roundtripPptx = path.join(output, "powerpoint-roundtrip.pptx");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }

const activeWorkers = new Map();
let signalCleanupStarted = false;

function terminateWorkerOnly(workerPid, expectedIdentity) {
  return terminateExactWorker(workerPid, expectedIdentity);
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

function run(command, args, { capture = false, timeoutMs = 120_000, ownershipRecordPath = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
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
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // Terminate only the worker. PowerPoint is never force-killed; after the
      // worker's COM reference is gone, the presentation-aware cleanup may
      // close only allowlisted hidden worker decks and observe natural exit.
      const terminationIdentity = identity ?? captureWorkerIdentity(child.pid);
      workerTermination = terminateWorkerOnly(child.pid, terminationIdentity);
      if (ownershipRecordPath) timeoutCleanup = cleanupOwnedPowerPoint(ownershipRecordPath, { root });
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) activeWorkers.delete(child.pid);
      reject(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) activeWorkers.delete(child.pid);
      if (timedOut) {
        const error = new Error(`${command} ${args.join(" ")} exceeded ${timeoutMs} ms; exact worker termination: ${JSON.stringify(workerTermination)}; owned-process cleanup: ${JSON.stringify(timeoutCleanup)}.`);
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

function normalizedFilePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function startRunnerWatchdog() {
  if (process.platform !== "win32") return { enabled: false, reason: "non-windows" };
  await Promise.all([
    fs.rm(watchdogCompletionMarker, { force: true }),
    fs.rm(watchdogReadyMarker, { force: true }),
    fs.rm(watchdogRecoveryReport, { force: true }),
  ]);
  const startResult = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  ], { cwd: root, encoding: "utf8", windowsHide: true });
  if (startResult.status !== 0) throw new Error(`Could not resolve runner process start time: ${startResult.stderr}`);
  const watchdog = spawn("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", watchdogScript,
    "-ParentProcessId", String(process.pid),
    "-ParentProcessStartTime", startResult.stdout.trim(),
    "-StagingDir", output,
    "-CompletionMarker", watchdogCompletionMarker,
    "-ReadyMarker", watchdogReadyMarker,
    "-RecoveryReportJson", watchdogRecoveryReport,
    "-CleanupScript", path.join(semantic, "cleanup_owned_powerpoint.ps1"),
  ], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
  watchdog.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { await fs.access(watchdogReadyMarker); return { enabled: true, processId: watchdog.pid }; } catch { await delay(100); }
  }
  throw new Error("PowerPoint runner watchdog did not become ready within ten seconds.");
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

async function waitForPowerPointQuiescence(timeoutMs = 120_000) {
  if (process.platform !== "win32") return { valid: true, waitedMs: 0, polls: 0, reason: "non-windows" };
  const started = Date.now();
  let polls = 0;
  let consecutiveClearPolls = 0;
  let lastPids = [];
  while (Date.now() - started <= timeoutMs) {
    polls += 1;
    const result = await run("powershell", [
      "-NoProfile", "-Command",
      "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0",
    ], { capture: true, timeoutMs: 10_000 });
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

const runnerWatchdog = await startRunnerWatchdog();
await fs.mkdir(publishedRuns, { recursive: true });
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const contract = await readJson(contractPath);
if (contract.deterministicExports !== 3) throw new Error("The semantic contract must require exactly three deterministic exports.");

const renderScript = path.join(semantic, "render_semantic_surface.mjs");
const structureScript = path.join(semantic, "structure_semantic_surface.py");
const normalizeScript = path.join(scripts, "lib", "normalize_pptx.py");
const auditScript = path.join(semantic, "audit_semantic_surface.py");
const negativeScript = path.join(semantic, "semantic_surface_negative_controls.py");
const exportPptx = [];
const exportHashes = [];
for (let index = 1; index <= contract.deterministicExports; index += 1) {
  const base = path.join(output, `export-${index}-base.pptx`);
  const raw = path.join(output, `export-${index}-structured.pptx`);
  const structured = index === 1 ? sourcePptx : path.join(output, `export-${index}.pptx`);
  const renderArgs = [renderScript, base];
  if (index === 1) renderArgs.push(path.join(output, "artifact-previews"));
  else renderArgs.push("");
  renderArgs.push(assetPath);
  await run(process.execPath, renderArgs);
  await run(python, [structureScript, base, raw, "--contract", contractPath]);
  await run(python, [normalizeScript, raw, "--out", structured, "--report-json", path.join(output, `normalize-${index}.json`)], { capture: true });
  exportPptx.push(structured);
  exportHashes.push(await sha256(structured));
}
if (new Set(exportHashes).size !== 1) throw new Error(`Semantic exports are not byte deterministic: ${exportHashes.join(", ")}`);

await run(python, [auditScript, sourcePptx, "--contract", contractPath, "--freeze-manifest", manifestPath, "--json", path.join(output, "freeze-report.json")], { capture: true });
const audits = [];
for (let index = 0; index < exportPptx.length; index += 1) {
  const report = path.join(output, `export-${index + 1}-audit.json`);
  await run(python, [auditScript, exportPptx[index], "--manifest", manifestPath, "--contract", contractPath, "--json", report], { capture: true });
  audits.push(await readJson(report));
}

const negativeDir = path.join(output, "negative-controls");
const negativeReportPath = path.join(output, "negative-controls.json");
await run(python, [negativeScript, sourcePptx, manifestPath, negativeDir, "--json", negativeReportPath], { capture: true });

const powerPointQuiescence = await waitForPowerPointQuiescence();
await writeJson(path.join(output, "powerpoint-quiescence.json"), powerPointQuiescence);
if (!powerPointQuiescence.valid) {
  throw new Error(`PowerPoint did not become quiescent within two minutes. Close any user presentation or wait for another automation task to finish. Active PIDs: ${(powerPointQuiescence.lastPids ?? []).join(", ")}`);
}

const workerIntents = [];
const timeoutProbeRecordPath = path.join(output, "powerpoint-timeout-probe-ownership.json");
const timeoutProbeIntentPath = workerIntentPath("powerpoint-timeout-probe");
let timeoutProbeRejected = false;
let timeoutProbeError = "";
let timeoutProbeFirstCleanup = null;
let timeoutProbeWorkerIdentity = null;
try {
  await run("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(semantic, "powerpoint_timeout_probe.ps1"),
    "-OwnershipRecordJson", timeoutProbeRecordPath,
    "-WorkerIntentJson", timeoutProbeIntentPath,
    "-HoldSeconds", "120",
  ], { capture: true, timeoutMs: 5_000, ownershipRecordPath: timeoutProbeRecordPath });
} catch (error) {
  timeoutProbeError = error.message;
  timeoutProbeFirstCleanup = error.timeoutCleanup ?? null;
  timeoutProbeWorkerIdentity = error.workerIdentity ?? null;
  timeoutProbeRejected = /exceeded 5000 ms/u.test(timeoutProbeError);
}
const timeoutProbeIntent = await validateWorkerIntent(timeoutProbeIntentPath, "timeout-cleanup-negative-control", timeoutProbeRecordPath, timeoutProbeWorkerIdentity);
workerIntents.push({ stage: "timeout-probe", ...timeoutProbeIntent });
const timeoutProbePostCleanup = cleanupOwnedPowerPoint(timeoutProbeRecordPath, { root });
let timeoutProbeOwnershipHash = null;
try { timeoutProbeOwnershipHash = await sha256(timeoutProbeRecordPath); } catch { /* reported as invalid below */ }
const timeoutCleanupControl = {
  valid: timeoutProbeRejected
    && timeoutProbeFirstCleanup?.valid === true
    && timeoutProbeFirstCleanup?.cleaned === true
    && ["owned-process-already-exited", "owned-process-exited-after-com-release"].includes(timeoutProbeFirstCleanup?.reason)
    && timeoutProbePostCleanup.valid
    && timeoutProbePostCleanup.reason === "owned-process-already-exited",
  workerTimedOut: timeoutProbeRejected,
  firstCleanup: timeoutProbeFirstCleanup,
  ownedProcessAbsentAfterFirstCleanup: timeoutProbeFirstCleanup?.valid === true && timeoutProbeFirstCleanup?.cleaned === true,
  ownedProcessAbsentAfterCleanup: timeoutProbePostCleanup.valid && timeoutProbePostCleanup.reason === "owned-process-already-exited",
  ownershipRecordSha256: timeoutProbeOwnershipHash,
  postCleanup: timeoutProbePostCleanup,
  errorSha256: crypto.createHash("sha256").update(timeoutProbeError).digest("hex"),
};
await writeJson(path.join(output, "powerpoint-timeout-cleanup-control.json"), timeoutCleanupControl);
if (!timeoutCleanupControl.valid) throw new Error(`PowerPoint timeout cleanup control failed: ${JSON.stringify(timeoutCleanupControl)}`);

const powerPointReportPath = path.join(output, "powerpoint-roundtrip.json");
const powerPointOwnershipPath = path.join(output, "powerpoint-roundtrip-ownership.json");
const powerPointRoundtripIntentPath = workerIntentPath("powerpoint-roundtrip");
const powerPointRoundtripRun = await run("powershell", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(semantic, "powerpoint_semantic_roundtrip.ps1"),
  "-InputPptx", sourcePptx,
  "-OutputPptx", roundtripPptx,
  "-ReportJson", powerPointReportPath,
  "-OwnershipRecordJson", powerPointOwnershipPath,
  "-WorkerIntentJson", powerPointRoundtripIntentPath,
], { capture: true, timeoutMs: 300_000, ownershipRecordPath: powerPointOwnershipPath });
workerIntents.push({ stage: "roundtrip", ...await validateWorkerIntent(powerPointRoundtripIntentPath, "semantic-roundtrip", powerPointOwnershipPath, powerPointRoundtripRun.workerIdentity) });
const roundtripAuditPath = path.join(output, "powerpoint-roundtrip-audit.json");
await run(python, [auditScript, roundtripPptx, "--manifest", manifestPath, "--contract", contractPath, "--allow-relationship-rebase", "--json", roundtripAuditPath], { capture: true });

const interStagePowerPointQuiescence = [];
const afterRoundtripQuiescence = await waitForPowerPointQuiescence();
interStagePowerPointQuiescence.push({ stage: "after-semantic-roundtrip", ...afterRoundtripQuiescence });
if (!afterRoundtripQuiescence.valid) throw new Error("PowerPoint did not exit cleanly after the semantic round-trip worker.");

const isolatedRenderScript = path.join(semantic, "powerpoint_render_isolated.ps1");
const sourceRenderReportPath = path.join(output, "powerpoint-source-render.json");
const roundtripRenderReportPath = path.join(output, "powerpoint-roundtrip-render.json");
const sourceRenderOwnershipPath = path.join(output, "powerpoint-source-render-ownership.json");
const roundtripRenderOwnershipPath = path.join(output, "powerpoint-roundtrip-render-ownership.json");
const sourceRenderIntentPath = workerIntentPath("powerpoint-source-render");
const sourceRenderRun = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", isolatedRenderScript, "-InputPptx", sourcePptx, "-OutputDir", path.join(output, "powerpoint-source-render"), "-ReportJson", sourceRenderReportPath, "-OwnershipRecordJson", sourceRenderOwnershipPath, "-WorkerIntentJson", sourceRenderIntentPath], { capture: true, timeoutMs: 300_000, ownershipRecordPath: sourceRenderOwnershipPath });
workerIntents.push({ stage: "source-render", ...await validateWorkerIntent(sourceRenderIntentPath, "isolated-powerpoint-render", sourceRenderOwnershipPath, sourceRenderRun.workerIdentity) });
const betweenRenderQuiescence = await waitForPowerPointQuiescence();
interStagePowerPointQuiescence.push({ stage: "between-source-and-roundtrip-render", ...betweenRenderQuiescence });
if (!betweenRenderQuiescence.valid) throw new Error("PowerPoint did not exit cleanly after source rendering.");
const roundtripRenderIntentPath = workerIntentPath("powerpoint-roundtrip-render");
const roundtripRenderRun = await run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", isolatedRenderScript, "-InputPptx", roundtripPptx, "-OutputDir", path.join(output, "powerpoint-roundtrip-render"), "-ReportJson", roundtripRenderReportPath, "-OwnershipRecordJson", roundtripRenderOwnershipPath, "-WorkerIntentJson", roundtripRenderIntentPath], { capture: true, timeoutMs: 300_000, ownershipRecordPath: roundtripRenderOwnershipPath });
workerIntents.push({ stage: "roundtrip-render", ...await validateWorkerIntent(roundtripRenderIntentPath, "isolated-powerpoint-render", roundtripRenderOwnershipPath, roundtripRenderRun.workerIdentity) });
const afterRenderQuiescence = await waitForPowerPointQuiescence();
interStagePowerPointQuiescence.push({ stage: "after-roundtrip-render", ...afterRenderQuiescence });
if (!afterRenderQuiescence.valid) throw new Error("PowerPoint did not exit cleanly after round-trip rendering.");

const slidesTest = await findPresentationTool("slides_test.py");
const overflowChecks = [];
for (const [label, pptx] of [["source", sourcePptx], ["roundtrip", roundtripPptx]]) {
  const result = await run(python, [slidesTest, pptx], { capture: true, timeoutMs: 120_000 });
  const reportPath = path.join(output, `overflow-${label}.json`);
  const report = {
    schemaVersion: "slidewright-semantic-overflow/v1",
    valid: result.status === 0,
    target: label,
    inputSha256: await sha256(pptx),
    command: "slides_test.py",
    exitCode: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
  await writeJson(reportPath, report);
  overflowChecks.push({
    target: label,
    valid: report.valid,
    inputSha256: report.inputSha256,
    reportSha256: await sha256(reportPath),
  });
}

const freeze = await readJson(path.join(output, "freeze-report.json"));
const negatives = await readJson(negativeReportPath);
const powerPoint = await readJson(powerPointReportPath);
const sourceRender = await readJson(sourceRenderReportPath);
const roundtripRender = await readJson(roundtripRenderReportPath);
const roundtripAudit = await readJson(roundtripAuditPath);
const exactRenderParity = sourceRender.valid && roundtripRender.valid
  && sourceRender.renders.length === 4
  && roundtripRender.renders.length === 4
  && sourceRender.renders.every((item, index) => item.sha256 === roundtripRender.renders[index]?.sha256
    && item.reviewSha256 === roundtripRender.renders[index]?.reviewSha256);
const scorecard = {
  schemaVersion: "slidewright-semantic-surface-scorecard/v1",
  valid: false,
  contractSha256: await sha256(contractPath),
  sourceAssetSha256: await sha256(assetPath),
  deterministicExports: exportHashes.map((hash, index) => ({ export: index + 1, sha256: hash })),
  exactByteDeterminism: new Set(exportHashes).size === 1,
  frozenManifestSha256: await sha256(manifestPath),
  frozenContractValid: freeze.valid && freeze.contractValid && freeze.manifestWritten,
  exportAuditsValid: audits.every((report) => report.valid && report.checks.authoredContract),
  semanticSummary: freeze.summary,
  negativeControls: negatives.controls.map((item) => ({ id: item.id, rejected: item.rejected, failureCodes: item.failureCodes })),
  powerPointQuiescence,
  interStagePowerPointQuiescence,
  timeoutCleanupControl,
  workerIntents,
  workerIntentsValid: workerIntents.length === 4 && workerIntents.every((item) => /^[a-f0-9]{64}$/u.test(item.sha256)),
  runnerWatchdog,
  powerpoint: {
    valid: powerPoint.valid,
    serializedBySaveAs: powerPoint.serializedBySaveAs,
    exactTopLevelStatePreserved: powerPoint.exactTopLevelStatePreserved,
    automationProcessOwned: powerPoint.automationProcessOwned,
    version: powerPoint.version,
    build: powerPoint.build,
    roundtripPptxSha256: powerPoint.outputSha256,
    ownershipRecordHashes: {
      roundtrip: await sha256(powerPointOwnershipPath),
      sourceRender: await sha256(sourceRenderOwnershipPath),
      roundtripRender: await sha256(roundtripRenderOwnershipPath),
    },
    exactFullSizeRenderParity: exactRenderParity,
    sourceRenderIsolation: sourceRender.isolation,
    sourceRenderSessions: sourceRender.sessions,
    roundtripRenderSessions: roundtripRender.sessions,
    sourceRenderHashes: sourceRender.renders.map((item) => item.sha256),
    roundtripRenderHashes: roundtripRender.renders.map((item) => item.sha256),
    sourceReviewHashes: sourceRender.renders.map((item) => item.reviewSha256),
    roundtripReviewHashes: roundtripRender.renders.map((item) => item.reviewSha256),
  },
  powerpointSemanticAuditValid: roundtripAudit.valid && roundtripAudit.checks.authoredContract,
  overflowChecks,
  overflowChecksValid: overflowChecks.length === 2 && overflowChecks.every((item) => item.valid),
};
scorecard.valid = scorecard.exactByteDeterminism
  && scorecard.frozenContractValid
  && scorecard.exportAuditsValid
  && scorecard.semanticSummary.slides === 4
  && scorecard.semanticSummary.objects === 40
  && scorecard.semanticSummary.meaningfulNotesSlides === 4
  && scorecard.semanticSummary.nestedObjects === 6
  && scorecard.negativeControls.length === 9
  && scorecard.negativeControls.every((item) => item.rejected)
  && (process.platform !== "win32" || scorecard.runnerWatchdog.enabled)
  && scorecard.powerPointQuiescence.valid
  && scorecard.interStagePowerPointQuiescence.length === 3
  && scorecard.interStagePowerPointQuiescence.every((item) => item.valid)
  && scorecard.timeoutCleanupControl.valid
  && scorecard.workerIntentsValid
  && scorecard.powerpoint.valid
  && scorecard.powerpoint.automationProcessOwned
  && scorecard.powerpoint.sourceRenderSessions.every((item) => item.automationProcessOwned)
  && scorecard.powerpoint.roundtripRenderSessions.every((item) => item.automationProcessOwned)
  && scorecard.powerpoint.exactFullSizeRenderParity
  && scorecard.powerpointSemanticAuditValid
  && scorecard.overflowChecksValid;
scorecard.scorecardHash = canonicalHash(scorecard);
await writeJson(path.join(output, "scorecard.json"), scorecard);
if (!scorecard.valid) throw new Error("C08 semantic-surface scorecard is incomplete.");
await publishVersionedEvidence(output, publishedOutput, scorecard.scorecardHash);
await fs.writeFile(watchdogCompletionMarker, "complete\n", "utf8");
process.stdout.write(`C08 semantic-surface benchmark passed with scorecard ${scorecard.scorecardHash}\n`);
