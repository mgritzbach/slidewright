#!/usr/bin/env node
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateFidelityFixtures } from "../plugins/slidewright/skills/slidewright/scripts/repair_free/generate_fidelity_fixtures.mjs";
import { setupOpenXmlValidator } from "../plugins/slidewright/skills/slidewright/scripts/repair_free/setup_openxml.mjs";
import { cleanupOwnedPowerPoint } from "./lib/owned-process-cleanup.mjs";
import { captureWorkerIdentityWithRetry, terminateExactWorker } from "./lib/exact-worker-process.mjs";
import {
  canonicalHash, captureArtifactToolRuntime, captureRepairFreeImplementation, collectRepairFreeEvidenceTree,
  sha256File, validateRepairFreeContract, verifyRepairFreeEvidence,
  verifyRepairFreeFixtureDirectory, verifyRepairFreeScorecard,
} from "./lib/repair-free-evidence.mjs";
import { publishVersionedEvidence } from "./lib/versioned-evidence-publish.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRoot = await fs.realpath(root);
const benchmarkStartedAtMs = Date.now();
const benchmarkStartedAt = new Date(benchmarkStartedAtMs).toISOString();
const allowDirty = process.argv.includes("--allow-dirty");
const reuseReleaseOutputs = process.argv.includes("--reuse-release-outputs");
const contractPath = path.join(root, "fixtures", "repair-free", "v1", "fixture-contract.json");
const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
const outputRoot = path.join(root, "outputs", "repair-free");
const runsRoot = path.join(outputRoot, "runs");
const staging = path.join(runsRoot, `.staging-${process.pid}-${Date.now()}`);
const scripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "repair_free");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function logical(file) { return path.relative(root, file).split(path.sep).join("/"); }
function parseJson(file) { return fs.readFile(file, "utf8").then((value) => JSON.parse(value.replace(/^\uFEFF/u, ""))); }
function confined(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularConfinedFile(parent, child, label) {
  const absolute = path.resolve(child);
  if (!confined(parent, absolute)) throw new Error(`${label} escapes its allowed root.`);
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) throw new Error(`${label} is missing, empty, or not a regular file.`);
  const [realParent, realChild] = await Promise.all([fs.realpath(parent), fs.realpath(absolute)]);
  if (!confined(realParent, realChild)) throw new Error(`${label} realpath escapes its allowed root.`);
  return { path: realChild, stat };
}

async function assertSafeWritableRoot(target, label) {
  const absolute = path.resolve(target);
  if (!confined(realRoot, absolute)) throw new Error(`${label} is outside the real repository root.`);
  let current = realRoot;
  for (const segment of path.relative(realRoot, absolute).split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error(`${label} contains a symlink or junction at ${current}.`);
  }
  const stat = await fs.lstat(absolute).catch(() => null);
  if (stat) {
    const real = await fs.realpath(absolute);
    if (!confined(realRoot, real)) throw new Error(`${label} realpath escapes the repository.`);
  }
}

const receipts = [];
let receiptSequence = 0;
function safeReceiptId(id) { return String(id ?? "command").replace(/[^a-zA-Z0-9._-]+/gu, "-"); }
function writeCommandStreams(id, streams) {
  const sequence = String(++receiptSequence).padStart(4, "0");
  const directory = path.join(staging, "command-receipts");
  fsSync.mkdirSync(directory, { recursive: true });
  return streams.map(([name, value]) => {
    const bytes = Buffer.from(value || "", "utf8");
    const relative = `command-receipts/${sequence}-${safeReceiptId(id)}.${name}.txt`;
    fsSync.writeFileSync(path.join(staging, ...relative.split("/")), bytes);
    return { name, path: relative, bytes: bytes.length, sha256: sha256(bytes) };
  });
}
const activeChildren = new Map();
let signalCleanupStarted = false;
function cleanupForSignal(signal) {
  if (signalCleanupStarted) return;
  signalCleanupStarted = true;
  for (const [pid, item] of activeChildren) {
    terminateExactWorker(pid, item.identity);
    if (item.ownership) cleanupOwnedPowerPoint(item.ownership, { root });
    if (item.stop) fsSync.writeFileSync(item.stop, `signal-${signal}\n`, "utf8");
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.once("SIGINT", () => cleanupForSignal("SIGINT"));
process.once("SIGTERM", () => cleanupForSignal("SIGTERM"));

function run(command, args, { expected = 0, id = null } = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
  const streams = writeCommandStreams(id, [["stdout", result.stdout], ["stderr", result.stderr]]);
  const receipt = { id, command, args, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, timedOut: result.error?.code === "ETIMEDOUT", streams };
  receipts.push(receipt);
  if (result.error) throw result.error;
  if (result.status !== expected) throw new Error(`${command} ${args.join(" ")} returned ${result.status}; expected ${expected}.\n${result.stderr || result.stdout}`);
  return result;
}

function observePowerPointProcesses(id) {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$items=@(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { [ordered]@{ processId=[int]$_.Id; processStartTime=$_.StartTime.ToUniversalTime().ToString('o'); mainWindowTitle=[string]$_.MainWindowTitle } })",
    "ConvertTo-Json -InputObject $items -Compress",
  ].join("; ");
  const output = run("powershell", ["-NoProfile", "-Command", command], { id }).stdout.trim();
  if (!output) return [];
  const parsed = JSON.parse(output.replace(/^\uFEFF/u, ""));
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    if (!Number.isInteger(item.processId) || !Number.isFinite(Date.parse(item.processStartTime)) || typeof item.mainWindowTitle !== "string") {
      throw new Error(`PowerPoint quiescence receipt '${id}' returned an invalid process identity.`);
    }
  }
  return items;
}

function requirePowerPointQuiescence(id) {
  const processes = observePowerPointProcesses(id);
  if (processes.length > 0) throw new Error(`C04 requires global PowerPoint quiescence at '${id}'; observed ${JSON.stringify(processes)}.`);
  return processes;
}

function gitState() {
  const commit = run("git", ["rev-parse", "HEAD"], { id: "git-commit" }).stdout.trim();
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { id: "git-status" }).stdout.trim();
  return { commit, clean: status.length === 0, status };
}

function validateContract() {
  validateRepairFreeContract(contract);
}

async function ensureReleaseOutputs() {
  if (reuseReleaseOutputs) return;
  const outputNames = [
    "fidelity", "copy-resilience", "semantic-mutation", "template", "design-profile",
    "feedback-contract", "ingestion", "prompt-robustness", "demo", "semantic-surface",
  ];
  const outputs = path.join(root, "outputs");
  for (const name of outputNames) {
    const target = path.join(outputs, name);
    if (!confined(outputs, target)) throw new Error(`Unsafe C04 producer output path: ${target}`);
    const stat = await fs.lstat(target).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) await fs.unlink(target);
    else {
      const realTarget = await fs.realpath(target);
      if (!confined(realRoot, realTarget)) throw new Error(`C04 producer output realpath escapes the repository: ${target}`);
      await fs.rm(target, { recursive: true, force: true });
    }
  }
  const commands = [
    "setup:runtime", "fidelity", "copy-resilience", "template", "design-profile",
    "feedback-contract", "ingestion", "prompt-robustness", "demo", "semantic-surface", "semantic-mutation",
  ];
  for (const name of commands) {
    process.stdout.write(`C04 producer: npm run ${name}\n`);
    run(npmCommand, ["run", name], { id: `producer-${name}` });
  }
}

async function resolveFixture(item, generated) {
  if (item.resolver === "generated-fidelity") {
    const found = generated.find((fixture) => fixture.id === item.value);
    if (!found) throw new Error(`Generated fidelity fixture is missing: ${item.value}`);
    return (await regularConfinedFile(staging, path.resolve(found.path), `Generated fixture ${item.id}`));
  }
  const outputs = path.join(root, "outputs");
  if (item.resolver === "direct") return regularConfinedFile(outputs, path.resolve(root, item.value), `Direct fixture ${item.id}`);
  if (item.resolver === "current-run") {
    const pointerPath = path.resolve(root, item.pointer);
    const pointerFile = await regularConfinedFile(outputs, pointerPath, `Current pointer ${item.id}`);
    const pointer = await parseJson(pointerFile.path);
    if (typeof pointer.run !== "string" || !pointer.run.startsWith("runs/")) throw new Error(`Invalid current-run pointer for ${item.id}.`);
    const pointerRoot = await fs.realpath(path.dirname(pointerFile.path));
    const runRoot = path.resolve(pointerRoot, pointer.run);
    if (!confined(pointerRoot, runRoot)) throw new Error(`Current-run pointer escapes its output root for ${item.id}.`);
    const runStat = await fs.lstat(runRoot);
    if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error(`Current-run directory is unsafe for ${item.id}.`);
    const realRun = await fs.realpath(runRoot);
    if (!confined(pointerRoot, realRun)) throw new Error(`Current-run realpath escapes its output root for ${item.id}.`);
    const resolved = path.resolve(realRun, item.value);
    return regularConfinedFile(realRun, resolved, `Current-run fixture ${item.id}`);
  }
  throw new Error(`Unsupported fixture resolver '${item.resolver}'.`);
}

function producerReceiptId(fixture) {
  if (fixture.resolver === "generated-fidelity") return "producer-in-run-design";
  if (fixture.category === "copy-stress") return "producer-copy-resilience";
  if (fixture.category === "native-semantic") return "producer-semantic-mutation";
  if (fixture.id === "template-edited") return "producer-template";
  if (fixture.id === "design-profile-derived") return "producer-design-profile";
  if (["feedback-contract-generated", "inherited-bullets-sanitized"].includes(fixture.id)) return "producer-feedback-contract";
  if (fixture.id === "ingestion-reconstruction") return "producer-ingestion";
  if (fixture.id.startsWith("prompt-")) return "producer-prompt-robustness";
  if (fixture.id === "fidelity-six-design-baseline") return "producer-fidelity";
  if (fixture.id === "semantic-surface-full") return "producer-semantic-surface";
  throw new Error(`No C04 producer binding exists for fixture ${fixture.id}.`);
}

async function runPowerPointFixture({ fixture, source, roundtrip, report, ownership, stop, watcherReady, watcherArmed, watcherReport, expectedRepairSignal = false, workerTimeoutMs = 120_000 }) {
  await Promise.all([ownership, stop, watcherReady, watcherArmed, watcherReport, report, roundtrip].map((file) => fs.rm(file, { force: true })));
  const receiptId = expectedRepairSignal ? "powerpoint-control-repair-dialog" : `powerpoint-${fixture.id}`;
  const logicalRoot = expectedRepairSignal ? "$RUN/negative-controls/powerpoint-repair-dialog" : `$RUN/fixtures/${fixture.id}`;
  const quiescenceBefore = requirePowerPointQuiescence(`powerpoint-quiescence-pre-${expectedRepairSignal ? "control-repair-dialog" : fixture.id}`);
  const watcherArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "watch_powerpoint_windows.ps1"), "-OwnershipRecordJson", ownership, "-StopMarker", stop, "-ReadyMarker", watcherReady, "-ArmedMarker", watcherArmed, "-ReportJson", watcherReport, "-TimeoutSeconds", "150"];
  const workerArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "powerpoint_repair_free_roundtrip.ps1"), "-FixtureId", fixture.id, "-InputPptx", source, "-OutputPptx", roundtrip, "-ReportJson", report, "-OwnershipRecordJson", ownership, "-ArmedMarker", watcherArmed, "-StopMarker", stop];
  const startedAt = new Date().toISOString();
  const watcher = spawn("powershell", watcherArgs, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const watcherIdentity = watcher.pid ? await captureWorkerIdentityWithRetry(watcher.pid) : null;
  if (!watcherIdentity) { watcher.kill(); throw new Error(`Could not capture the exact C04 watcher identity for ${fixture.id}.`); }
  if (watcher.pid) activeChildren.set(watcher.pid, { identity: watcherIdentity, stop });
  const readyDeadline = Date.now() + 15_000;
  while (!fsSync.existsSync(watcherReady) && Date.now() < readyDeadline && watcher.exitCode === null) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!fsSync.existsSync(watcherReady)) {
    terminateExactWorker(watcher.pid, watcherIdentity);
    throw new Error(`PowerPoint watcher did not arm before launching fixture ${fixture.id}.`);
  }
  const workerStartedAt = new Date().toISOString();
  const worker = spawn("powershell", workerArgs, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const workerIdentity = worker.pid ? await captureWorkerIdentityWithRetry(worker.pid) : null;
  if (!workerIdentity) {
    worker.kill();
    await fs.writeFile(stop, "worker-identity-unavailable\n", "utf8");
    terminateExactWorker(watcher.pid, watcherIdentity);
    throw new Error(`Could not capture the exact C04 worker identity for ${fixture.id}.`);
  }
  if (worker.pid) activeChildren.set(worker.pid, { identity: workerIdentity, ownership, stop });
  let watcherStdout = ""; let watcherStderr = ""; let workerStdout = ""; let workerStderr = "";
  watcher.stdout.setEncoding("utf8"); watcher.stderr.setEncoding("utf8"); worker.stdout.setEncoding("utf8"); worker.stderr.setEncoding("utf8");
  watcher.stdout.on("data", (value) => { watcherStdout += value; }); watcher.stderr.on("data", (value) => { watcherStderr += value; });
  worker.stdout.on("data", (value) => { workerStdout += value; }); worker.stderr.on("data", (value) => { workerStderr += value; });
  let timedOut = false; let workerTermination = null; let ownershipCleanup = null;
  const workerExit = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(async () => {
      timedOut = true;
      workerTermination = terminateExactWorker(worker.pid, workerIdentity);
      ownershipCleanup = cleanupOwnedPowerPoint(ownership, { root });
      await fs.writeFile(stop, "timeout\n", "utf8");
      activeChildren.delete(worker.pid);
      finish({ code: null, signal: "worker-timeout" });
    }, workerTimeoutMs);
    worker.once("close", (code, signal) => { clearTimeout(timer); activeChildren.delete(worker.pid); finish({ code, signal }); });
    worker.once("error", (error) => { clearTimeout(timer); finish({ code: null, signal: null, error: error.message }); });
  });
  if (!fsSync.existsSync(stop)) await fs.writeFile(stop, "worker-exited\n", "utf8");
  const watcherExit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      terminateExactWorker(watcher.pid, watcherIdentity);
      resolve({ code: null, signal: "watcher-timeout" });
    }, 15_000);
    watcher.once("close", (code, signal) => { clearTimeout(timer); activeChildren.delete(watcher.pid); resolve({ code, signal }); });
    watcher.once("error", (error) => { clearTimeout(timer); resolve({ code: null, signal: null, error: error.message }); });
  });
  const receipt = {
    id: receiptId,
    command: "powershell",
    args: workerArgs,
    startedAt,
    workerStartedAt,
    finishedAt: new Date().toISOString(),
    exitCode: workerExit.code,
    signal: workerExit.signal,
    timedOut,
    workerIdentity,
    workerTermination,
    ownershipCleanup,
    expectedRepairSignal,
    workerTimeoutMs,
    normalizedArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$IMPLEMENTATION/powerpoint_repair_free_roundtrip.ps1", "-FixtureId", fixture.id, "-InputPptx", `${logicalRoot}/source.pptx`, "-OutputPptx", `${logicalRoot}/roundtrip.pptx`, "-ReportJson", `${logicalRoot}/powerpoint.json`, "-OwnershipRecordJson", `${logicalRoot}/ownership.json`, "-ArmedMarker", `${logicalRoot}/watcher-armed.marker`, "-StopMarker", `${logicalRoot}/stop.marker`],
    streams: writeCommandStreams(`powerpoint-${fixture.id}`, [["worker-stdout", workerStdout], ["worker-stderr", workerStderr], ["watcher-stdout", watcherStdout], ["watcher-stderr", watcherStderr]]),
    watcher: {
      args: watcherArgs,
      normalizedArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$IMPLEMENTATION/watch_powerpoint_windows.ps1", "-OwnershipRecordJson", `${logicalRoot}/ownership.json`, "-StopMarker", `${logicalRoot}/stop.marker`, "-ReadyMarker", `${logicalRoot}/watcher-ready.marker`, "-ArmedMarker", `${logicalRoot}/watcher-armed.marker`, "-ReportJson", `${logicalRoot}/window-watch.json`, "-TimeoutSeconds", "150"],
      exitCode: watcherExit.code,
      signal: watcherExit.signal,
      identity: watcherIdentity,
    },
  };
  receipts.push(receipt);
  if (expectedRepairSignal) {
    if (!ownershipCleanup) ownershipCleanup = cleanupOwnedPowerPoint(ownership, { root });
    receipt.ownershipCleanup = ownershipCleanup;
    const quiescenceAfter = observePowerPointProcesses("powerpoint-quiescence-post-control-repair-dialog");
    receipt.quiescence = { before: quiescenceBefore, after: quiescenceAfter };
    const watcherEvidence = await parseJson(watcherReport).catch(() => null);
    const repairObserved = watcherEvidence?.valid === false && watcherEvidence?.ownedProcessExited === true
      && ((watcherEvidence?.unexpectedVisibleWindows?.length ?? 0) > 0 || (watcherEvidence?.repairSignals?.length ?? 0) > 0);
    const rejected = watcherExit.code === 2 && repairObserved && quiescenceAfter.length === 0
      && (!timedOut || (ownershipCleanup?.valid === true && ownershipCleanup?.cleaned === true));
    receipt.repairControl = { rejected, watcherValid: watcherEvidence?.valid ?? null, visibleWindowCount: watcherEvidence?.unexpectedVisibleWindows?.length ?? null, repairSignalCount: watcherEvidence?.repairSignals?.length ?? null };
    if (!rejected) throw new Error(`Real PowerPoint repair control was not safely rejected: ${JSON.stringify(receipt.repairControl)}; worker=${workerExit.code}, watcher=${watcherExit.code}, timedOut=${timedOut}.`);
    return receipt;
  }
  if (timedOut || workerExit.code !== 0 || watcherExit.code !== 0) {
    if (!ownershipCleanup) ownershipCleanup = cleanupOwnedPowerPoint(ownership, { root });
    receipt.ownershipCleanup = ownershipCleanup;
    throw new Error(`PowerPoint C04 worker failed for ${fixture.id}: worker=${workerExit.code}, watcher=${watcherExit.code}, timedOut=${timedOut}; ${workerStderr || watcherStderr}`);
  }
  const quiescenceAfter = observePowerPointProcesses(`powerpoint-quiescence-post-${fixture.id}`);
  receipt.quiescence = { before: quiescenceBefore, after: quiescenceAfter };
  if (quiescenceAfter.length > 0) throw new Error(`C04 lost global PowerPoint quiescence after '${fixture.id}'; observed ${JSON.stringify(quiescenceAfter)}.`);
  return receipt;
}

async function auditOne(fixture, origin, openXmlRuntime) {
  const directory = path.join(staging, "fixtures", fixture.id);
  await fs.mkdir(directory, { recursive: true });
  const paths = {
    source: path.join(directory, "source.pptx"),
    sourceOpc: path.join(directory, "source-opc.json"),
    sourceOpenXml: path.join(directory, "source-openxml.json"),
    sourceInventory: path.join(directory, "source-inventory.json"),
    roundtrip: path.join(directory, "roundtrip.pptx"),
    powerpoint: path.join(directory, "powerpoint.json"),
    ownership: path.join(directory, "ownership.json"),
    stop: path.join(directory, "stop.marker"),
    watcher: path.join(directory, "window-watch.json"),
    watcherReady: path.join(directory, "watcher-ready.marker"),
    watcherArmed: path.join(directory, "watcher-armed.marker"),
    roundtripOpc: path.join(directory, "roundtrip-opc.json"),
    roundtripOpenXml: path.join(directory, "roundtrip-openxml.json"),
    roundtripInventory: path.join(directory, "roundtrip-inventory.json"),
  };
  await fs.copyFile(origin.path, paths.source);
  const source = paths.source;
  const copiedHash = await sha256File(source);
  if (copiedHash !== origin.sha256) throw new Error(`C04 source snapshot changed while copying fixture ${fixture.id}.`);
  run(python, [path.join(scripts, "audit_opc_package.py"), source, "--json", paths.sourceOpc], { id: `opc-source-${fixture.id}` });
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "validate_openxml.ps1"), "-InputPptx", source, "-AssemblyPath", openXmlRuntime.liveAssemblyPath, "-ReportJson", paths.sourceOpenXml], { id: `openxml-source-${fixture.id}` });
  run(python, [path.join(scripts, "semantic_inventory.py"), source, "--json", paths.sourceInventory], { id: `inventory-source-${fixture.id}` });
  await runPowerPointFixture({ fixture, source, roundtrip: paths.roundtrip, report: paths.powerpoint, ownership: paths.ownership, stop: paths.stop, watcherReady: paths.watcherReady, watcherArmed: paths.watcherArmed, watcherReport: paths.watcher });
  run(python, [path.join(scripts, "audit_opc_package.py"), paths.roundtrip, "--json", paths.roundtripOpc], { id: `opc-roundtrip-${fixture.id}` });
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "validate_openxml.ps1"), "-InputPptx", paths.roundtrip, "-AssemblyPath", openXmlRuntime.liveAssemblyPath, "-ReportJson", paths.roundtripOpenXml], { id: `openxml-roundtrip-${fixture.id}` });
  run(python, [path.join(scripts, "semantic_inventory.py"), paths.roundtrip, "--json", paths.roundtripInventory], { id: `inventory-roundtrip-${fixture.id}` });
  const [sourceOpc, sourceOpenXml, sourceInventory, powerpoint, watcher, roundtripOpc, roundtripOpenXml, roundtripInventory] = await Promise.all([
    parseJson(paths.sourceOpc), parseJson(paths.sourceOpenXml), parseJson(paths.sourceInventory), parseJson(paths.powerpoint), parseJson(paths.watcher), parseJson(paths.roundtripOpc), parseJson(paths.roundtripOpenXml), parseJson(paths.roundtripInventory),
  ]);
  const sourceHash = await sha256File(source);
  const producer = receipts.find((item) => item.id === origin.producerReceiptId);
  const producerStartedMs = Date.parse(producer?.startedAt);
  const producerFinishedMs = Date.parse(producer?.finishedAt);
  const sourceFresh = !reuseReleaseOutputs && producer?.exitCode === 0 && producer?.timedOut === false
    && Number.isFinite(producerStartedMs) && Number.isFinite(producerFinishedMs)
    && origin.stat.mtimeMs >= benchmarkStartedAtMs - 2_000 && origin.stat.mtimeMs >= producerStartedMs - 2_000 && origin.stat.mtimeMs <= producerFinishedMs + 2_000;
  const sourceUnchanged = sourceHash === sourceInventory.inputSha256 && sourceHash === powerpoint.sourceSha256;
  const semanticInventoryPreserved = sourceInventory.inventorySha256 === roundtripInventory.inventorySha256;
  const valid = [sourceOpc, sourceOpenXml, powerpoint, watcher, roundtripOpc, roundtripOpenXml].every((item) => item.valid === true)
    && sourceUnchanged && semanticInventoryPreserved && powerpoint.exactLiveSemanticStatePreserved === true;
  return {
    id: fixture.id,
    category: fixture.category,
    valid,
    source: `fixtures/${fixture.id}/source.pptx`,
    sourceScope: "run",
    originPath: confined(staging, origin.path) ? path.relative(staging, origin.path).split(path.sep).join("/") : logical(origin.path),
    originScope: confined(staging, origin.path) ? "run" : "workspace",
    originMtimeMs: origin.stat.mtimeMs,
    producerReceiptId: origin.producerReceiptId,
    sourceFresh,
    sourceSha256: sourceHash,
    roundtrip: `fixtures/${fixture.id}/roundtrip.pptx`,
    roundtripSha256: await sha256File(paths.roundtrip),
    sourceUnchanged,
    semanticInventoryPreserved,
    inventorySha256: sourceInventory.inventorySha256,
    sourceOpcValid: sourceOpc.valid,
    sourceOpenXmlErrors: sourceOpenXml.errorCount,
    powerpointValid: powerpoint.valid,
    alertsEnabled: powerpoint.alertsEnabled,
    liveStatePreserved: powerpoint.exactLiveSemanticStatePreserved,
    visibleWindowCount: watcher.unexpectedVisibleWindows.length,
    repairSignalCount: watcher.repairSignals.length,
    ownedProcessExited: watcher.ownedProcessExited,
    roundtripOpcValid: roundtripOpc.valid,
    roundtripOpenXmlErrors: roundtripOpenXml.errorCount,
    powerpointVersion: powerpoint.version,
    powerpointBuild: powerpoint.build,
    powerpointExecutableSha256: powerpoint.executableSha256,
  };
}

async function runNegativeControls(source, semanticSource, openXmlRuntime, baselineResult) {
  const directory = path.join(staging, "negative-controls");
  await fs.mkdir(directory, { recursive: true });
  run(python, [path.join(scripts, "negative_controls.py"), source, directory, "--semantic-source", semanticSource], { id: "negative-generate" });
  const controls = [];
  const repairDirectory = path.join(directory, "powerpoint-repair-dialog");
  await fs.mkdir(repairDirectory, { recursive: true });
  const repairPaths = {
    source: path.join(repairDirectory, "source.pptx"),
    roundtrip: path.join(repairDirectory, "roundtrip.pptx"),
    report: path.join(repairDirectory, "powerpoint.json"),
    ownership: path.join(repairDirectory, "ownership.json"),
    stop: path.join(repairDirectory, "stop.marker"),
    watcherReady: path.join(repairDirectory, "watcher-ready.marker"),
    watcherArmed: path.join(repairDirectory, "watcher-armed.marker"),
    watcherReport: path.join(repairDirectory, "window-watch.json"),
  };
  await fs.copyFile(path.join(directory, "powerpoint-repair-duplicate-shape-id.pptx"), repairPaths.source);
  const repairReceipt = await runPowerPointFixture({
    fixture: { id: "control-repair-dialog" },
    ...repairPaths,
    expectedRepairSignal: true,
    workerTimeoutMs: 20_000,
  });
  controls.push({
    id: "powerpoint-repair-dialog",
    rejected: repairReceipt.repairControl.rejected,
    gate: "real-powerpoint-watcher",
    workerTimedOut: repairReceipt.timedOut,
    watcherExitCode: repairReceipt.watcher.exitCode,
    visibleWindowCount: repairReceipt.repairControl.visibleWindowCount,
    repairSignalCount: repairReceipt.repairControl.repairSignalCount,
    cleanupValid: repairReceipt.ownershipCleanup?.valid === true,
    cleanupPerformed: repairReceipt.ownershipCleanup?.cleaned === true,
  });
  for (const id of ["crc-corrupt", "duplicate-part", "traversal-part", "malformed-xml", "missing-content-type", "dangling-relationship"]) {
    const report = path.join(directory, `${id}-opc.json`);
    run(python, [path.join(scripts, "audit_opc_package.py"), path.join(directory, `${id}.pptx`), "--json", report], { expected: 1, id: `negative-opc-${id}` });
    const audit = await parseJson(report);
    controls.push({ id, rejected: audit.valid === false, gate: "opc", failures: audit.failures.map((item) => item.code ?? item) });
  }
  const schemaOpc = path.join(directory, "openxml-schema-invalid-opc.json");
  const schemaSdk = path.join(directory, "openxml-schema-invalid-sdk.json");
  run(python, [path.join(scripts, "audit_opc_package.py"), path.join(directory, "openxml-schema-invalid.pptx"), "--json", schemaOpc], { id: "negative-schema-opc" });
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "validate_openxml.ps1"), "-InputPptx", path.join(directory, "openxml-schema-invalid.pptx"), "-AssemblyPath", openXmlRuntime.liveAssemblyPath, "-ReportJson", schemaSdk], { expected: 2, id: "negative-schema-sdk" });
  const schemaAudit = await parseJson(schemaSdk);
  controls.push({ id: "openxml-schema-invalid", rejected: schemaAudit.valid === false && schemaAudit.errorCount > 0, gate: "openxml-sdk", errorCount: schemaAudit.errorCount });

  const baselineInventory = path.join(directory, "baseline-inventory.json");
  const removedOpc = path.join(directory, "removed-content-opc.json");
  const removedSdk = path.join(directory, "removed-content-sdk.json");
  const removedInventory = path.join(directory, "removed-content-inventory.json");
  run(python, [path.join(scripts, "semantic_inventory.py"), source, "--json", baselineInventory], { id: "negative-baseline-inventory" });
  run(python, [path.join(scripts, "audit_opc_package.py"), path.join(directory, "removed-content.pptx"), "--json", removedOpc], { id: "negative-removed-opc" });
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "validate_openxml.ps1"), "-InputPptx", path.join(directory, "removed-content.pptx"), "-AssemblyPath", openXmlRuntime.liveAssemblyPath, "-ReportJson", removedSdk], { id: "negative-removed-sdk" });
  run(python, [path.join(scripts, "semantic_inventory.py"), path.join(directory, "removed-content.pptx"), "--json", removedInventory], { id: "negative-removed-inventory" });
  const [baseline, removed] = await Promise.all([parseJson(baselineInventory), parseJson(removedInventory)]);
  controls.push({ id: "removed-content", rejected: baseline.inventorySha256 !== removed.inventorySha256, gate: "semantic-inventory", baseline: baseline.inventorySha256, mutant: removed.inventorySha256 });
  for (const [id, baselineName] of [["removed-chart-label", "semantic-content-present"], ["removed-diagram-label", "semantic-content-present"], ["removed-hyperlink-target", "hyperlink-present"]]) {
    const baselineReport = path.join(directory, `${id}-baseline-inventory.json`);
    const mutantReport = path.join(directory, `${id}-inventory.json`);
    const mutantOpc = path.join(directory, `${id}-opc.json`);
    const mutantSdk = path.join(directory, `${id}-sdk.json`);
    run(python, [path.join(scripts, "semantic_inventory.py"), path.join(directory, `${baselineName}.pptx`), "--json", baselineReport], { id: `negative-${id}-baseline-inventory` });
    run(python, [path.join(scripts, "audit_opc_package.py"), path.join(directory, `${id}.pptx`), "--json", mutantOpc], { id: `negative-${id}-opc` });
    run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "validate_openxml.ps1"), "-InputPptx", path.join(directory, `${id}.pptx`), "-AssemblyPath", openXmlRuntime.liveAssemblyPath, "-ReportJson", mutantSdk], { id: `negative-${id}-sdk` });
    run(python, [path.join(scripts, "semantic_inventory.py"), path.join(directory, `${id}.pptx`), "--json", mutantReport], { id: `negative-${id}-inventory` });
    const [baselineSemantic, mutantSemantic] = await Promise.all([parseJson(baselineReport), parseJson(mutantReport)]);
    controls.push({ id, rejected: baselineSemantic.inventorySha256 !== mutantSemantic.inventorySha256, gate: "semantic-inventory", baseline: baselineSemantic.inventorySha256, mutant: mutantSemantic.inventorySha256 });
  }
  const tamperRoot = path.join(directory, "watcher-evidence-tamper");
  const baselineDirectory = path.join(staging, "fixtures", baselineResult.id);
  const cases = [
    ["missing-watcher", async (target) => fs.rm(path.join(target, "window-watch.json"), { force: true })],
    ["unexpected-visible-window", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.unexpectedVisibleWindows = [{ handle: "control", title: "PowerPoint found a problem with content" }]; })],
    ["repair-signal", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.repairSignals = [{ provider: "control", message: "removed content" }]; })],
    ["watcher-timeout", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.timedOut = true; })],
    ["identity-drift", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.identityDrift = true; })],
    ["owned-process-survived", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.ownedProcessExited = false; })],
    ["event-log-query-absent", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { delete value.eventLogQuerySucceeded; })],
    ["pid-mismatch", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.processId += 1; })],
    ["watcher-start-after-ownership", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.startedAt = "2999-01-01T00:00:00.000Z"; })],
    ["watcher-finish-before-ownership", async (target) => mutateJson(path.join(target, "window-watch.json"), (value) => { value.finishedAt = "2000-01-01T00:00:00.000Z"; })],
    ["alerts-disabled", async (target) => mutateJson(path.join(target, "powerpoint.json"), (value) => { value.alertsEnabled = false; })],
    ["source-hash-mismatch", async (target) => mutateJson(path.join(target, "powerpoint.json"), (value) => { value.sourceSha256 = "0".repeat(64); })],
    ["output-hash-mismatch", async (target) => mutateJson(path.join(target, "powerpoint.json"), (value) => { value.outputSha256 = "0".repeat(64); })],
  ];
  async function mutateJson(file, mutation) {
    const value = await parseJson(file); mutation(value); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
  const tamperCases = [];
  for (const [id, mutate] of cases) {
    const target = path.join(tamperRoot, id);
    await fs.cp(baselineDirectory, target, { recursive: true, errorOnExist: true });
    await mutate(target);
    let errorMessage = null;
    try { await verifyRepairFreeFixtureDirectory(target, baselineResult, { expectedId: baselineResult.id }); } catch (error) { errorMessage = error.message; }
    tamperCases.push({ id, rejected: typeof errorMessage === "string" && errorMessage.startsWith("C04 evidence invalid:"), error: errorMessage });
  }
  const watcherTamper = { schemaVersion: "slidewright-repair-free-watcher-control/v1", mutation: "hostile-watcher-and-worker-matrix", rejected: tamperCases.every((item) => item.rejected), cases: tamperCases };
  await fs.writeFile(path.join(directory, "watcher-evidence-tamper.json"), `${JSON.stringify(watcherTamper, null, 2)}\n`, "utf8");
  controls.push({ id: "watcher-evidence-tamper", rejected: watcherTamper.rejected, gate: "fixture-evidence-verifier" });
  return controls;
}

validateContract();
if (process.platform !== "win32") throw new Error("C04 requires Windows and real Microsoft PowerPoint.");
await assertSafeWritableRoot(path.join(root, "outputs"), "C04 outputs root");
await assertSafeWritableRoot(outputRoot, "C04 evidence root");
await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
const gitBefore = gitState();
if (!gitBefore.clean && !allowDirty) throw new Error("C04 release evidence requires a clean Git worktree.");
const initialPowerPointProcesses = requirePowerPointQuiescence("powerpoint-quiescence-initial");
await ensureReleaseOutputs();
const postProducerPowerPointProcesses = requirePowerPointQuiescence("powerpoint-quiescence-post-producers");
const internalProducerStartedAt = new Date().toISOString();
const generated = await generateFidelityFixtures(path.join(staging, "sources", "design"));
receipts.push({
  id: "producer-in-run-design", command: "internal", args: ["generateFidelityFixtures", ...generated.map((item) => item.id)],
  startedAt: internalProducerStartedAt, finishedAt: new Date().toISOString(), exitCode: 0, signal: null, timedOut: false,
  streams: writeCommandStreams("producer-in-run-design", [["stdout", `Generated ${generated.length} design fixtures.\n`], ["stderr", ""]]),
});
const artifactToolRuntime = await captureArtifactToolRuntime(root, { snapshotRoot: staging });
const liveOpenXmlRuntime = await setupOpenXmlValidator({ root, contract: contract.openXml });
const runtimeDirectory = path.join(staging, "runtime");
await fs.mkdir(runtimeDirectory, { recursive: true });
const runtimePackage = path.join(runtimeDirectory, `${contract.openXml.package}.${contract.openXml.version}.nupkg`);
const runtimeAssembly = path.join(runtimeDirectory, "DocumentFormat.OpenXml.dll");
await Promise.all([fs.copyFile(liveOpenXmlRuntime.packagePath, runtimePackage), fs.copyFile(liveOpenXmlRuntime.assemblyPath, runtimeAssembly)]);
const openXmlRuntime = {
  schemaVersion: liveOpenXmlRuntime.schemaVersion,
  valid: liveOpenXmlRuntime.valid,
  package: liveOpenXmlRuntime.package,
  version: liveOpenXmlRuntime.version,
  targetFramework: liveOpenXmlRuntime.targetFramework,
  url: liveOpenXmlRuntime.url,
  packageSha256: liveOpenXmlRuntime.packageSha256,
  assemblySha256: liveOpenXmlRuntime.assemblySha256,
  packagePath: "runtime/DocumentFormat.OpenXml.2.20.0.nupkg",
  assemblyPath: "runtime/DocumentFormat.OpenXml.dll",
  liveAssemblyPath: liveOpenXmlRuntime.assemblyPath,
  downloaded: liveOpenXmlRuntime.downloaded,
  rendererSwitched: false,
  silentInstall: false,
};
const implementation = await captureRepairFreeImplementation(root, { snapshotRoot: staging });
const resolved = [];
for (const fixture of contract.fixtures) {
  const origin = await resolveFixture(fixture, generated);
  origin.sha256 = await sha256File(origin.path);
  origin.producerReceiptId = producerReceiptId(fixture);
  resolved.push({ fixture, ...origin });
}
if (new Set(resolved.map((item) => item.path.toLowerCase())).size !== resolved.length) throw new Error("C04 fixture paths are not unique.");
if (new Set(resolved.map((item) => item.sha256)).size !== resolved.length) throw new Error("C04 fixture packages are not byte-unique.");

const results = [];
for (const [index, item] of resolved.entries()) {
  process.stdout.write(`C04 ${index + 1}/${resolved.length}: ${item.fixture.id}\n`);
  results.push(await auditOne(item.fixture, item, openXmlRuntime));
}
const negativeControls = await runNegativeControls(
  path.join(staging, "fixtures", results[0].id, "source.pptx"),
  path.join(staging, "fixtures", "diagram-node-move", "source.pptx"),
  openXmlRuntime,
  results[0],
);
const finalPowerPointProcesses = requirePowerPointQuiescence("powerpoint-quiescence-final");
const gitAfter = gitState();
const categoryCounts = Object.fromEntries(Object.entries(Object.groupBy(results, (item) => item.category)).map(([key, items]) => [key, items.length]));
const quotasMet = Object.entries(contract.categoryQuotas).every(([category, minimum]) => (categoryCounts[category] ?? 0) >= minimum);
const runtimeIdentities = new Set(results.map((item) => `${item.powerpointVersion}|${item.powerpointBuild}|${item.powerpointExecutableSha256}`));
const functionalValid = results.length >= contract.minimumFixtureCount && quotasMet && runtimeIdentities.size === 1 && results.every((item) => item.valid) && negativeControls.every((item) => item.rejected);
const releaseValid = functionalValid && !allowDirty && !reuseReleaseOutputs && results.every((item) => item.sourceFresh) && gitBefore.clean && gitAfter.clean && gitBefore.commit === gitAfter.commit;
await fs.writeFile(path.join(staging, "command-log.json"), `${JSON.stringify(receipts, null, 2)}\n`, "utf8");
const evidence = await collectRepairFreeEvidenceTree(staging);
const scorecardBase = {
  schemaVersion: "slidewright-repair-free-scorecard/v2",
  valid: releaseValid,
  developmentFunctionalValid: functionalValid,
  releaseEvidence: releaseValid,
  benchmark: { startedAt: benchmarkStartedAt, finishedAt: new Date().toISOString(), platform: process.platform, arch: process.arch },
  environment: { node: process.version, platform: process.platform, arch: process.arch, artifactTool: artifactToolRuntime, powerPoint: { application: "Microsoft PowerPoint", version: results[0].powerpointVersion, build: results[0].powerpointBuild, executableSha256: results[0].powerpointExecutableSha256 } },
  reusedProducerOutputs: reuseReleaseOutputs,
  contract: logical(contractPath),
  contractSha256: await sha256File(contractPath),
  fixtureCount: results.length,
  minimumFixtureCount: contract.minimumFixtureCount,
  categoryCounts,
  categoryQuotas: contract.categoryQuotas,
  quotasMet,
  uniqueFixturePaths: new Set(resolved.map((item) => item.path.toLowerCase())).size === resolved.length,
  uniqueFixtureHashes: new Set(resolved.map((item) => item.sha256)).size === resolved.length,
  openXmlRuntime: Object.fromEntries(Object.entries(openXmlRuntime).filter(([key]) => key !== "liveAssemblyPath")),
  implementation,
  powerPointQuiescence: {
    initial: initialPowerPointProcesses,
    postProducers: postProducerPowerPointProcesses,
    final: finalPowerPointProcesses,
    perFixture: results.map((item) => item.id),
  },
  git: { before: gitBefore, after: gitAfter, sameCommit: gitBefore.commit === gitAfter.commit },
  fixtures: results,
  negativeControls,
  warnings: [],
  receipts,
  evidence,
};
const scorecardHash = canonicalHash(scorecardBase);
const scorecard = { ...scorecardBase, scorecardHash };
verifyRepairFreeScorecard(scorecard, { requireRelease: !allowDirty && !reuseReleaseOutputs, contract });
await fs.writeFile(path.join(staging, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
if (!functionalValid) throw new Error("C04 functional matrix failed.");
if (!allowDirty && !reuseReleaseOutputs && !releaseValid) throw new Error("C04 release provenance failed.");
if (!allowDirty && !reuseReleaseOutputs) await verifyRepairFreeEvidence({ root, runDirectory: staging, requireCurrentGit: true });
const publicationRoot = releaseValid ? outputRoot : path.join(outputRoot, "development");
await publishVersionedEvidence(staging, publicationRoot, scorecardHash, {
  currentSchemaVersion: releaseValid ? "slidewright-repair-free-current/v2" : "slidewright-repair-free-development-current/v1",
  verifyFinal: !allowDirty && !reuseReleaseOutputs ? (finalRun) => verifyRepairFreeEvidence({ root, runDirectory: finalRun, requireCurrentGit: true }) : null,
  currentExtra: { evidenceTreeSha256: evidence.treeSha256 },
});
process.stdout.write(`C04 repair-free matrix passed ${results.length}/${results.length} fixtures: ${scorecardHash}\n`);
