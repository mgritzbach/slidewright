import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { matchesOwnedPowerPoint } from "../scripts/lib/owned-process-cleanup.mjs";
import { captureWorkerIdentity, terminateExactWorker } from "../scripts/lib/exact-worker-process.mjs";
import { publishVersionedEvidence } from "../scripts/lib/versioned-evidence-publish.mjs";

const contractPath = new URL("../fixtures/semantic-surface/v1/semantic-contract.json", import.meta.url);
const rendererPath = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/render_semantic_surface.mjs", import.meta.url);
const semanticScriptRoot = new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/", import.meta.url);
const cleanupScriptPath = new URL("cleanup_owned_powerpoint.ps1", semanticScriptRoot);
const watchdogScriptPath = new URL("powerpoint_runner_watchdog.ps1", semanticScriptRoot);
const semanticRunnerPath = new URL("../scripts/run-semantic-surface-benchmark.mjs", import.meta.url);

test("semantic surface contract covers every native complex object", async () => {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  assert.equal(contract.schemaVersion, "slidewright-semantic-surface/v1");
  assert.equal(contract.deterministicExports, 3);
  assert.equal(contract.slides.length, 4);
  assert.equal(contract.slides.flatMap((slide) => slide.charts ?? []).length, 2);
  assert.equal(contract.slides.filter((slide) => slide.table).length, 1);
  assert.equal(contract.slides.flatMap((slide) => slide.connectors ?? []).length, 2);
  assert.equal(contract.slides.filter((slide) => slide.image).length, 1);
  assert.ok(contract.slides.every((slide) => slide.speakerNotes.length >= 80));
  assert.ok(contract.slides.some((slide) => (slide.groups ?? []).some((group) => group.parent)));
  assert.deepEqual(contract.negativeControls, [
    "chart-relation-break", "chart-flatten", "table-flatten", "connector-detach", "notes-strip",
    "nested-group-flatten", "hierarchy-drift", "image-relation-drift", "undeclared-object",
  ]);
});

test("declared semantic image is content addressed", async () => {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  const image = contract.slides.find((slide) => slide.image).image;
  const bytes = await fs.readFile(new URL(`../${image.source}`, import.meta.url));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8");
  assert.ok(image.alt.length > 20);
});

test("semantic renderer uses native artifact-tool surfaces", async () => {
  const source = await fs.readFile(rendererPath, "utf8");
  for (const expected of ["slide.charts.add", "slide.tables.add", "slide.shapes.connect", "slide.images.add", "slide.speakerNotes.textFrame.setText"]) {
    assert.match(source, new RegExp(expected.replaceAll(".", "\\.")));
  }
  assert.doesNotMatch(source, /chart[^\n]{0,80}(png|jpeg|webp)/i);
});

test("PowerPoint timeout cleanup requires an exact owned PID, name, and start time", () => {
  const owned = { processId: 4120, processName: "POWERPNT", processStartTime: "2026-07-16T21:08:05.2896514Z" };
  assert.equal(matchesOwnedPowerPoint(owned, { ...owned }), true);
  assert.equal(matchesOwnedPowerPoint(owned, { ...owned, processId: 4121 }), false);
  assert.equal(matchesOwnedPowerPoint(owned, { ...owned, processName: "powershell" }), false);
  assert.equal(matchesOwnedPowerPoint(owned, { ...owned, processStartTime: "2026-07-16T21:08:06.2896514Z" }), false);
});

test("semantic PowerPoint workers prove ownership before non-destructive cleanup", async () => {
  const scripts = [
    "powerpoint_timeout_probe.ps1",
    "powerpoint_semantic_roundtrip.ps1",
    "powerpoint_render_isolated.ps1",
    "powerpoint_semantic_mutation.ps1",
  ];
  for (const name of scripts) {
    const source = await fs.readFile(new URL(name, semanticScriptRoot), "utf8");
    const existingGuard = source.indexOf("if ($existingIds.Count -gt 0)");
    const comCreation = source.indexOf("New-Object -ComObject PowerPoint.Application");
    assert.ok(existingGuard >= 0 && existingGuard < comCreation, `${name} must reject existing PowerPoint before COM creation`);
    assert.match(source, /GetWindowThreadProcessId/);
    assert.match(source, /CommandLine -notmatch '[^']*\\?\/AUTOMATION/);
    assert.match(source, /presentations\.Count/i);
    assert.match(source, /ownedPresentationPaths/);
    assert.match(source, /expectedApplicationVisible/);
    const ownershipEstablished = source.indexOf("$ownsProcess = $true");
    const ownershipPersisted = Math.max(
      source.indexOf("Write-OwnershipRecord", ownershipEstablished),
      source.indexOf("Move-Item -Force -LiteralPath $temporary -Destination $ownershipPath", ownershipEstablished),
    );
    assert.ok(
      ownershipEstablished >= 0 && ownershipPersisted > ownershipEstablished,
      `${name} must persist an ownership record only after ownership is established`,
    );
    assert.match(source, /Test-Empty(?:PresentationInventory|HiddenApplication)/);
    assert.ok(source.indexOf("slidewright-worker-intent/v1") < comCreation, `${name} must publish worker intent before COM creation`);
    assert.match(source, /workerProcessName/);
    assert.match(source, /Start-Sleep -Milliseconds 150/);
    assert.doesNotMatch(source, /Stop-Process|\.Kill\(\)|\.Quit\(\)/);
    if (name !== "powerpoint_timeout_probe.ps1") {
      assert.match(source, /Close-CapturedOwnedPresentation/);
      assert.equal((source.match(/\.Close\(\)/g) ?? []).length, 1, `${name} must have one guarded raw close`);
    }
  }
});

test("timeout cleanup refuses mismatched live processes without force-kill", async (context) => {
  if (process.platform !== "win32") return context.skip("PowerShell cleanup is Windows-only");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-cleanup-mismatch-"));
  const recordPath = path.join(directory, "ownership.json");
  await fs.writeFile(recordPath, `${JSON.stringify({
    schemaVersion: "slidewright-owned-powerpoint/v1",
    processName: "POWERPNT",
    processId: process.pid,
    processStartTime: "2000-01-01T00:00:00.0000000Z",
  })}\n`, "utf8");
  try {
    const result = spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(cleanupScriptPath),
      "-OwnershipRecordJson", recordPath,
    ], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.notEqual(result.status, 0);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.cleaned, false);
    assert.equal(report.reason, "live-process-does-not-match-ownership-record");
    process.kill(process.pid, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("semantic timeout path kills only its worker and never force-kills PowerPoint", async () => {
  const runner = await fs.readFile(semanticRunnerPath, "utf8");
  const exactWorker = await fs.readFile(new URL("../scripts/lib/exact-worker-process.mjs", import.meta.url), "utf8");
  const cleanup = await fs.readFile(cleanupScriptPath, "utf8");
  assert.doesNotMatch(runner, /taskkill[^\n]*["']\/T["']/);
  assert.match(runner, /terminateExactWorker\(workerPid, expectedIdentity\)/);
  assert.match(exactWorker, /live\.processStartTime !== expected\.processStartTime/);
  assert.match(exactWorker, /spawnSync\("taskkill", \["\/PID", String\(processId\), "\/F"\]/);
  assert.doesNotMatch(exactWorker, /"\/T"/);
  assert.match(runner, /\.staging-/);
  assert.match(runner, /await publishVersionedEvidence\(output, publishedOutput, scorecard\.scorecardHash\)/);
  assert.doesNotMatch(runner, /fs\.rename\(published,/);
  assert.match(runner, /process\.once\("SIGINT"/);
  assert.ok(
    runner.indexOf("terminateWorkerOnly(child.pid, terminationIdentity)") < runner.indexOf("timeoutCleanup = cleanupOwnedPowerPoint"),
    "the worker COM reference must be released before natural-exit cleanup is evaluated",
  );
  assert.match(cleanup, /GetActiveObject\('PowerPoint\.Application'\)/);
  assert.match(cleanup, /Get-PresentationInventory/);
  assert.match(cleanup, /owned-process-has-foreign-presentations/);
  assert.match(cleanup, /owned-process-application-is-visible/);
  assert.match(cleanup, /owned-process-exited-after-closing-owned-presentations/);
  assert.match(cleanup, /\$closeCandidates \+= \$candidate/);
  assert.match(cleanup, /foreach \(\$candidate in \$closeCandidates\)/);
  assert.match(cleanup, /owned-process-state-changed-before-com-release/);
  assert.doesNotMatch(cleanup, /for \(\$index = \[int\]\$application\.Presentations\.Count/);
  assert.doesNotMatch(cleanup, /Stop-Process|\.Kill\(\)|\.Quit\(\)/);
});

test("exact worker termination refuses a PID whose start identity does not match", (context) => {
  if (process.platform !== "win32") return context.skip("Windows exact-process identity control");
  const identity = captureWorkerIdentity(process.pid);
  assert.ok(identity);
  assert.deepEqual(
    terminateExactWorker(process.pid, { ...identity, processName: "POWERPNT" }),
    { matched: false, terminated: false, reason: "powerpoint-is-never-a-worker" },
  );
  const result = terminateExactWorker(process.pid, { ...identity, processStartTime: "2000-01-01T00:00:00.0000000Z" });
  assert.deepEqual(result, { matched: false, terminated: false, reason: "live-worker-does-not-match-captured-identity" });
  process.kill(process.pid, 0);
});

test("versioned evidence publication preserves the prior run and advances one atomic pointer", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-versioned-publish-"));
  const published = path.join(directory, "semantic-surface");
  const oldRun = path.join(published, "runs", "old-hash");
  const staging = path.join(published, "runs", ".staging-control");
  try {
    await fs.mkdir(oldRun, { recursive: true });
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(oldRun, "scorecard.json"), "{\"scorecardHash\":\"old-hash\"}\n", "utf8");
    await fs.writeFile(path.join(published, "current.json"), "{\"scorecardHash\":\"old-hash\",\"run\":\"runs/old-hash\"}\n", "utf8");
    await fs.writeFile(path.join(published, "sentinel.txt"), "preserve me\n", "utf8");
    await fs.writeFile(path.join(staging, "scorecard.json"), "{\"scorecardHash\":\"new-hash\"}\n", "utf8");
    const finalRun = await publishVersionedEvidence(staging, published, "new-hash");
    assert.equal(finalRun, path.join(published, "runs", "new-hash"));
    assert.equal(await fs.readFile(path.join(published, "sentinel.txt"), "utf8"), "preserve me\n");
    assert.equal(await fs.readFile(path.join(oldRun, "scorecard.json"), "utf8"), "{\"scorecardHash\":\"old-hash\"}\n");
    const current = JSON.parse(await fs.readFile(path.join(published, "current.json"), "utf8"));
    assert.deepEqual(current, { schemaVersion: "slidewright-semantic-current/v1", scorecardHash: "new-hash", run: "runs/new-hash" });
    assert.equal(await fs.readFile(path.join(published, "scorecard.json"), "utf8"), "{\"scorecardHash\":\"new-hash\"}\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("versioned evidence publication accepts an identical replay but rejects a tampered hash directory", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-versioned-replay-"));
  const published = path.join(directory, "semantic-surface");
  const finalRun = path.join(published, "runs", "same-hash");
  const makeStaging = async (name, payload) => {
    const staging = path.join(published, "runs", name);
    await fs.mkdir(path.join(staging, "nested"), { recursive: true });
    await fs.writeFile(path.join(staging, "scorecard.json"), "{\"scorecardHash\":\"same-hash\"}\n", "utf8");
    await fs.writeFile(path.join(staging, "nested", "evidence.txt"), payload, "utf8");
    return staging;
  };
  try {
    await fs.mkdir(path.join(finalRun, "nested"), { recursive: true });
    await fs.writeFile(path.join(finalRun, "scorecard.json"), "{\"scorecardHash\":\"same-hash\"}\n", "utf8");
    await fs.writeFile(path.join(finalRun, "nested", "evidence.txt"), "trusted\n", "utf8");
    const identical = await makeStaging(".staging-identical", "trusted\n");
    assert.equal(await publishVersionedEvidence(identical, published, "same-hash"), finalRun);
    await assert.rejects(
      publishVersionedEvidence(await makeStaging(".staging-tampered", "tampered\n"), published, "same-hash"),
      /differs from staging bytes/,
    );
    assert.equal(await fs.readFile(path.join(finalRun, "nested", "evidence.txt"), "utf8"), "trusted\n");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("detached watchdog recovers an exact worker after forced parent termination", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows process watchdog control");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-watchdog-control-"));
  const completion = path.join(directory, "complete.marker");
  const ready = path.join(directory, "ready.marker");
  const reportPath = path.join(directory, "watchdog-report.json");
  const recordPath = path.join(directory, "control-ownership.json");
  const parent = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true, stdio: "ignore" });
  const worker = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true, stdio: "ignore" });
  const processStart = (pid) => {
    const result = spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  const waitFor = async (predicate, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Timed out waiting for watchdog control");
  };
  let watchdog;
  try {
    const parentStart = processStart(parent.pid);
    const workerStart = processStart(worker.pid);
    await fs.writeFile(recordPath, `${JSON.stringify({
      schemaVersion: "slidewright-owned-powerpoint/v1",
      processName: "POWERPNT",
      processId: 2147483000,
      processStartTime: "2000-01-01T00:00:00.0000000Z",
      workerProcessId: worker.pid,
      workerProcessName: "powershell",
      workerProcessStartTime: workerStart,
      ownedPresentationPaths: [],
    })}\n`, "utf8");
    watchdog = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(watchdogScriptPath),
      "-ParentProcessId", String(parent.pid),
      "-ParentProcessStartTime", parentStart,
      "-StagingDir", directory,
      "-CompletionMarker", completion,
      "-ReadyMarker", ready,
      "-RecoveryReportJson", reportPath,
      "-CleanupScript", fileURLToPath(cleanupScriptPath),
      "-ScanWindowMilliseconds", "2000",
    ], { windowsHide: true, stdio: "ignore" });
    await waitFor(async () => fs.access(ready).then(() => true, () => false));
    spawnSync("taskkill", ["/PID", String(parent.pid), "/F"], { windowsHide: true, stdio: "ignore" });
    await waitFor(async () => fs.access(reportPath).then(() => true, () => false));
    const report = JSON.parse((await fs.readFile(reportPath, "utf8")).replace(/^\uFEFF/u, ""));
    assert.equal(report.valid, true);
    assert.equal(report.safe, true);
    assert.equal(report.recovered, true);
    assert.equal(report.parentExitedWithoutCompletionMarker, true);
    assert.equal(report.recordsFound, 1);
    assert.equal(report.recoveries[0].workerMatched, true);
    assert.equal(report.recoveries[0].workerTerminated, true);
    assert.equal(report.recoveries[0].cleanup.reason, "owned-process-already-exited");
    const workerProbe = spawnSync("powershell", ["-NoProfile", "-Command", `if(Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue){exit 1}else{exit 0}`], { windowsHide: true });
    assert.equal(workerProbe.status, 0);
  } finally {
    for (const child of [parent, worker, watchdog]) {
      if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/F"], { windowsHide: true, stdio: "ignore" });
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("detached watchdog reconciles a delayed pre-ownership worker intent", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows process watchdog control");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-watchdog-intent-"));
  const completion = path.join(directory, "complete.marker");
  const ready = path.join(directory, "ready.marker");
  const reportPath = path.join(directory, "watchdog-report.json");
  const intentPath = path.join(directory, "delayed-worker-intent.json");
  const ownershipPath = path.join(directory, "delayed-ownership.json");
  const parent = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true, stdio: "ignore" });
  const worker = spawn("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], { windowsHide: true, stdio: "ignore" });
  const processStart = (pid) => spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", windowsHide: true }).stdout.trim();
  const waitFor = async (predicate, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Timed out waiting for delayed-intent watchdog control");
  };
  let watchdog;
  try {
    const parentStart = processStart(parent.pid);
    const workerStart = processStart(worker.pid);
    watchdog = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(watchdogScriptPath),
      "-ParentProcessId", String(parent.pid), "-ParentProcessStartTime", parentStart,
      "-StagingDir", directory, "-CompletionMarker", completion, "-ReadyMarker", ready,
      "-RecoveryReportJson", reportPath, "-CleanupScript", fileURLToPath(cleanupScriptPath),
      "-ScanWindowMilliseconds", "3000",
    ], { windowsHide: true, stdio: "ignore" });
    await waitFor(async () => fs.access(ready).then(() => true, () => false));
    spawnSync("taskkill", ["/PID", String(parent.pid), "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 750));
    await fs.writeFile(intentPath, `${JSON.stringify({
      schemaVersion: "slidewright-worker-intent/v1",
      workerProcessId: worker.pid,
      workerProcessName: "powershell",
      workerProcessStartTime: workerStart,
      purpose: "control",
      state: "started",
      ownershipRecordPath: ownershipPath,
    })}\n`, "utf8");
    await waitFor(async () => fs.access(reportPath).then(() => true, () => false));
    const report = JSON.parse((await fs.readFile(reportPath, "utf8")).replace(/^\uFEFF/u, ""));
    assert.equal(report.valid, true);
    assert.equal(report.intentsFound, 1);
    assert.equal(report.recordsFound, 0);
    assert.equal(report.recoveries[0].source, "worker-intent");
    assert.equal(report.recoveries[0].workerMatched, true);
    assert.equal(report.recoveries[0].workerTerminated, true);
  } finally {
    for (const child of [parent, worker, watchdog]) {
      if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/F"], { windowsHide: true, stdio: "ignore" });
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
