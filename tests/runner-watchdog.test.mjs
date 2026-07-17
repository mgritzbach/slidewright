import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startRunnerWatchdog } from "../scripts/lib/runner-watchdog.mjs";
import { captureWorkerIdentity } from "../scripts/lib/exact-worker-process.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const watchdogScript = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "semantic_surface", "powerpoint_runner_watchdog.ps1");
const cleanupScript = path.join(path.dirname(watchdogScript), "cleanup_owned_powerpoint.ps1");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForJson(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "")); } catch { await delay(100); }
  }
  assert.fail(`Timed out waiting for ${file}`);
}

async function waitForProcessExit(processId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!captureWorkerIdentity(processId)) return;
    await delay(100);
  }
  assert.fail(`Timed out waiting for watchdog process ${processId} to exit`);
}

test("runner watchdog is disabled without filesystem mutation on non-Windows", async () => {
  const result = await startRunnerWatchdog({ platform: "linux" });
  assert.deepEqual(result, { enabled: false, reason: "non-windows" });
});

test("runner watchdog prepares staging, proves readiness, and exits safely with its parent", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows watchdog control");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-runner-watchdog-"));
  const staging = path.join(directory, "missing", "staging");
  const completion = path.join(directory, "complete.marker");
  const ready = path.join(directory, "ready.marker");
  const recovery = path.join(directory, "recovery.json");
  const log = path.join(directory, "watchdog.log");
  const fixture = fileURLToPath(new URL("fixtures/start-runner-watchdog.mjs", import.meta.url));
  try {
    const child = spawn(process.execPath, [fixture, root, staging, watchdogScript, cleanupScript, completion, ready, recovery, log], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    const startup = JSON.parse(stdout.trim());
    assert.equal(startup.enabled, true);
    assert.equal(startup.processName.toLowerCase(), "powershell");
    assert.match(startup.processStartTime, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(startup.identityReceiptSha256, /^[a-f0-9]{64}$/u);
    assert.match(startup.readyMarkerSha256, /^[a-f0-9]{64}$/u);
    assert.equal(startup.stagingDir, path.resolve(staging));
    await fs.access(staging);
    const report = await waitForJson(recovery);
    assert.equal(report.schemaVersion, "slidewright-runner-watchdog/v1");
    assert.equal(report.parentIdentityMatched, true);
    assert.equal(report.parentExitedWithoutCompletionMarker, true);
    assert.equal(report.safe, true);
    assert.deepEqual(report.problems, []);
    await waitForProcessExit(startup.processId);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("runner watchdog terminates the exact receipt process when launcher stdout is malformed", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows watchdog startup-failure control");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-runner-watchdog-failure-"));
  const fakeLauncher = path.join(directory, "fake-launcher.ps1");
  const diagnosticLog = path.join(directory, "watchdog.log");
  const identityReceipt = `${diagnosticLog}.identity.json`;
  const fakeSource = `param(
    [string]$EntrypointScript, [string]$WatchdogScript, [int]$ParentProcessId,
    [string]$ParentProcessStartTime, [string]$StagingDir, [string]$CompletionMarker,
    [string]$ReadyMarker, [string]$RecoveryReportJson, [string]$CleanupScript,
    [string]$DiagnosticLog, [string]$IdentityReceiptJson, [int]$ScanWindowMilliseconds
  )
  $child = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -Command "Start-Sleep -Seconds 60"' -WindowStyle Hidden -PassThru
  $live = Get-Process -Id $child.Id -ErrorAction Stop
  $identity = [ordered]@{
    schemaVersion = 'slidewright-runner-watchdog-identity/v1'
    processId = [int]$live.Id
    processName = [string]$live.ProcessName
    processStartTime = $live.StartTime.ToUniversalTime().ToString('o')
  }
  $temporary = "$IdentityReceiptJson.tmp"
  $identity | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $temporary
  Move-Item -Force -LiteralPath $temporary -Destination $IdentityReceiptJson
  Write-Output 'not-json'
  `;
  await fs.writeFile(fakeLauncher, fakeSource, "utf8");
  try {
    await assert.rejects(
      startRunnerWatchdog({
        root,
        stagingDir: path.join(directory, "staging"),
        watchdogScript,
        launcherScript: fakeLauncher,
        cleanupScript,
        completionMarker: path.join(directory, "complete.marker"),
        readyMarker: path.join(directory, "ready.marker"),
        recoveryReport: path.join(directory, "recovery.json"),
        diagnosticLog,
        startupTimeoutMs: 3_000,
        scanWindowMilliseconds: 1_000,
      }),
      (error) => {
        assert.match(error.message, /invalid identity JSON/u);
        assert.match(error.message, /"matched":true,"terminated":true/u);
        return true;
      },
    );
    const receipt = JSON.parse((await fs.readFile(identityReceipt, "utf8")).replace(/^\uFEFF/u, ""));
    await waitForProcessExit(receipt.processId);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
