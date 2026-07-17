import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { matchesOwnedPowerPoint } from "../scripts/lib/owned-process-cleanup.mjs";
import { captureWorkerIdentity, captureWorkerIdentityWithRetry, terminateExactWorker } from "../scripts/lib/exact-worker-process.mjs";
import { publishVersionedEvidence } from "../scripts/lib/versioned-evidence-publish.mjs";
import {
  SEMANTIC_IMPLEMENTATION_PATHS,
  canonicalHash,
  captureCleanGit,
  collectReceiptTree,
  exactPathInventoryMatches,
  expectedSemanticReceiptPaths,
  normalizeCommandArgument,
  publishVerifiedSemanticEvidence,
  runForcedParentWatchdogControl,
  validateCommandReceipts,
  validateForcedParentWatchdogEvidence,
  validateNormalWatchdogEvidence,
  validatePowerPointQuiescenceEvidence,
  validateTimeoutCleanupEvidence,
} from "../scripts/lib/semantic-surface-evidence.mjs";

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
    assert.doesNotMatch(source, /@\(\(Get-Process POWERPNT[^\n]+\)\.Id\)/u, `${name} must not turn an empty process lookup into a one-item null array`);
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
  const timeoutProbe = await fs.readFile(new URL("powerpoint_timeout_probe.ps1", semanticScriptRoot), "utf8");
  const exactWorker = await fs.readFile(new URL("../scripts/lib/exact-worker-process.mjs", import.meta.url), "utf8");
  const cleanup = await fs.readFile(cleanupScriptPath, "utf8");
  assert.doesNotMatch(runner, /taskkill[^\n]*["']\/T["']/);
  assert.match(runner, /terminateExactWorker\(workerPid, expectedIdentity\)/);
  assert.match(exactWorker, /live\.processStartTime !== expected\.processStartTime/);
  assert.match(exactWorker, /spawnSync\("taskkill", \["\/PID", String\(processId\), "\/F"\]/);
  assert.doesNotMatch(exactWorker, /"\/T"/);
  assert.match(runner, /\.staging-/);
  assert.match(runner, /await publishVerifiedSemanticEvidence\(\{/);
  assert.doesNotMatch(runner, /fs\.rename\(published,/);
  assert.match(runner, /process\.once\("SIGINT"/);
  assert.match(runner, /slidewright-semantic-surface-scorecard\/v2/);
  assert.match(runner, /captureCleanGit\(root\)/);
  assert.match(runner, /captureSemanticImplementation\(root\)/);
  assert.match(runner, /implementation-snapshot/);
  assert.match(runner, /runForcedParentWatchdogControl/);
  assert.match(runner, /collectReceiptTree\(output\)/);
  assert.equal((runner.match(/verifySemanticSurfaceEvidence\(/gu) ?? []).length, 3);
  assert.ok(
    runner.indexOf("terminateWorkerOnly(child.pid, terminationIdentity)") < runner.indexOf("timeoutCleanup = cleanupOwnedPowerPoint"),
    "the worker COM reference must be released before natural-exit cleanup is evaluated",
  );
  assert.match(runner, /timeoutStartMarkerPath: timeoutProbeReadyPath/u);
  assert.match(runner, /exceeded 5000 ms during execution/u);
  assert.match(timeoutProbe, /Move-Item -Force -LiteralPath \$readyTemporary -Destination \$readyPath/u);
  assert.match(cleanup, /GetActiveObject\('PowerPoint\.Application'\)/);
  assert.match(cleanup, /Get-PresentationInventory/);
  assert.match(cleanup, /owned-process-has-foreign-presentations/);
  assert.match(cleanup, /owned-process-application-is-visible/);
  assert.match(cleanup, /owned-process-exited-after-closing-owned-presentations/);
  assert.match(cleanup, /\$closeCandidates \+= \$candidate/);
  assert.match(cleanup, /foreach \(\$candidate in \$closeCandidates\)/);
  assert.match(cleanup, /owned-process-state-changed-before-com-release/);
  assert.doesNotMatch(cleanup, /for \(\$index = \[int\]\$application\.Presentations\.Count/);
  assert.match(cleanup, /if \(\$result\.headlessAutomationFallback\) \{\s+\$application\.Quit\(\)/u);
  assert.match(cleanup, /PostThreadMessage\(\[uint32\]\$thread\.Id, 0x0012/u);
  assert.match(cleanup, /owned-headless-automation-process-exited-after-quit/u);
  assert.match(cleanup, /owned-headless-automation-process-exited-after-wm-quit/u);
  assert.doesNotMatch(cleanup, /Stop-Process|\.Kill\(\)/);
});

test("C08 implementation closure is explicit, sorted, and includes every safety surface", () => {
  const expected = [
    "fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png",
    "fixtures/semantic-surface/v1/semantic-contract.json",
    "package-lock.json",
    "package.json",
    "plugins/slidewright/skills/slidewright/scripts/lib/artifact-runtime.mjs",
    "plugins/slidewright/skills/slidewright/scripts/lib/normalize_pptx.py",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_surface.py",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/cleanup_owned_powerpoint.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_render_isolated.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_runner_watchdog.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_runner_watchdog_entrypoint.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_semantic_roundtrip.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_timeout_probe.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/presentation_path_identity.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/render_semantic_surface.mjs",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/semantic_surface_negative_controls.py",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/start_powerpoint_runner_watchdog.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/start_powerpoint_timeout_probe_control.ps1",
    "plugins/slidewright/skills/slidewright/scripts/semantic_surface/structure_semantic_surface.py",
    "scripts/fixtures/arm-powerpoint-watchdog-control.mjs",
    "scripts/lib/exact-worker-process.mjs",
    "scripts/lib/owned-process-cleanup.mjs",
    "scripts/lib/runner-watchdog.mjs",
    "scripts/lib/semantic-surface-evidence.mjs",
    "scripts/run-semantic-surface-benchmark.mjs",
    "scripts/setup-artifact-runtime.mjs",
    "tests/fixtures/never-arm-watchdog.mjs",
    "tests/fixtures/start-runner-watchdog.mjs",
    "tests/presentation-path-identity.test.mjs",
    "tests/runner-watchdog.test.mjs",
    "tests/semantic-surface.test.mjs",
  ];
  assert.deepEqual(SEMANTIC_IMPLEMENTATION_PATHS, expected);
});

test("C08 receipt tree binds additions, removals, and byte changes", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-semantic-receipts-"));
  try {
    await fs.mkdir(path.join(directory, "nested"));
    await fs.writeFile(path.join(directory, "a.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(directory, "nested", "b.txt"), "trusted\n", "utf8");
    await fs.writeFile(path.join(directory, "scorecard.json"), "excluded\n", "utf8");
    const first = await collectReceiptTree(directory);
    assert.deepEqual(first.files.map((item) => item.path), ["a.json", "nested/b.txt"]);
    assert.equal(first.treeSha256, canonicalHash(first.files));
    await fs.writeFile(path.join(directory, "nested", "b.txt"), "tampered\n", "utf8");
    const changed = await collectReceiptTree(directory);
    assert.notEqual(changed.treeSha256, first.treeSha256);
    await fs.writeFile(path.join(directory, "extra.bin"), "extra\n", "utf8");
    const added = await collectReceiptTree(directory);
    assert.notEqual(added.treeSha256, changed.treeSha256);
    await fs.rm(path.join(directory, "a.json"));
    const removed = await collectReceiptTree(directory);
    assert.notEqual(removed.treeSha256, added.treeSha256);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("C08 receipt inventory is exact and contract-derived", async () => {
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  const paths = expectedSemanticReceiptPaths(contract);
  assert.deepEqual(paths, [...paths].sort());
  assert.equal(new Set(paths).size, paths.length);
  assert.equal(paths.filter((item) => /^negative-controls\/[^/]+\.pptx$/u.test(item)).length, 9);
  assert.equal(paths.filter((item) => /^negative-controls\/[^/]+\.audit\.json$/u.test(item)).length, 9);
  assert.equal(paths.filter((item) => /^powerpoint-(?:source|roundtrip)-render\/slide-\d{2}\.png$/u.test(item)).length, 8);
  assert.ok(paths.includes("watchdog/forced-parent/watchdog/recovery.json"));
  assert.ok(paths.includes("watchdog/forced-parent/forced-parent-identity.json"));
  assert.ok(paths.includes("watchdog/normal/completion.marker"));
  assert.ok(paths.includes("powerpoint-interstage-quiescence.json"));
  assert.ok(paths.includes("implementation-snapshot/scripts/lib/semantic-surface-evidence.mjs"));
  assert.ok(paths.includes("implementation-snapshot/fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png"));
  const historicalPaths = expectedSemanticReceiptPaths(contract, ["fixtures/semantic-surface/v1/semantic-contract.json"]);
  assert.ok(historicalPaths.includes("implementation-snapshot/fixtures/semantic-surface/v1/semantic-contract.json"));
  assert.equal(historicalPaths.some((item) => item === "implementation-snapshot/scripts/lib/semantic-surface-evidence.mjs"), false);
  assert.equal(exactPathInventoryMatches([...paths].reverse(), paths), true);
  assert.equal(exactPathInventoryMatches(paths.slice(1), paths), false);
  assert.equal(exactPathInventoryMatches([...paths, "forged-extra.json"], paths), false);
});

test("C08 command receipts preserve flags and scalars while normalizing only paths", () => {
  const root = path.resolve("C:/control/repo");
  assert.equal(normalizeCommandArgument(root, "-NoProfile"), "-NoProfile");
  assert.equal(normalizeCommandArgument(root, "--contract"), "--contract");
  assert.equal(normalizeCommandArgument(root, "120"), "120");
  assert.equal(normalizeCommandArgument(root, "$p=Get-Process POWERPNT"), "$p=Get-Process POWERPNT");
  assert.equal(normalizeCommandArgument(root, path.join(root, "fixtures", "contract.json")), "<repo>/fixtures/contract.json");
  assert.equal(normalizeCommandArgument(root, path.resolve(os.tmpdir(), "slides_test.py")), "<external>/slides_test.py");
});

test("C08 watchdog validators reject forged identities, markers, recovery, and survivors", () => {
  const parent = { processId: 101, processName: "node", processStartTime: "2026-07-17T00:00:00.0000000Z" };
  const worker = { processId: 102, processName: "powershell", processStartTime: "2026-07-17T00:00:01.0000000Z" };
  const watchdog = { processId: 103, processName: "powershell", processStartTime: "2026-07-17T00:00:02.0000000Z", identityReceiptSha256: "e".repeat(64), readyMarkerSha256: "f".repeat(64) };
  const startup = { enabled: true, ...watchdog, identityReceiptSha256: "a".repeat(64), readyMarkerSha256: "b".repeat(64) };
  const normal = {
    schemaVersion: "slidewright-watchdog-normal-run/v1", valid: true, startup, finalIdentity: watchdog,
    exactIdentityPreservedAtFinalization: true, identityReceiptSha256: startup.identityReceiptSha256,
    readyMarkerSha256: startup.readyMarkerSha256, completionMarkerSha256: "c".repeat(64), diagnosticLogSha256: "d".repeat(64),
    identityReceiptExact: true, readyMarkerExact: true, completionMarkerExact: true,
    recoveryReportAbsent: true, finalPowerPointQuiescence: { valid: true }, activeWorkerCount: 0,
  };
  const identityReceipt = { schemaVersion: "slidewright-runner-watchdog-identity/v1", ...watchdog };
  assert.equal(validateNormalWatchdogEvidence({ summary: normal, identityReceipt, readyText: "\uFEFFready\r\n", completionText: "complete\n", diagnosticSha256: "d".repeat(64) }), true);
  assert.throws(() => validateNormalWatchdogEvidence({ summary: normal, identityReceipt: { ...identityReceipt, processStartTime: "forged" }, readyText: "ready", completionText: "complete\n", diagnosticSha256: "d".repeat(64) }), /identity receipt is forged/u);
  assert.throws(() => validateNormalWatchdogEvidence({ summary: normal, identityReceipt, readyText: "ready", completionText: "forged", diagnosticSha256: "d".repeat(64) }), /completion marker is invalid/u);

  const armed = { schemaVersion: "slidewright-watchdog-forced-parent-armed/v1", valid: true, parentIdentity: parent, workerIdentity: worker, watchdog };
  const intent = { schemaVersion: "slidewright-worker-intent/v1", state: "started", workerProcessId: worker.processId, workerProcessName: worker.processName, workerProcessStartTime: worker.processStartTime };
  const ownership = { schemaVersion: "slidewright-owned-powerpoint/v1", processName: "POWERPNT", expectedApplicationVisible: false, workerProcessId: worker.processId, workerProcessName: worker.processName, workerProcessStartTime: worker.processStartTime };
  const recovery = { schemaVersion: "slidewright-runner-watchdog/v1", valid: true, safe: true, recovered: true, parentProcessId: parent.processId, parentIdentityMatched: true, parentExitedWithoutCompletionMarker: true, intentsFound: 1, recordsFound: 1, recoveries: [{ workerMatched: true, workerTerminated: true, cleanup: { valid: true, cleaned: true } }], liveWorkerIdentities: [], newPowerPointProcesses: [], problems: [] };
  const forced = { schemaVersion: "slidewright-watchdog-forced-parent-control/v1", valid: true, failure: null, parentIdentity: parent, parentTermination: { matched: true, terminated: true }, recoveryValid: true, processAbsence: { parent: true, worker: true, watchdog: true }, initialPowerPoint: [], finalPowerPoint: [], newPowerPoint: [], ownershipCleanup: { valid: true, cleaned: true } };
  const args = {
    summary: forced, armed, recovery, ownership, intent,
    parentIdentityReceipt: { schemaVersion: "slidewright-forced-parent-identity/v1", ...parent },
    workerIdentityReceipt: worker,
    watchdogIdentityReceipt: watchdog,
    watchdogIdentityReceiptSha256: watchdog.identityReceiptSha256,
    readyMarkerSha256: watchdog.readyMarkerSha256,
    readyText: "\uFEFFready\r\n",
  };
  assert.equal(validateForcedParentWatchdogEvidence(args), true);
  assert.throws(() => validateForcedParentWatchdogEvidence({ ...args, recovery: { ...recovery, problems: ["forged"] } }), /recovery report is invalid/u);
  assert.throws(() => validateForcedParentWatchdogEvidence({ ...args, summary: { ...forced, processAbsence: { parent: true, worker: false, watchdog: true } } }), /survivor proof is invalid/u);
  assert.throws(() => validateForcedParentWatchdogEvidence({ ...args, readyText: "forged" }), /ready-marker bytes drifted/u);
  assert.throws(() => validateForcedParentWatchdogEvidence({ ...args, watchdogIdentityReceiptSha256: "0".repeat(64) }), /identity or ready-marker bytes drifted/u);
});

test("C08 quiescence validator rederives raw checkpoints and scorecard bindings", () => {
  const clear = { valid: true, waitedMs: 100, polls: 2, reason: "two-consecutive-clear-polls" };
  const checkpoints = [
    { stage: "after-semantic-roundtrip", ...clear },
    { stage: "between-source-and-roundtrip-render", ...clear },
    { stage: "after-roundtrip-render", ...clear },
  ];
  const valid = { initial: clear, interStage: { schemaVersion: "slidewright-powerpoint-quiescence-checkpoints/v1", valid: true, checkpoints }, scorecardInitial: clear, scorecardInterStage: checkpoints, platform: "win32" };
  assert.equal(validatePowerPointQuiescenceEvidence(valid), true);
  assert.throws(() => validatePowerPointQuiescenceEvidence({ ...valid, initial: { ...clear, polls: 1 } }), /scorecard binding drifted|two clear polls/u);
  assert.throws(() => validatePowerPointQuiescenceEvidence({ ...valid, interStage: { ...valid.interStage, checkpoints: checkpoints.map((item, index) => index === 1 ? { ...item, reason: "forged" } : item) } }), /scorecard binding drifted|two clear polls/u);
});

test("C08 timeout cleanup validator rejects trusted-summary forgeries", () => {
  const ownership = { schemaVersion: "slidewright-owned-powerpoint/v1", processName: "POWERPNT", processId: 500, processStartTime: "2026-07-17T00:00:00.0000000Z", purpose: "timeout-cleanup-negative-control", expectedApplicationVisible: false, ownedPresentationPaths: [] };
  const cleanup = { valid: true, cleaned: true, safeRefusal: false, reason: "owned-process-exited-after-com-release" };
  const postCleanup = { valid: true, cleaned: true, safeRefusal: false, reason: "owned-process-already-exited" };
  const control = { valid: true, workerTimedOut: true, firstCleanup: cleanup, ownedProcessAbsentAfterFirstCleanup: true, ownedProcessAbsentAfterCleanup: true, ownershipRecordSha256: "a".repeat(64), readyMarkerSha256: "b".repeat(64), postCleanup, errorSha256: "c".repeat(64) };
  const valid = { control, ownership, ownershipSha256: "a".repeat(64), readyMarkerSha256: "b".repeat(64), readyText: "\uFEFFready\r\n" };
  assert.equal(validateTimeoutCleanupEvidence(valid), true);
  assert.throws(() => validateTimeoutCleanupEvidence({ ...valid, control: { ...control, firstCleanup: { ...cleanup, reason: "forged" } } }), /first timeout cleanup/u);
  assert.throws(() => validateTimeoutCleanupEvidence({ ...valid, control: { ...control, ownedProcessAbsentAfterCleanup: false } }), /absence claims/u);
  assert.throws(() => validateTimeoutCleanupEvidence({ ...valid, control: { ...control, postCleanup: { ...postCleanup, reason: "forged" } } }), /post-cleanup/u);
  assert.throws(() => validateTimeoutCleanupEvidence({ ...valid, readyText: "forged" }), /ready-marker bytes drifted/u);
  assert.throws(() => validateTimeoutCleanupEvidence({ ...valid, ownershipSha256: "0".repeat(64) }), /ownership or ready-marker bytes drifted/u);
});

function commandReceipt(command, args, timedOut = false) {
  return { command, args, exitCode: timedOut ? 1 : 0, timedOut, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) };
}

function commandPoll() {
  return { command: "powershell", args: ["-NoProfile", "-Command", "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0"], exitCode: 0, timedOut: false, stdoutSha256: "a".repeat(64), stderrSha256: "b".repeat(64) };
}

test("C08 command validator binds the exact stage sequence and intended timeout", () => {
  const output = "<repo>/outputs/semantic-surface/runs/.staging-123-456";
  const semantic = "<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface";
  const node = "<external>/node.exe";
  const python = "<external>/python.exe";
  const contract = "<repo>/fixtures/semantic-surface/v1/semantic-contract.json";
  const asset = "<repo>/fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png";
  const manifest = `${output}/frozen-manifest.json`;
  const source = `${output}/semantic-surface.pptx`;
  const roundtrip = `${output}/powerpoint-roundtrip.pptx`;
  const prePowerPoint = [];
  for (let index = 1; index <= 3; index += 1) {
    const base = `${output}/export-${index}-base.pptx`;
    const raw = `${output}/export-${index}-structured.pptx`;
    const structured = index === 1 ? source : `${output}/export-${index}.pptx`;
    prePowerPoint.push(
      commandReceipt(node, [`${semantic}/render_semantic_surface.mjs`, base, index === 1 ? `${output}/artifact-previews` : "", asset]),
      commandReceipt(python, [`${semantic}/structure_semantic_surface.py`, base, raw, "--contract", contract]),
      commandReceipt(python, ["<repo>/plugins/slidewright/skills/slidewright/scripts/lib/normalize_pptx.py", raw, "--out", structured, "--report-json", `${output}/normalize-${index}.json`]),
    );
  }
  prePowerPoint.push(
    commandReceipt(python, [`${semantic}/audit_semantic_surface.py`, source, "--contract", contract, "--freeze-manifest", manifest, "--json", `${output}/freeze-report.json`]),
    commandReceipt(python, [`${semantic}/audit_semantic_surface.py`, source, "--manifest", manifest, "--contract", contract, "--json", `${output}/export-1-audit.json`]),
    commandReceipt(python, [`${semantic}/audit_semantic_surface.py`, `${output}/export-2.pptx`, "--manifest", manifest, "--contract", contract, "--json", `${output}/export-2-audit.json`]),
    commandReceipt(python, [`${semantic}/audit_semantic_surface.py`, `${output}/export-3.pptx`, "--manifest", manifest, "--contract", contract, "--json", `${output}/export-3-audit.json`]),
    commandReceipt(python, [`${semantic}/semantic_surface_negative_controls.py`, source, manifest, `${output}/negative-controls`, "--json", `${output}/negative-controls.json`]),
  );
  const polls = [commandPoll(), commandPoll()];
  const timeout = commandReceipt("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_timeout_probe.ps1`, "-OwnershipRecordJson", `${output}/powerpoint-timeout-probe-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-timeout-probe-worker-intent.json`, "-ReadyMarker", `${output}/powerpoint-timeout-probe.ready`, "-HoldSeconds", "120"], true);
  const roundtripCommand = commandReceipt("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_semantic_roundtrip.ps1`, "-InputPptx", source, "-OutputPptx", roundtrip, "-ReportJson", `${output}/powerpoint-roundtrip.json`, "-OwnershipRecordJson", `${output}/powerpoint-roundtrip-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-roundtrip-worker-intent.json`]);
  const roundtripAudit = commandReceipt(python, [`${semantic}/audit_semantic_surface.py`, roundtrip, "--manifest", manifest, "--contract", contract, "--allow-relationship-rebase", "--json", `${output}/powerpoint-roundtrip-audit.json`]);
  const sourceRender = commandReceipt("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_render_isolated.ps1`, "-InputPptx", source, "-OutputDir", `${output}/powerpoint-source-render`, "-ReportJson", `${output}/powerpoint-source-render.json`, "-OwnershipRecordJson", `${output}/powerpoint-source-render-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-source-render-worker-intent.json`]);
  const roundtripRender = commandReceipt("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${semantic}/powerpoint_render_isolated.ps1`, "-InputPptx", roundtrip, "-OutputDir", `${output}/powerpoint-roundtrip-render`, "-ReportJson", `${output}/powerpoint-roundtrip-render.json`, "-OwnershipRecordJson", `${output}/powerpoint-roundtrip-render-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-roundtrip-render-worker-intent.json`]);
  const commands = [...prePowerPoint, ...polls, timeout, roundtripCommand, roundtripAudit, ...polls, sourceRender, ...polls, roundtripRender, ...polls, commandReceipt(python, ["<external>/slides_test.py", source]), commandReceipt(python, ["<external>/slides_test.py", roundtrip]), ...polls];
  const valid = { schemaVersion: "slidewright-command-receipts/v1", logicalCommand: "npm run semantic-surface", commands };
  assert.equal(validateCommandReceipts(valid), true);
  const arbitraryTimeout = { ...commandPoll(), args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 120"], exitCode: 1, timedOut: true };
  assert.throws(() => validateCommandReceipts({ ...valid, commands: [...Array(30).fill(commandPoll()), arbitraryTimeout] }), /exact staging output path|unexpected command or argv sequence/u);
  const wrongTimeoutIndex = commands.findIndex((item) => item.timedOut);
  const wrongTimeout = [...commands];
  wrongTimeout[wrongTimeoutIndex] = { ...roundtripCommand, exitCode: 1, timedOut: true };
  assert.throws(() => validateCommandReceipts({ ...valid, commands: wrongTimeout }), /unexpected command or argv sequence|unexpected failure|sequence drifted/u);
  const structureIndex = commands.findIndex((item) => item.args[0]?.endsWith("/structure_semantic_surface.py"));
  const extraFlag = [...commands];
  extraFlag[structureIndex] = { ...extraFlag[structureIndex], args: [...extraFlag[structureIndex].args, "--evil-unexpected"] };
  assert.throws(() => validateCommandReceipts({ ...valid, commands: extraFlag }), /unexpected command or argv sequence/u);
  const wrongPath = [...commands];
  wrongPath[structureIndex] = { ...wrongPath[structureIndex], args: wrongPath[structureIndex].args.map((arg) => arg.endsWith("export-1-base.pptx") ? `${output}/export-2-base.pptx` : arg) };
  assert.throws(() => validateCommandReceipts({ ...valid, commands: wrongPath }), /unexpected command or argv sequence/u);
  const fabricatedPath = [...commands];
  fabricatedPath[structureIndex] = { ...fabricatedPath[structureIndex], args: ["<repo>/-NoProfile", ...fabricatedPath[structureIndex].args.slice(1)] };
  assert.throws(() => validateCommandReceipts({ ...valid, commands: fabricatedPath }), /fabricated a path/u);
});

test("exact identity capture retries transient misses and never invents absence", async () => {
  let attempts = 0;
  const identity = await captureWorkerIdentityWithRetry(9001, { platform: "win32", timeoutMs: 100, pollMs: 1, capture: () => (++attempts < 3 ? null : { processId: 9001, processName: "node", processStartTime: "2026-07-17T00:00:00.0000000Z" }) });
  assert.equal(attempts, 3);
  assert.equal(identity.processId, 9001);
  assert.equal(await captureWorkerIdentityWithRetry(9002, { platform: "win32", timeoutMs: 0, capture: () => null }), null);
});

test("C08 clean Git gate rejects tracked and untracked drift", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-semantic-git-"));
  const runGit = (args) => spawnSync("git", args, { cwd: directory, encoding: "utf8", windowsHide: true });
  try {
    assert.equal(runGit(["init", "-q"]).status, 0);
    assert.equal(runGit(["config", "user.email", "control@example.invalid"]).status, 0);
    assert.equal(runGit(["config", "user.name", "Slidewright Control"]).status, 0);
    await fs.writeFile(path.join(directory, "tracked.txt"), "trusted\n", "utf8");
    assert.equal(runGit(["add", "tracked.txt"]).status, 0);
    assert.equal(runGit(["commit", "-qm", "control"]).status, 0);
    assert.equal(captureCleanGit(directory).clean, true);
    await fs.writeFile(path.join(directory, "untracked.txt"), "drift\n", "utf8");
    assert.throws(() => captureCleanGit(directory), /requires a clean exact Git checkout/u);
    await fs.rm(path.join(directory, "untracked.txt"));
    await fs.writeFile(path.join(directory, "tracked.txt"), "drift\n", "utf8");
    assert.throws(() => captureCleanGit(directory), /requires a clean exact Git checkout/u);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("forced-parent control tears down an exact fixture that never arms", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows exact teardown control");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-forced-parent-failure-"));
  try {
    await assert.rejects(
      runForcedParentWatchdogControl({
        root: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
        output: directory,
        semanticDir: fileURLToPath(semanticScriptRoot),
        fixture: fileURLToPath(new URL("fixtures/never-arm-watchdog.mjs", import.meta.url)),
        armingTimeoutMs: 750,
        recoveryTimeoutMs: 750,
      }),
      /failed after exact teardown/u,
    );
    const summary = JSON.parse(await fs.readFile(path.join(directory, "watchdog", "forced-parent", "summary.json"), "utf8"));
    assert.deepEqual(summary.processAbsence, { parent: true, worker: false, watchdog: false });
    assert.deepEqual(summary.newPowerPoint, []);
    assert.equal(captureWorkerIdentity(summary.parentIdentity.processId), null);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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

test("versioned publication verifies the final run before advancing current", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-versioned-verify-"));
  const published = path.join(directory, "semantic-surface");
  const staging = path.join(published, "runs", ".staging-control");
  try {
    await fs.mkdir(staging, { recursive: true });
    await fs.writeFile(path.join(staging, "scorecard.json"), "{\"scorecardHash\":\"blocked-hash\"}\n", "utf8");
    await fs.mkdir(published, { recursive: true });
    await fs.writeFile(path.join(published, "current.json"), "{\"scorecardHash\":\"old\",\"run\":\"runs/old\"}\n", "utf8");
    await assert.rejects(
      publishVerifiedSemanticEvidence({ staging, published, scorecardHash: "blocked-hash", verify: async () => { throw new Error("semantic verification failed"); } }),
      /semantic verification failed/u,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(published, "current.json"), "utf8")), { scorecardHash: "old", run: "runs/old" });
    await assert.rejects(fs.access(path.join(published, "scorecard.json")));
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
