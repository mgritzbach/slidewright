#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { startRunnerWatchdog } from "../lib/runner-watchdog.mjs";
import { captureWorkerIdentity, captureWorkerIdentityWithRetry } from "../lib/exact-worker-process.mjs";

const [root, stagingDir, semanticDir, parentIdentityReceiptPath] = process.argv.slice(2);
if (!root || !stagingDir || !semanticDir || !parentIdentityReceiptPath) throw new Error("root, stagingDir, semanticDir, and parentIdentityReceiptPath are required");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function waitFor(file, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(file)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

await fs.mkdir(stagingDir, { recursive: true });
const parentIdentity = await captureWorkerIdentityWithRetry(process.pid);
if (!parentIdentity) throw new Error("Could not capture the forced-parent fixture identity.");
await fs.writeFile(parentIdentityReceiptPath, `${JSON.stringify({ schemaVersion: "slidewright-forced-parent-identity/v1", ...parentIdentity }, null, 2)}\n`, "utf8");
const watchdogDir = path.join(stagingDir, "watchdog");
const completionMarker = path.join(watchdogDir, "completion.marker");
const readyMarker = path.join(watchdogDir, "ready.marker");
const recoveryReport = path.join(watchdogDir, "recovery.json");
const diagnosticLog = path.join(watchdogDir, "diagnostic.log");
const watchdog = await startRunnerWatchdog({
  root,
  stagingDir,
  watchdogScript: path.join(semanticDir, "powerpoint_runner_watchdog.ps1"),
  cleanupScript: path.join(semanticDir, "cleanup_owned_powerpoint.ps1"),
  completionMarker,
  readyMarker,
  recoveryReport,
  diagnosticLog,
});
await fs.copyFile(readyMarker, path.join(watchdogDir, "ready-snapshot.marker"));

const intent = path.join(stagingDir, "worker-intents", "forced-parent-worker-intent.json");
const ownership = path.join(stagingDir, "forced-parent-ownership.json");
const workerReady = path.join(stagingDir, "forced-parent-worker.ready");
await fs.mkdir(path.dirname(intent), { recursive: true });
const workerIdentityReceipt = path.join(stagingDir, "forced-parent-worker-identity.json");
const launch = spawnSync("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(semanticDir, "start_powerpoint_timeout_probe_control.ps1"),
  "-ProbeScript", path.join(semanticDir, "powerpoint_timeout_probe.ps1"),
  "-OwnershipRecordJson", ownership,
  "-WorkerIntentJson", intent,
  "-ReadyMarker", workerReady,
  "-IdentityReceiptJson", workerIdentityReceipt,
  "-HoldSeconds", "120",
], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
if (launch.error || launch.status !== 0) throw launch.error ?? new Error(`Could not launch forced-parent worker: ${launch.stderr}`);
const launchedIdentity = JSON.parse(launch.stdout.trim());
const workerIdentity = captureWorkerIdentity(launchedIdentity.processId);
if (!workerIdentity || workerIdentity.processName !== launchedIdentity.processName || workerIdentity.processStartTime !== launchedIdentity.processStartTime) {
  throw new Error("Forced-parent worker launcher identity did not match the live process.");
}
await Promise.all([waitFor(intent), waitFor(ownership), waitFor(workerReady)]);
const armed = {
  schemaVersion: "slidewright-watchdog-forced-parent-armed/v1",
  valid: Boolean(parentIdentity && workerIdentity && watchdog.enabled),
  parentIdentity,
  watchdog,
  workerIdentity,
};
const armedPath = path.join(stagingDir, "armed.json");
await fs.writeFile(armedPath, `${JSON.stringify(armed, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(armed)}\n`);
setInterval(() => {}, 60_000);
