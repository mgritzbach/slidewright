import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureWorkerIdentity, terminateExactWorker } from "./exact-worker-process.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readDiagnostic(file) {
  try {
    return (await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "").trim();
  } catch (error) {
    return error?.code === "ENOENT" ? "<not-created>" : `<unreadable: ${error.message}>`;
  }
}

function identitiesMatch(expected, live) {
  return Boolean(expected && live
    && expected.processId === live.processId
    && expected.processName === live.processName
    && expected.processStartTime === live.processStartTime);
}

function validIdentityReceipt(value) {
  return Boolean(value
    && value.schemaVersion === "slidewright-runner-watchdog-identity/v1"
    && Number.isInteger(value.processId)
    && value.processId > 0
    && ["powershell", "pwsh"].includes(String(value.processName ?? "").toLowerCase())
    && typeof value.processStartTime === "string"
    && value.processStartTime.length > 0);
}

async function readIdentityReceipt(file) {
  try {
    const value = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
    return validIdentityReceipt(value) ? value : null;
  } catch {
    return null;
  }
}

async function sha256File(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function startupFailure({
  message,
  watchdog,
  watchdogIdentity,
  diagnosticLog,
  recoveryReport,
}) {
  const termination = watchdogIdentity?.processId
    ? terminateExactWorker(watchdogIdentity.processId, watchdogIdentity)
    : { matched: false, terminated: false, reason: "watchdog-pid-unavailable" };
  const [log, recovery] = await Promise.all([
    readDiagnostic(diagnosticLog),
    readDiagnostic(recoveryReport),
  ]);
  throw new Error(`${message}; exact watchdog termination: ${JSON.stringify(termination)}; diagnostic log ${diagnosticLog}: ${log}; recovery report ${recoveryReport}: ${recovery}`);
}

export async function startRunnerWatchdog({
  root,
  stagingDir,
  watchdogScript,
  launcherScript = path.join(path.dirname(watchdogScript ?? ""), "start_powerpoint_runner_watchdog.ps1"),
  entrypointScript = path.join(path.dirname(watchdogScript ?? ""), "powerpoint_runner_watchdog_entrypoint.ps1"),
  cleanupScript,
  completionMarker,
  readyMarker,
  recoveryReport,
  diagnosticLog,
  startupTimeoutMs = 30_000,
  scanWindowMilliseconds = 15_000,
  platform = process.platform,
  parentProcessId = process.pid,
} = {}) {
  if (platform !== "win32") return { enabled: false, reason: "non-windows" };
  for (const [label, value] of Object.entries({ root, stagingDir, watchdogScript, launcherScript, entrypointScript, cleanupScript, completionMarker, readyMarker, recoveryReport, diagnosticLog })) {
    if (typeof value !== "string" || value.length === 0) throw new Error(`Runner watchdog ${label} is required.`);
  }
  if (!Number.isInteger(parentProcessId) || parentProcessId < 1) throw new Error("Runner watchdog parentProcessId must be a positive integer.");
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1_000) throw new Error("Runner watchdog startupTimeoutMs must be at least 1000.");
  if (!Number.isInteger(scanWindowMilliseconds) || scanWindowMilliseconds < 1_000) throw new Error("Runner watchdog scanWindowMilliseconds must be at least 1000.");

  const identityReceipt = `${diagnosticLog}.identity.json`;

  await Promise.all([
    fs.mkdir(stagingDir, { recursive: true }),
    fs.mkdir(path.dirname(readyMarker), { recursive: true }),
    fs.mkdir(path.dirname(diagnosticLog), { recursive: true }),
  ]);
  await Promise.all([
    fs.rm(completionMarker, { force: true }),
    fs.rm(readyMarker, { force: true }),
    fs.rm(recoveryReport, { force: true }),
    fs.rm(diagnosticLog, { force: true }),
    fs.rm(identityReceipt, { force: true }),
  ]);

  const startResult = spawnSync("powershell.exe", [
    "-NoProfile", "-Command",
    `(Get-Process -Id ${parentProcessId} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  if (startResult.error || startResult.status !== 0 || !startResult.stdout.trim()) {
    throw new Error(`Could not resolve runner process start time: ${startResult.error?.message ?? startResult.stderr ?? "unknown failure"}`);
  }

  const launchResult = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherScript,
    "-EntrypointScript", entrypointScript,
    "-WatchdogScript", watchdogScript,
    "-ParentProcessId", String(parentProcessId),
    "-ParentProcessStartTime", startResult.stdout.trim(),
    "-StagingDir", stagingDir,
    "-CompletionMarker", completionMarker,
    "-ReadyMarker", readyMarker,
    "-RecoveryReportJson", recoveryReport,
    "-CleanupScript", cleanupScript,
    "-DiagnosticLog", diagnosticLog,
    "-IdentityReceiptJson", identityReceipt,
    "-ScanWindowMilliseconds", String(scanWindowMilliseconds),
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
  const receiptIdentity = await readIdentityReceipt(identityReceipt);
  if (launchResult.error || launchResult.status !== 0 || !launchResult.stdout.trim()) {
    const termination = receiptIdentity
      ? terminateExactWorker(receiptIdentity.processId, receiptIdentity)
      : { matched: false, terminated: false, reason: "identity-receipt-unavailable" };
    throw new Error(`Could not launch runner watchdog: ${launchResult.error?.message ?? launchResult.stderr ?? "unknown failure"}; exact receipt cleanup: ${JSON.stringify(termination)}`);
  }
  let stdoutIdentity;
  try {
    stdoutIdentity = JSON.parse(launchResult.stdout.trim());
  } catch {
    const termination = receiptIdentity
      ? terminateExactWorker(receiptIdentity.processId, receiptIdentity)
      : { matched: false, terminated: false, reason: "identity-receipt-unavailable" };
    throw new Error(`Runner watchdog launcher returned invalid identity JSON: ${launchResult.stdout.trim()}; exact receipt cleanup: ${JSON.stringify(termination)}`);
  }
  if (!validIdentityReceipt(stdoutIdentity)
    || !receiptIdentity
    || !identitiesMatch(stdoutIdentity, receiptIdentity)) {
    const cleanupIdentity = receiptIdentity ?? (validIdentityReceipt(stdoutIdentity) ? stdoutIdentity : null);
    const termination = cleanupIdentity
      ? terminateExactWorker(cleanupIdentity.processId, cleanupIdentity)
      : { matched: false, terminated: false, reason: "valid-identity-unavailable" };
    throw new Error(`Runner watchdog launcher identity did not match its atomic receipt: ${JSON.stringify({ stdoutIdentity, receiptIdentity })}; exact identity cleanup: ${JSON.stringify(termination)}`);
  }
  const watchdogIdentity = receiptIdentity;

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const liveIdentity = captureWorkerIdentity(watchdogIdentity.processId);
    if (!liveIdentity) {
      return startupFailure({
        message: "PowerPoint runner watchdog exited before becoming ready",
        watchdogIdentity,
        diagnosticLog,
        recoveryReport,
      });
    }
    if (await fileExists(readyMarker)) {
      await delay(100);
      const stableIdentity = captureWorkerIdentity(watchdogIdentity.processId);
      if (await fileExists(readyMarker) && identitiesMatch(watchdogIdentity, stableIdentity)) {
        return {
          enabled: true,
          processId: watchdogIdentity.processId,
          processName: watchdogIdentity.processName,
          processStartTime: watchdogIdentity.processStartTime,
          parentProcessId,
          parentProcessStartTime: startResult.stdout.trim(),
          identityReceiptSha256: await sha256File(identityReceipt),
          readyMarkerSha256: await sha256File(readyMarker),
        };
      }
      return startupFailure({
        message: "PowerPoint runner watchdog ready marker was not bound to the exact live watchdog process",
        watchdogIdentity,
        diagnosticLog,
        recoveryReport,
      });
    }
    await delay(100);
  }
  return startupFailure({
    message: `PowerPoint runner watchdog did not become ready within ${startupTimeoutMs} ms`,
    watchdogIdentity,
    diagnosticLog,
    recoveryReport,
  });
}
