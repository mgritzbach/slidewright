import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureWorkerIdentity } from "./exact-worker-process.mjs";
import {
  canonicalHash,
  captureCleanGit,
  captureSemanticRuntime,
  collectReceiptTree,
  exactPathInventoryMatches,
  normalizeCommandArgument,
  sha256File,
  validateNormalWatchdogEvidence,
  validateTimeoutCleanupEvidence,
  verifySemanticSurfaceEvidence,
} from "./semantic-surface-evidence.mjs";

export const SEMANTIC_MUTATION_IMPLEMENTATION_PATHS = [
  "package.json",
  "package-lock.json",
  "scripts/run-semantic-mutation-benchmark.mjs",
  "scripts/verify-semantic-mutation-evidence.mjs",
  "scripts/verify-semantic-mutation-review.mjs",
  "scripts/finalize-semantic-mutation-review.mjs",
  "scripts/lib/semantic-mutation-evidence.mjs",
  "scripts/lib/semantic-surface-evidence.mjs",
  "scripts/lib/owned-process-cleanup.mjs",
  "scripts/lib/exact-worker-process.mjs",
  "scripts/lib/runner-watchdog.mjs",
  "scripts/setup-artifact-runtime.mjs",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_semantic_mutation.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_mutation.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_surface.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/semantic_mutation_negative_controls.py",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_render_isolated.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_timeout_probe.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/cleanup_owned_powerpoint.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/presentation_path_identity.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_runner_watchdog.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_runner_watchdog_entrypoint.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/start_powerpoint_runner_watchdog.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/start_powerpoint_timeout_probe_control.ps1",
  "fixtures/semantic-surface/v1/semantic-contract.json",
  "fixtures/semantic-surface/v1/mutation-contract.json",
  "tests/semantic-mutation.test.mjs",
  "tests/runner-watchdog.test.mjs",
  "tests/presentation-path-identity.test.mjs",
  "tests/fixtures/never-arm-watchdog.mjs",
  "tests/fixtures/start-runner-watchdog.mjs",
].sort();

export const SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS = Object.freeze({
  "stale-baseline-hash": Object.freeze({ caseId: "horizontal-chart-data", code: "SM001" }),
  "unauthorized-object-mutation": Object.freeze({ caseId: "horizontal-chart-data", code: "SM002" }),
  "chart-flatten": Object.freeze({ caseId: "horizontal-chart-data", code: "SM004" }),
  "chart-label-unreadable": Object.freeze({ caseId: "horizontal-chart-data", code: "SM007" }),
  "table-flatten": Object.freeze({ caseId: "table-cell-edit", code: "SM005" }),
  "table-cell-overflow": Object.freeze({ caseId: "table-cell-edit", code: "SM008" }),
  "connector-detach": Object.freeze({ caseId: "connector-style-geometry", code: "SM006" }),
  "connector-crosses-label": Object.freeze({ caseId: "connector-style-geometry", code: "SM009" }),
  "diagram-label-outside-node": Object.freeze({ caseId: "diagram-node-move", code: "SM009" }),
});

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

async function fileRecord(root, relative) {
  const absolute = path.resolve(root, ...relative.split("/"));
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`C18 implementation file must be a regular non-link file: ${relative}`);
  return { path: relative, bytes: stat.size, sha256: await sha256File(absolute) };
}

export async function captureSemanticMutationImplementation(root) {
  const files = [];
  for (const relative of SEMANTIC_MUTATION_IMPLEMENTATION_PATHS) files.push(await fileRecord(root, relative));
  return { files, sha256: canonicalHash(files) };
}

function resolveExecutable(command) {
  if (path.isAbsolute(command)) return path.resolve(command);
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout.trim()) throw result.error ?? new Error(`Could not resolve executable ${command}.`);
  return path.resolve(result.stdout.trim().split(/\r?\n/u)[0]);
}

export async function captureSemanticMutationRuntime({ root, python, slidesTest }) {
  const shared = await captureSemanticRuntime({ root, python, slidesTest });
  const pythonPath = await fs.realpath(resolveExecutable(python));
  const powerShellPath = await fs.realpath(resolveExecutable(process.platform === "win32" ? "powershell.exe" : "pwsh"));
  const packageProbe = spawnSync(pythonPath, ["-c", "import json,sys,importlib.metadata as m; names=['python-pptx','Pillow','lxml']; print(json.dumps({'executable':sys.executable,'packages':{n:m.version(n) for n in names}},sort_keys=True))"], { encoding: "utf8", windowsHide: true });
  if (packageProbe.error || packageProbe.status !== 0) throw packageProbe.error ?? new Error(`Could not bind C18 Python packages: ${packageProbe.stderr}`);
  const pythonEnvironment = JSON.parse(packageProbe.stdout.trim());
  requireEvidence(normalizedAbsolute(pythonEnvironment.executable) === normalizedAbsolute(pythonPath), "C18 Python executable probe did not match the invoked runtime.");
  let powerPoint = null;
  if (process.platform === "win32") {
    const powerPointProbe = spawnSync(powerShellPath, ["-NoProfile", "-Command", "$keys=@('Registry::HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE','Registry::HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\POWERPNT.EXE'); $p=$null; foreach($k in $keys){$v=(Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'; if($v){$p=$v;break}}; if(!$p -or !(Test-Path -LiteralPath $p)){exit 2}; $i=(Get-Item -LiteralPath $p).VersionInfo; [pscustomobject]@{path=(Resolve-Path -LiteralPath $p).Path;fileVersion=$i.FileVersion;productVersion=$i.ProductVersion}|ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
    if (powerPointProbe.error || powerPointProbe.status !== 0) throw powerPointProbe.error ?? new Error(`Could not bind Microsoft PowerPoint executable: ${powerPointProbe.stderr}`);
    const value = JSON.parse(powerPointProbe.stdout.trim());
    const executable = await fs.realpath(value.path);
    powerPoint = { path: executable, sha256: await sha256File(executable), fileVersion: value.fileVersion, productVersion: value.productVersion };
  }
  return {
    ...shared,
    executables: {
      node: { path: await fs.realpath(process.execPath), sha256: await sha256File(await fs.realpath(process.execPath)) },
      python: { path: pythonPath, sha256: await sha256File(pythonPath) },
      powerShell: { path: powerShellPath, sha256: await sha256File(powerShellPath) },
      powerPoint,
    },
    pythonPackages: pythonEnvironment.packages,
  };
}

function decksFor(contract) {
  return ["powerpoint-normalized-baseline", ...contract.cases.map((item) => item.id)];
}

export function expectedSemanticMutationReceiptPaths(contract, commandCount = 0) {
  const paths = [
    "command-log.json",
    "negative-controls.json",
    "powerpoint-interstage-quiescence.json",
    "powerpoint-mutation-ownership.json",
    "powerpoint-mutation.json",
    "powerpoint-normalized-baseline.pptx",
    "powerpoint-quiescence.json",
    "powerpoint-timeout-cleanup-control.json",
    "powerpoint-timeout-probe-ownership.json",
    "powerpoint-timeout-probe.ready",
    "powerpoint-runtime/native-mutation.json",
    "powerpoint-runtime/timeout-probe.json",
    "source-binding.json",
    "watchdog/normal/completion.marker",
    "watchdog/normal/diagnostic.log",
    "watchdog/normal/identity-receipt.json",
    "watchdog/normal/ready.marker",
    "watchdog/normal/summary.json",
    "worker-intents/powerpoint-native-mutation-worker-intent.json",
    "worker-intents/powerpoint-timeout-probe-worker-intent.json",
  ];
  for (const mutationCase of contract.cases) {
    paths.push(
      `audits/${mutationCase.id}.json`,
      `mutations/${mutationCase.id}.pptx`,
      `render-evidence/${mutationCase.id}.json`,
      `worker-intents/render-${mutationCase.id}-worker-intent.json`,
      `negative-controls/positive-audits/${mutationCase.id}.json`,
    );
  }
  for (const deck of decksFor(contract)) {
    paths.push(
      `overflow/${deck}.json`,
      `renders/${deck}.json`,
      `renders/${deck}-ownership.json`,
      `worker-intents/render-${deck}-worker-intent.json`,
      `powerpoint-runtime/render-${deck}.json`,
    );
    for (let index = 1; index <= 4; index += 1) {
      const slide = String(index).padStart(2, "0");
      paths.push(`renders/${deck}/slide-${slide}.jpg`, `renders/${deck}/slide-${slide}.png`);
    }
  }
  for (const control of contract.negativeControls) {
    paths.push(
      `negative-controls/${control}/audit.json`,
      `negative-controls/${control}/${control}.pptx`,
      `negative-controls/${control}/mutation-contract.json`,
      `negative-controls/${control}/powerpoint-report.json`,
    );
  }
  for (let index = 1; index <= commandCount; index += 1) {
    const sequence = String(index).padStart(4, "0");
    paths.push(`command-receipts/${sequence}.stderr.txt`, `command-receipts/${sequence}.stdout.txt`);
  }
  return [...new Set(paths)].sort();
}

const POLL_ARGS = ["-NoProfile", "-Command", "$p=Get-Process POWERPNT -ErrorAction SilentlyContinue; if($p){$p.Id -join ','}; exit 0"];

export function expectedMutationCommandPlan(output, pythonCommand, contract) {
  const semantic = "<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface";
  const mutationScript = `${semantic}/powerpoint_semantic_mutation.ps1`;
  const auditScript = `${semantic}/audit_semantic_mutation.py`;
  const negativeScript = `${semantic}/semantic_mutation_negative_controls.py`;
  const renderScript = `${semantic}/powerpoint_render_isolated.ps1`;
  const timeoutScript = `${semantic}/powerpoint_timeout_probe.ps1`;
  const mutationContract = "<repo>/fixtures/semantic-surface/v1/mutation-contract.json";
  const baselineContract = "<repo>/fixtures/semantic-surface/v1/semantic-contract.json";
  const baseline = `${output}/powerpoint-normalized-baseline.pptx`;
  const mutationDir = `${output}/mutations`;
  const mutationReport = `${output}/powerpoint-mutation.json`;
  const records = [
    {
      label: "timeout",
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", timeoutScript, "-OwnershipRecordJson", `${output}/powerpoint-timeout-probe-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-timeout-probe-worker-intent.json`, "-ReadyMarker", `${output}/powerpoint-timeout-probe.ready`, "-HoldSeconds", "120"],
    },
    {
      label: "mutation",
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", mutationScript, "-InputPptx", baseline, "-ContractJson", mutationContract, "-OutputDir", mutationDir, "-ReportJson", mutationReport, "-OwnershipRecordJson", `${output}/powerpoint-mutation-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/powerpoint-native-mutation-worker-intent.json`],
    },
  ];
  for (const deck of decksFor(contract)) {
    const input = deck === "powerpoint-normalized-baseline" ? baseline : `${mutationDir}/${deck}.pptx`;
    records.push({
      label: "render",
      command: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", renderScript, "-InputPptx", input, "-OutputDir", `${output}/renders/${deck}`, "-ReportJson", `${output}/renders/${deck}.json`, "-OwnershipRecordJson", `${output}/renders/${deck}-ownership.json`, "-WorkerIntentJson", `${output}/worker-intents/render-${deck}-worker-intent.json`],
    });
  }
  for (const mutationCase of contract.cases) {
    records.push({
      label: "measure",
      command: pythonCommand,
      args: [auditScript, baseline, `${mutationDir}/${mutationCase.id}.pptx`, mutationContract, "--case", mutationCase.id, "--baseline-contract", baselineContract, "--powerpoint-report", mutationReport, "--measure-render", `${output}/renders/${mutationCase.id}/slide-02.png`, "--json", `${output}/render-evidence/${mutationCase.id}.json`],
    });
  }
  for (const mutationCase of contract.cases) {
    records.push({
      label: "audit",
      command: pythonCommand,
      args: [auditScript, baseline, `${mutationDir}/${mutationCase.id}.pptx`, mutationContract, "--case", mutationCase.id, "--baseline-contract", baselineContract, "--powerpoint-report", mutationReport, "--render-evidence", `${output}/render-evidence/${mutationCase.id}.json`, "--json", `${output}/audits/${mutationCase.id}.json`],
    });
  }
  records.push({
    label: "negative",
    command: pythonCommand,
    args: [negativeScript, baseline, mutationDir, mutationContract, baselineContract, mutationReport, `${output}/render-evidence`, `${output}/negative-controls`, "--audit-script", auditScript, "--json", `${output}/negative-controls.json`],
  });
  for (const deck of decksFor(contract)) {
    const input = deck === "powerpoint-normalized-baseline" ? baseline : `${mutationDir}/${deck}.pptx`;
    records.push({ label: "slides-test", command: pythonCommand, args: ["<external>/slides_test.py", input] });
  }
  return records;
}

export function validateSemanticMutationCommandReceipts(log, contract) {
  requireEvidence(log?.schemaVersion === "slidewright-command-receipts/v1" && log.logicalCommand === "npm run semantic-mutation" && Array.isArray(log.commands), "C18 command receipt log is incomplete.");
  const timeout = log.commands.find((item) => item.args?.includes("<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_timeout_probe.ps1"));
  const ownershipIndex = timeout?.args?.indexOf("-OwnershipRecordJson") ?? -1;
  const outputMatch = ownershipIndex >= 0 ? timeout.args[ownershipIndex + 1]?.match(/^(<repo>\/outputs\/semantic-mutation\/runs\/\.staging-\d+-\d+)\/powerpoint-timeout-probe-ownership\.json$/u) : null;
  requireEvidence(outputMatch, "C18 command log does not bind the exact staging output path.");
  const pythonCommand = log.commands.find((item) => item.args?.[0] === "<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface/audit_semantic_mutation.py")?.command;
  requireEvidence(/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/u.test(pythonCommand?.split("/").at(-1).toLowerCase() ?? ""), "C18 command Python runtime identity is invalid.");
  const expected = expectedMutationCommandPlan(outputMatch[1], pythonCommand, contract);
  const expectedLabels = ["poll", "timeout", "mutation", "poll"];
  for (let index = 0; index < decksFor(contract).length; index += 1) expectedLabels.push("render", "poll");
  expectedLabels.push(...contract.cases.map(() => "measure"), ...contract.cases.map(() => "audit"), "negative", ...decksFor(contract).map(() => "slides-test"), "poll");
  const labels = [];
  const pollRunLengths = [];
  let nonPollIndex = 0;
  for (const item of log.commands) {
    requireEvidence(typeof item.command === "string" && Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string")
      && /^[a-f0-9]{64}$/u.test(item.stdoutSha256) && /^[a-f0-9]{64}$/u.test(item.stderrSha256), "C18 command receipt is malformed.");
    requireEvidence(!item.args.some((arg) => /^<repo>\/(?:-|\d+$)/u.test(arg)), "C18 command argv normalization fabricated a path from a flag or scalar.");
    const poll = item.command === "powershell" && canonicalHash(item.args) === canonicalHash(POLL_ARGS);
    if (poll) {
      requireEvidence(item.timedOut === false && item.exitCode === 0, "C18 PowerPoint poll command failed or timed out.");
      if (labels.at(-1) === "poll") pollRunLengths[pollRunLengths.length - 1] += 1;
      else { labels.push("poll"); pollRunLengths.push(1); }
      continue;
    }
    const descriptor = expected[nonPollIndex];
    requireEvidence(descriptor && item.command === descriptor.command && canonicalHash(item.args) === canonicalHash(descriptor.args), "C18 command receipt contains an unexpected command or argv sequence.");
    labels.push(descriptor.label);
    nonPollIndex += 1;
    if (descriptor.label === "timeout") requireEvidence(item.timedOut === true && item.exitCode !== 0, "C18 intended timeout command did not time out.");
    else requireEvidence(item.timedOut === false && item.exitCode === 0, "C18 command log contains an unexpected failure.");
  }
  requireEvidence(nonPollIndex === expected.length, "C18 command receipt log is missing a required command.");
  requireEvidence(canonicalHash(labels) === canonicalHash(expectedLabels), "C18 command receipt sequence drifted.");
  requireEvidence(pollRunLengths.length === 9 && pollRunLengths.every((count) => count >= 2), "C18 command log did not prove nine two-poll PowerPoint quiescence gates.");
  return true;
}

function validateQuiescenceCheckpoint(item, platform = process.platform) {
  requireEvidence(item?.valid === true && Number.isInteger(item.waitedMs) && item.waitedMs >= 0
    && Number.isInteger(item.polls) && item.polls >= 0
    && (!Object.hasOwn(item, "lastPids") || (Array.isArray(item.lastPids) && item.lastPids.length === 0)), "C18 PowerPoint quiescence checkpoint is malformed.");
  if (platform === "win32") requireEvidence(item.reason === "two-consecutive-clear-polls" && item.polls >= 2, "C18 Windows PowerPoint quiescence was not proven by two clear polls.");
  else requireEvidence(item.reason === "non-windows" && item.polls === 0 && item.waitedMs === 0, "C18 non-Windows PowerPoint quiescence receipt is invalid.");
}

export function validateSemanticMutationQuiescenceEvidence({ initial, interStage, scorecardInitial, scorecardInterStage, contract, platform = process.platform }) {
  requireEvidence(canonicalHash(initial) === canonicalHash(scorecardInitial), "C18 initial PowerPoint quiescence scorecard binding drifted.");
  validateQuiescenceCheckpoint(initial, platform);
  const expectedStages = ["after-native-mutation", ...decksFor(contract).map((deck) => `after-render-${deck}`)];
  requireEvidence(interStage?.schemaVersion === "slidewright-powerpoint-quiescence-checkpoints/v1"
    && interStage.valid === true && Array.isArray(interStage.checkpoints)
    && interStage.checkpoints.length === expectedStages.length, "C18 inter-stage PowerPoint quiescence receipt is invalid.");
  requireEvidence(canonicalHash(interStage.checkpoints) === canonicalHash(scorecardInterStage), "C18 inter-stage PowerPoint quiescence scorecard binding drifted.");
  for (let index = 0; index < expectedStages.length; index += 1) {
    requireEvidence(interStage.checkpoints[index]?.stage === expectedStages[index], "C18 inter-stage PowerPoint quiescence sequence drifted.");
    validateQuiescenceCheckpoint(interStage.checkpoints[index], platform);
  }
  return true;
}

function stagingDirectoryFromCommandLog(root, log) {
  const timeout = log.commands.find((item) => item.args?.includes("<repo>/plugins/slidewright/skills/slidewright/scripts/semantic_surface/powerpoint_timeout_probe.ps1"));
  const index = timeout?.args?.indexOf("-OwnershipRecordJson") ?? -1;
  const logical = index >= 0 ? timeout.args[index + 1] : null;
  const match = logical?.match(/^(<repo>\/outputs\/semantic-mutation\/runs\/\.staging-\d+-\d+)\/powerpoint-timeout-probe-ownership\.json$/u);
  requireEvidence(match, "C18 command log has no recoverable staging directory.");
  return path.resolve(root, ...match[1].slice("<repo>/".length).split("/"));
}

export async function validateCommandReceiptBytes(runFile, log) {
  const raw = [];
  let pollBlock = [];
  const validatePollBlock = () => {
    if (pollBlock.length === 0) return;
    requireEvidence(pollBlock.length >= 2
      && pollBlock.slice(-2).every((item) => item.stdout.trim() === "")
      && pollBlock.every((item) => item.stderr.trim() === ""), "C18 PowerPoint poll block did not end with two clear raw polls.");
    pollBlock = [];
  };
  for (let index = 0; index < log.commands.length; index += 1) {
    const item = log.commands[index];
    const sequence = String(index + 1).padStart(4, "0");
    requireEvidence(item.stdoutPath === `command-receipts/${sequence}.stdout.txt`
      && item.stderrPath === `command-receipts/${sequence}.stderr.txt`, "C18 command raw-output path sequence drifted.");
    const [stdout, stderr] = await Promise.all([fs.readFile(runFile(item.stdoutPath), "utf8"), fs.readFile(runFile(item.stderrPath), "utf8")]);
    requireEvidence(item.stdoutSha256 === await sha256File(runFile(item.stdoutPath))
      && item.stderrSha256 === await sha256File(runFile(item.stderrPath)), "C18 command raw-output bytes drifted.");
    requireEvidence(!/\bwarn(?:ing)?\b/iu.test(stdout) && !/\bwarn(?:ing)?\b/iu.test(stderr), "C18 command raw output contains a warning.");
    const poll = item.command === "powershell" && canonicalHash(item.args) === canonicalHash(POLL_ARGS);
    if (poll) pollBlock.push({ stdout, stderr });
    else validatePollBlock();
    raw.push({ stdout, stderr });
  }
  validatePollBlock();
  return raw;
}

export function validateRenderMeasurementChart(chart, rules, caseId = "unknown", { width, height, expectedMarkCount } = {}) {
  const frame = chart?.framePixels;
  requireEvidence(Number.isInteger(chart?.expectedMarkCount) && chart.expectedMarkCount > 0
    && (!Number.isInteger(expectedMarkCount) || chart.expectedMarkCount === expectedMarkCount)
    && chart.detectedMarkCount === chart.expectedMarkCount
    && chart.minimumMarkThicknessPixels >= rules.minimumMarkThicknessPixels
    && chart.labelsDetected === true
    && chart.labelPresenceProbeRegions?.length === chart.expectedMarkCount
    && chart.labelDarkPixelCounts?.length === chart.expectedMarkCount
    && chart.labelDarkPixelCounts.every((count) => Number.isInteger(count) && count > 0)
    && [frame?.left, frame?.top, frame?.right, frame?.bottom].every(Number.isInteger)
    && frame.left >= 0 && frame.top >= 0 && frame.right > frame.left && frame.bottom > frame.top
    && (!Number.isInteger(width) || frame.right <= width)
    && (!Number.isInteger(height) || frame.bottom <= height), `C18 rendered chart measurement is incomplete for ${caseId}.`);
  for (let index = 0; index < chart.labelPresenceProbeRegions.length; index += 1) {
    const region = chart.labelPresenceProbeRegions[index];
    requireEvidence([region?.left, region?.top, region?.right, region?.bottom].every(Number.isInteger)
      && region.left >= frame.left && region.top >= frame.top
      && region.right > region.left && region.bottom > region.top
      && region.right <= frame.right && region.bottom <= frame.bottom, `C18 rendered chart label probe escaped its frame for ${caseId}.`);
    for (let other = 0; other < index; other += 1) {
      const previous = chart.labelPresenceProbeRegions[other];
      const overlaps = region.left < previous.right && region.right > previous.left
        && region.top < previous.bottom && region.bottom > previous.top;
      requireEvidence(!overlaps, `C18 rendered chart label probes overlap for ${caseId}.`);
    }
  }
  return true;
}

export function allTrueExact(value, expectedKeys) {
  return allTrue(value) && canonicalHash(Object.keys(value).sort()) === canonicalHash([...expectedKeys].sort());
}

export function validateNegativeSummaryHeader(negative, contract) {
  requireEvidence(negative?.schemaVersion === "slidewright-semantic-mutation-negative-controls/v1"
    && negative.version === "semantic-mutation-negative-controls-v1"
    && negative.valid === true && negative.baselineValid === true
    && negative.positiveAudits?.length === contract.cases.length
    && negative.positiveAudits.every((item) => item.valid === true)
    && negative.controls?.length === contract.negativeControls.length
    && canonicalHash(negative.controls.map((item) => item.id)) === canonicalHash(contract.negativeControls)
    && canonicalHash(negative.positiveAudits.map((item) => item.caseId)) === canonicalHash(contract.cases.map((item) => item.id)), "C18 negative-control inventory drifted.");
  return true;
}

export function validateOwnedPowerPointRuntimeReceipt({ receipt, ownership, centralRuntime, expectedProcessCount, sessions = null, stage = "unknown" }) {
  const processes = receipt?.processes ?? [];
  const identities = processes.map((item) => `${item.processId}|${item.processName}|${item.processStartTime}`);
  const finalProcess = processes.at(-1);
  requireEvidence(receipt?.schemaVersion === "slidewright-owned-powerpoint-runtime/v1"
    && processes.length === expectedProcessCount
    && new Set(identities).size === expectedProcessCount
    && processes.every((item) => normalizedAbsolute(item.executablePath) === normalizedAbsolute(centralRuntime.path)
      && item.executableSha256 === centralRuntime.sha256)
    && finalProcess?.processId === ownership?.processId
    && finalProcess?.processName === ownership?.processName
    && finalProcess?.processStartTime === ownership?.processStartTime, `C18 owned PowerPoint runtime receipt drifted for ${stage}.`);
  if (sessions) {
    requireEvidence(canonicalHash(sessions.map((item) => ({ processId: item.processId, processName: "POWERPNT", processStartTime: item.processStartTime })))
      === canonicalHash(processes.map((item) => ({ processId: item.processId, processName: item.processName, processStartTime: item.processStartTime }))), `C18 PowerPoint session-to-runtime receipt sequence drifted for ${stage}.`);
  }
  return true;
}

async function snapshotFile(file) {
  try { return await fs.readFile(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function restoreFileAtomically(file, bytes) {
  if (bytes === null) { await fs.rm(file, { force: true }); return; }
  const temporary = `${file}.restore-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, bytes);
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}

async function listRegularFiles(root, directory = root) {
  const files = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`C18 publication contains a non-regular entry: ${absolute}`);
  }
  return files;
}

async function assertIdenticalTrees(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listRegularFiles(left), listRegularFiles(right)]);
  requireEvidence(canonicalHash(leftFiles) === canonicalHash(rightFiles), "Existing C18 run has a different file inventory.");
  for (const relative of leftFiles) {
    const [leftBytes, rightBytes] = await Promise.all([fs.readFile(path.join(left, ...relative.split("/"))), fs.readFile(path.join(right, ...relative.split("/")))]);
    requireEvidence(leftBytes.equals(rightBytes), `Existing C18 run differs at ${relative}.`);
  }
}

export async function publishSemanticMutationEvidence({ staging, published, scorecardHash, verify }) {
  const currentPath = path.join(published, "current.json");
  const scorecardPath = path.join(published, "scorecard.json");
  const [priorCurrent, priorScorecard] = await Promise.all([snapshotFile(currentPath), snapshotFile(scorecardPath)]);
  try {
    const finalRun = path.join(published, "runs", scorecardHash);
    await fs.mkdir(path.dirname(finalRun), { recursive: true });
    const stagingScorecard = await readJson(path.join(staging, "scorecard.json"));
    requireEvidence(stagingScorecard.scorecardHash === scorecardHash, "C18 staging scorecard does not match its publication key.");
    try {
      await fs.rename(staging, finalRun);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      await assertIdenticalTrees(staging, finalRun);
      await fs.rm(staging, { recursive: true, force: true });
    }
    await verify(finalRun);
    const scorecardBytes = await fs.readFile(path.join(finalRun, "scorecard.json"));
    const currentBytes = Buffer.from(`${JSON.stringify({ schemaVersion: "slidewright-semantic-current/v1", scorecardHash, run: `runs/${scorecardHash}` }, null, 2)}\n`, "utf8");
    await restoreFileAtomically(scorecardPath, scorecardBytes);
    await verify(finalRun);
    await restoreFileAtomically(currentPath, currentBytes);
    await verify(finalRun);
    requireEvidence((await fs.readFile(scorecardPath)).equals(scorecardBytes)
      && (await fs.readFile(currentPath)).equals(currentBytes), "C18 published convenience scorecard or current pointer drifted.");
    return finalRun;
  } catch (error) {
    await Promise.all([restoreFileAtomically(currentPath, priorCurrent), restoreFileAtomically(scorecardPath, priorScorecard)]);
    throw error;
  }
}

function identityAbsent(identity) {
  if (!identity?.processId || !identity?.processName || !identity?.processStartTime) return false;
  const live = captureWorkerIdentity(identity.processId);
  return !live || live.processName !== identity.processName || live.processStartTime !== identity.processStartTime;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

function runReadOnlyAuditor(python, args, root, expectedStatus, label) {
  const result = spawnSync(python, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  requireEvidence(!result.error && result.signal === null && result.status === expectedStatus, `C18 independent ${label} failed or timed out: ${result.error?.message ?? result.stderr}`);
  requireEvidence(!/\bwarn(?:ing)?\b/iu.test(result.stdout ?? "") && !/\bwarn(?:ing)?\b/iu.test(result.stderr ?? ""), `C18 independent ${label} emitted a warning.`);
}

async function rederiveSemanticMutationCase({ root, python, auditScript, baseline, variant, contractPath, baselineContractPath, powerPointReport, renderPng, caseId }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `slidewright-c18-${caseId}-`));
  try {
    const measurementPath = path.join(temporary, "render-evidence.json");
    runReadOnlyAuditor(python, [auditScript, baseline, variant, contractPath, "--case", caseId, "--baseline-contract", baselineContractPath, "--powerpoint-report", powerPointReport, "--measure-render", renderPng, "--json", measurementPath], root, 0, `render measurement for ${caseId}`);
    const auditPath = path.join(temporary, "audit.json");
    runReadOnlyAuditor(python, [auditScript, baseline, variant, contractPath, "--case", caseId, "--baseline-contract", baselineContractPath, "--powerpoint-report", powerPointReport, "--render-evidence", measurementPath, "--json", auditPath], root, 0, `semantic audit for ${caseId}`);
    return { measurement: await readJson(measurementPath), audit: await readJson(auditPath) };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function rederiveNegativeAudit({ root, python, auditScript, baseline, variant, contractPath, baselineContractPath, powerPointReport, renderEvidence, caseId, controlId }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `slidewright-c18-negative-${controlId}-`));
  try {
    const auditPath = path.join(temporary, "audit.json");
    runReadOnlyAuditor(python, [auditScript, baseline, variant, contractPath, "--case", caseId, "--baseline-contract", baselineContractPath, "--powerpoint-report", powerPointReport, "--render-evidence", renderEvidence, "--json", auditPath], root, 2, `negative audit for ${controlId}`);
    return await readJson(auditPath);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export function allTrue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const values = Object.values(value);
  return values.length > 0 && values.every((item) => item === true);
}

export function validateMutationCaseState(result, mutationCase) {
  requireEvidence(result && mutationCase && result.id === mutationCase.id, `C18 mutation state case identity drifted for ${mutationCase?.id ?? "unknown"}.`);
  if (mutationCase.operation === "replace-chart-data") {
    const series = mutationCase.expected?.series;
    requireEvidence(Array.isArray(series) && series.length === 1, `C18 chart mutation contract is unsupported for ${mutationCase.id}.`);
    const expected = { name: series[0].name, categories: mutationCase.expected.categories, values: series[0].values };
    requireEvidence(canonicalHash(result.afterMutation) === canonicalHash(expected)
      && canonicalHash(result.afterSaveReopen) === canonicalHash(expected), `C18 chart mutation state drifted for ${mutationCase.id}.`);
  } else if (mutationCase.operation === "replace-table-cell") {
    requireEvidence(result.before === mutationCase.cell?.before
      && result.afterMutation === mutationCase.cell?.after
      && result.afterSaveReopen === mutationCase.cell?.after, `C18 table mutation state drifted for ${mutationCase.id}.`);
  } else if (mutationCase.operation === "move-diagram-node") {
    requireEvidence(Number.isFinite(result.before?.left) && Number.isFinite(result.before?.top), `C18 diagram mutation baseline state is malformed for ${mutationCase.id}.`);
    const expected = {
      left: result.before.left + mutationCase.deltaPoints.x,
      top: result.before.top + mutationCase.deltaPoints.y,
    };
    requireEvidence(canonicalHash(result.afterMutation) === canonicalHash(expected)
      && canonicalHash(result.afterSaveReopen) === canonicalHash(expected), `C18 diagram mutation state drifted for ${mutationCase.id}.`);
  } else if (mutationCase.operation === "edit-connector-style") {
    const expected = {
      weightPoints: mutationCase.expected?.weightPoints,
      dashStyle: mutationCase.expected?.dashStyle,
      from: mutationCase.attachedEndpoints?.from,
      to: mutationCase.attachedEndpoints?.to,
    };
    requireEvidence(canonicalHash(result.afterMutation) === canonicalHash(expected)
      && canonicalHash(result.afterSaveReopen) === canonicalHash(expected), `C18 connector mutation state drifted for ${mutationCase.id}.`);
  } else {
    throw new Error(`C18 mutation operation is unsupported: ${mutationCase.operation}.`);
  }
  return true;
}

function boxesOverlap(left, right) {
  return left.leftPoints < right.leftPoints + right.widthPoints
    && left.leftPoints + left.widthPoints > right.leftPoints
    && left.topPoints < right.topPoints + right.heightPoints
    && left.topPoints + left.heightPoints > right.topPoints;
}

export function validateNativeReadability(result, mutationCase, baselineContract, rules) {
  const baselineCharts = baselineContract.slides?.find((slide) => slide.index === 2)?.charts ?? [];
  const charts = result.readability?.charts;
  requireEvidence(Array.isArray(charts) && charts.length === baselineCharts.length
    && canonicalHash(charts.map((chart) => chart.name)) === canonicalHash(baselineCharts.map((chart) => chart.name)), `C18 native chart readability inventory drifted for ${mutationCase.id}.`);
  for (let index = 0; index < charts.length; index += 1) {
    const chart = charts[index];
    const baseline = baselineCharts[index];
    const expectedValues = mutationCase.operation === "replace-chart-data" && mutationCase.target === chart.name
      ? mutationCase.expected.series[0].values
      : baseline.series[0].values;
    requireEvidence(chart.widthPoints >= rules.charts.minimumFramePoints.width
      && chart.heightPoints >= rules.charts.minimumFramePoints.height
      && chart.categoryCount === baseline.categories.length && chart.categoryCount <= rules.charts.maximumCategories
      && chart.seriesCount === baseline.series.length && chart.seriesCount <= rules.charts.maximumSeries
      && Math.min(chart.categoryAxisFontPoints, chart.valueAxisFontPoints, chart.dataLabelFontPoints) >= rules.charts.minimumLabelFontPoints
      && Array.isArray(chart.dataLabels) && chart.dataLabels.length === expectedValues.length, `C18 native chart metrics drifted for ${mutationCase.id}/${chart.name}.`);
    for (let labelIndex = 0; labelIndex < chart.dataLabels.length; labelIndex += 1) {
      const label = chart.dataLabels[labelIndex];
      requireEvidence(label.index === labelIndex + 1 && label.text === String(expectedValues[labelIndex])
        && Number.isFinite(label.leftPoints) && Number.isFinite(label.topPoints)
        && Number.isFinite(label.widthPoints) && label.widthPoints > 0
        && Number.isFinite(label.heightPoints) && label.heightPoints > 0
        && label.leftPoints >= 0 && label.topPoints >= 0
        && label.leftPoints + label.widthPoints <= chart.widthPoints
        && label.topPoints + label.heightPoints <= chart.heightPoints, `C18 native chart label bounds or text drifted for ${mutationCase.id}/${chart.name}.`);
      for (let other = 0; other < labelIndex; other += 1) {
        requireEvidence(!boxesOverlap(label, chart.dataLabels[other]), `C18 native chart labels overlap for ${mutationCase.id}/${chart.name}.`);
      }
    }
  }
  const baselineTable = baselineContract.slides?.find((slide) => slide.index === 3)?.table;
  const table = result.readability?.table;
  requireEvidence(table?.name === baselineTable?.name && table.rows === baselineTable.rows && table.columns === baselineTable.columns
    && Array.isArray(table.cells) && table.cells.length === table.rows * table.columns, `C18 native table readability inventory drifted for ${mutationCase.id}.`);
  const expectedTable = baselineTable.values.map((row) => [...row]);
  if (mutationCase.operation === "replace-table-cell") expectedTable[mutationCase.cell.row - 1][mutationCase.cell.column - 1] = mutationCase.cell.after;
  for (let index = 0; index < table.cells.length; index += 1) {
    const cell = table.cells[index];
    const row = Math.floor(index / table.columns) + 1;
    const column = (index % table.columns) + 1;
    requireEvidence(cell.row === row && cell.column === column && cell.text === expectedTable[row - 1][column - 1]
      && cell.fontPoints >= rules.tables.minimumCellFontPoints
      && cell.marginLeftPoints === cell.marginRightPoints
      && cell.marginTopPoints === cell.marginBottomPoints
      && cell.fits === true, `C18 native table cell readability drifted for ${mutationCase.id} row ${row} column ${column}.`);
  }
  return true;
}

function normalizedAbsolute(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function readRasterDimensions(file) {
  const bytes = await fs.readFile(file);
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (startOfFrame.has(marker) && length >= 7) {
        return { format: "jpeg", width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  throw new Error(`C18 review artifact is not a supported PNG or JPEG with readable dimensions: ${file}`);
}

export async function verifySemanticMutationEvidence({ root, runDirectory, python, slidesTest, requireCurrentGit = true, requireSourceCurrent = false }) {
  const runFile = (relative) => path.join(runDirectory, ...relative.split("/"));
  const runJson = (relative) => readJson(runFile(relative));
  const scorecard = await runJson("scorecard.json");
  const core = structuredClone(scorecard);
  delete core.scorecardHash;
  requireEvidence(scorecard.schemaVersion === "slidewright-semantic-mutation-scorecard/v2"
    && scorecard.scorecardHash === canonicalHash(core), "C18 scorecard hash or schema is invalid.");

  const implementation = await captureSemanticMutationImplementation(root);
  requireEvidence(canonicalHash(implementation) === canonicalHash(scorecard.provenance?.implementation), "C18 implementation closure drifted.");
  if (requireCurrentGit) {
    const git = captureCleanGit(root);
    requireEvidence(git.commit === scorecard.provenance?.git?.commit
      && scorecard.provenance.git.cleanBefore === true
      && scorecard.provenance.git.cleanAfter === true
      && scorecard.provenance.git.sameCommit === true, "C18 Git provenance drifted.");
  }
  const runtime = await captureSemanticMutationRuntime({ root, python, slidesTest });
  requireEvidence(canonicalHash(runtime) === canonicalHash(scorecard.provenance?.runtime), "C18 runtime binding drifted.");
  if (process.platform === "win32") requireEvidence(runtime.executables?.powerPoint?.path && /^[a-f0-9]{64}$/u.test(runtime.executables.powerPoint.sha256)
    && runtime.executables.powerPoint.fileVersion && runtime.executables.powerPoint.productVersion, "C18 PowerPoint executable runtime binding is incomplete.");

  const contractPath = path.join(root, "fixtures", "semantic-surface", "v1", "mutation-contract.json");
  const baselineContractPath = path.join(root, "fixtures", "semantic-surface", "v1", "semantic-contract.json");
  const contract = await readJson(contractPath);
  const baselineContract = await readJson(baselineContractPath);
  requireEvidence(contract.schemaVersion === "slidewright-semantic-mutation/v1"
    && contract.cases?.length === 5
    && contract.negativeControls?.length === 9, "C18 mutation contract is malformed.");
  const receipts = await collectReceiptTree(runDirectory);
  requireEvidence(canonicalHash(receipts) === canonicalHash(scorecard.receipts), "C18 receipt tree drifted.");
  const commandLog = await runJson("command-log.json");
  const actualPaths = receipts.files.map((item) => item.path);
  const expectedPaths = expectedSemanticMutationReceiptPaths(contract, commandLog.commands?.length ?? 0);
  if (!exactPathInventoryMatches(actualPaths, expectedPaths)) {
    const actual = new Set(actualPaths);
    const expected = new Set(expectedPaths);
    const missing = expectedPaths.filter((item) => !actual.has(item));
    const unexpected = actualPaths.filter((item) => !expected.has(item));
    throw new Error(`C18 receipt inventory drifted: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}.`);
  }
  requireEvidence(scorecard.mutationContractSha256 === await sha256File(contractPath)
    && scorecard.baselineContractSha256 === await sha256File(baselineContractPath), "C18 contract hash drifted.");

  validateSemanticMutationCommandReceipts(commandLog, contract);
  const commandRawOutputs = await validateCommandReceiptBytes(runFile, commandLog);
  requireEvidence(scorecard.scope === contract.scope
    && scorecard.provenance?.logicalCommand === commandLog.logicalCommand
    && canonicalHash(scorecard.visualReviewRequiredDecks) === canonicalHash(contract.visualReview.requiredDecks), "C18 scorecard contract or logical-command binding drifted.");
  const stagingDirectory = stagingDirectoryFromCommandLog(root, commandLog);
  const initialQuiescence = await runJson("powerpoint-quiescence.json");
  const interStageQuiescence = await runJson("powerpoint-interstage-quiescence.json");
  validateSemanticMutationQuiescenceEvidence({
    initial: initialQuiescence,
    interStage: interStageQuiescence,
    scorecardInitial: scorecard.initialPowerPointQuiescence,
    scorecardInterStage: scorecard.interStagePowerPointQuiescence,
    contract,
  });
  requireEvidence(interStageQuiescence.checkpoints?.length === 7
    && interStageQuiescence.checkpoints.every((item) => item.valid), "C18 interstage quiescence inventory is incomplete.");

  const normalSummary = await runJson("watchdog/normal/summary.json");
  const normalIdentity = await runJson("watchdog/normal/identity-receipt.json");
  requireEvidence(canonicalHash(normalSummary) === canonicalHash(scorecard.watchdog?.normal), "C18 watchdog scorecard summary drifted.");
  validateNormalWatchdogEvidence({
    summary: normalSummary,
    identityReceipt: normalIdentity,
    readyText: await fs.readFile(runFile("watchdog/normal/ready.marker"), "utf8"),
    completionText: await fs.readFile(runFile("watchdog/normal/completion.marker"), "utf8"),
    diagnosticSha256: await sha256File(runFile("watchdog/normal/diagnostic.log")),
  });
  requireEvidence(normalSummary.identityReceiptSha256 === await sha256File(runFile("watchdog/normal/identity-receipt.json"))
    && normalSummary.readyMarkerSha256 === await sha256File(runFile("watchdog/normal/ready.marker"))
    && normalSummary.completionMarkerSha256 === await sha256File(runFile("watchdog/normal/completion.marker"))
    && normalSummary.watchdogExit?.valid === true
    && normalSummary.watchdogExit?.exactIdentityAbsent === true
    && normalSummary.watchdogProcessAbsentAfterCompletion === true
    && normalSummary.recoveryReportAbsentAfterExit === true
    && identityAbsent(normalSummary.startup), "C18 watchdog marker hashes drifted or exact normal exit proof is missing.");

  const sourceBinding = await runJson("source-binding.json");
  requireEvidence(canonicalHash(sourceBinding) === canonicalHash(scorecard.sourceBinding)
    && sourceBinding.schemaVersion === "slidewright-semantic-mutation-source-binding/v1"
    && sourceBinding.valid === true
    && sourceBinding.mutationContractSha256 === await sha256File(contractPath)
    && sourceBinding.baselineContractSha256 === await sha256File(baselineContractPath), "C18 source binding drifted.");
  requireEvidence(sourceBinding.baselineSourceRun === `runs/${sourceBinding.semanticSurfaceScorecardHash}`
    && /^[a-f0-9]{64}$/u.test(sourceBinding.semanticSurfaceScorecardHash), "C18 source C08 run is not content addressed.");
  if (requireSourceCurrent) {
    const sourceCurrent = await readJson(path.join(root, "outputs", "semantic-surface", "current.json"));
    requireEvidence(sourceCurrent.schemaVersion === "slidewright-semantic-current/v1"
      && sourceCurrent.scorecardHash === sourceBinding.semanticSurfaceScorecardHash
      && sourceCurrent.run === sourceBinding.baselineSourceRun, "C18 source C08 current pointer changed during verification.");
  }
  const sourceRun = path.join(root, "outputs", "semantic-surface", ...sourceBinding.baselineSourceRun.split("/"));
  const sourceScorecardPath = path.join(sourceRun, "scorecard.json");
  const sourceScorecard = await readJson(sourceScorecardPath);
  await verifySemanticSurfaceEvidence({ root, runDirectory: sourceRun, python, slidesTest, requireCurrentGit: false });
  const sourceBaseline = path.join(sourceRun, "powerpoint-roundtrip.pptx");
  const baseline = runFile("powerpoint-normalized-baseline.pptx");
  requireEvidence(sourceScorecard.scorecardHash === sourceBinding.semanticSurfaceScorecardHash
    && await sha256File(sourceScorecardPath) === sourceBinding.semanticSurfaceScorecardSha256
    && await sha256File(sourceBaseline) === sourceBinding.baselineSourcePptxSha256
    && await sha256File(baseline) === sourceBinding.copiedBaselinePptxSha256
    && sourceBinding.baselineSourcePptxSha256 === sourceBinding.copiedBaselinePptxSha256
    && scorecard.baselinePptxSha256 === sourceBinding.copiedBaselinePptxSha256, "C18 copied C08 baseline drifted.");

  const timeoutControl = await runJson("powerpoint-timeout-cleanup-control.json");
  const timeoutOwnership = await runJson("powerpoint-timeout-probe-ownership.json");
  requireEvidence(canonicalHash(timeoutControl) === canonicalHash(scorecard.timeoutCleanupControl), "C18 timeout cleanup scorecard binding drifted.");
  validateTimeoutCleanupEvidence({
    control: timeoutControl,
    ownership: timeoutOwnership,
    ownershipSha256: await sha256File(runFile("powerpoint-timeout-probe-ownership.json")),
    readyMarkerSha256: await sha256File(runFile("powerpoint-timeout-probe.ready")),
    readyText: await fs.readFile(runFile("powerpoint-timeout-probe.ready"), "utf8"),
  });

  const workerBindings = [
    ["timeout-probe", "powerpoint-timeout-probe", "powerpoint-timeout-probe-ownership.json", "timeout-cleanup-negative-control"],
    ["native-mutation", "powerpoint-native-mutation", "powerpoint-mutation-ownership.json", "semantic-native-object-mutation"],
    ...decksFor(contract).map((deck) => [`render-${deck}`, `render-${deck}`, `renders/${deck}-ownership.json`, "isolated-powerpoint-render"]),
  ];
  requireEvidence(scorecard.workerIntents?.length === workerBindings.length, "C18 worker-intent inventory is incomplete.");
  const powerPointRuntimeReceipts = [];
  const powerPointRuntimeByStage = new Map();
  for (let index = 0; index < workerBindings.length; index += 1) {
    const [stage, stem, ownershipFile, purpose] = workerBindings[index];
    const intentPath = `worker-intents/${stem}-worker-intent.json`;
    const [intent, ownership] = await Promise.all([runJson(intentPath), runJson(ownershipFile)]);
    const runtimeReceiptPath = stage === "timeout-probe" ? "powerpoint-runtime/timeout-probe.json"
      : stage === "native-mutation" ? "powerpoint-runtime/native-mutation.json"
        : `powerpoint-runtime/${stage}.json`;
    const processRuntime = await runJson(runtimeReceiptPath);
    const expectedRuntimeProcessCount = stage.startsWith("render-") ? 5 : 1;
    const expectedOwnershipPath = path.join(stagingDirectory, ...ownershipFile.split("/"));
    requireEvidence(intent.schemaVersion === "slidewright-worker-intent/v1"
      && intent.state === "started"
      && intent.purpose === purpose
      && ownership.schemaVersion === "slidewright-owned-powerpoint/v1"
      && ownership.processName === "POWERPNT"
      && ownership.expectedApplicationVisible === false
      && ownership.workerProcessId === intent.workerProcessId
      && String(ownership.workerProcessName).toLowerCase() === String(intent.workerProcessName).toLowerCase()
      && ownership.workerProcessStartTime === intent.workerProcessStartTime
      && normalizedAbsolute(intent.ownershipRecordPath) === normalizedAbsolute(expectedOwnershipPath)
      && scorecard.workerIntents[index]?.stage === stage
      && scorecard.workerIntents[index]?.sha256 === await sha256File(runFile(intentPath))
      && identityAbsent({ processId: intent.workerProcessId, processName: intent.workerProcessName, processStartTime: intent.workerProcessStartTime }), `C18 worker intent or ownership drifted for ${stage}.`);
    validateOwnedPowerPointRuntimeReceipt({ receipt: processRuntime, ownership, centralRuntime: runtime.executables.powerPoint, expectedProcessCount: expectedRuntimeProcessCount, stage });
    powerPointRuntimeReceipts.push({ stage, path: runtimeReceiptPath, sha256: await sha256File(runFile(runtimeReceiptPath)) });
    powerPointRuntimeByStage.set(stage, processRuntime.processes);
  }
  requireEvidence(canonicalHash(powerPointRuntimeReceipts) === canonicalHash(scorecard.powerPointRuntimeReceipts), "C18 owned PowerPoint executable receipt scorecard binding drifted.");

  const mutationReport = await runJson("powerpoint-mutation.json");
  const mutationOwnership = await runJson("powerpoint-mutation-ownership.json");
  requireEvidence(mutationReport.schemaVersion === "slidewright-semantic-mutation-powerpoint/v1"
    && mutationReport.valid === true
    && mutationReport.application === "Microsoft PowerPoint"
    && typeof mutationReport.version === "string" && mutationReport.version.length > 0
    && typeof mutationReport.build === "string" && mutationReport.build.length > 0
    && runtime.executables.powerPoint.fileVersion.startsWith(`${mutationReport.version}.${mutationReport.build}.`)
    && runtime.executables.powerPoint.productVersion.startsWith(`${mutationReport.version}.${mutationReport.build}.`)
    && mutationReport.baselineSha256 === await sha256File(baseline)
    && mutationReport.mutationContractSha256 === await sha256File(contractPath)
    && mutationReport.cases?.length === contract.cases.length
    && mutationOwnership.processId === mutationReport.processId
    && mutationOwnership.processStartTime === mutationReport.processStartTime
    && identityAbsent({ processId: mutationReport.processId, processName: "POWERPNT", processStartTime: mutationReport.processStartTime }), "C18 native PowerPoint mutation report drifted.");
  const expectedMutationPaths = [path.join(stagingDirectory, "powerpoint-normalized-baseline.pptx"), ...contract.cases.map((item) => path.join(stagingDirectory, "mutations", `${item.id}.pptx`))].map(normalizedAbsolute).sort();
  const ownedMutationPaths = (mutationOwnership.ownedPresentationPaths ?? []).map(normalizedAbsolute).sort();
  requireEvidence(canonicalHash(expectedMutationPaths) === canonicalHash(ownedMutationPaths), "C18 mutation ownership allowlist drifted.");
  const saveReopenCases = [];
  const nativeReadabilityByCase = new Map();
  for (let index = 0; index < contract.cases.length; index += 1) {
    const mutationCase = contract.cases[index];
    const result = mutationReport.cases[index];
    const variantSha256 = await sha256File(runFile(`mutations/${mutationCase.id}.pptx`));
    requireEvidence(result.id === mutationCase.id
      && normalizedAbsolute(result.output) === normalizedAbsolute(path.join(stagingDirectory, "mutations", `${mutationCase.id}.pptx`))
      && result.sha256 === variantSha256
      && result.afterSaveReopen !== null
      && result.readability?.charts?.length === 2
      && result.readability?.table, `C18 PowerPoint save/reopen case drifted for ${mutationCase.id}.`);
    validateMutationCaseState(result, mutationCase);
    validateNativeReadability(result, mutationCase, baselineContract, contract.readability);
    nativeReadabilityByCase.set(mutationCase.id, result.readability);
    saveReopenCases.push({ id: result.id, sha256: result.sha256, afterSaveReopen: result.afterSaveReopen });
  }
  requireEvidence(canonicalHash(scorecard.nativePowerPointMutation) === canonicalHash({
    valid: mutationReport.valid,
    automationProcessOwned: true,
    application: mutationReport.application,
    version: mutationReport.version,
    build: mutationReport.build,
    baselineSha256: mutationReport.baselineSha256,
    ownershipRecordSha256: await sha256File(runFile("powerpoint-mutation-ownership.json")),
    reportSha256: await sha256File(runFile("powerpoint-mutation.json")),
    saveReopenCases,
  }), "C18 native mutation scorecard derivation drifted.");

  const renderEvidence = [];
  for (const deck of decksFor(contract)) {
    const input = deck === "powerpoint-normalized-baseline" ? baseline : runFile(`mutations/${deck}.pptx`);
    const ownershipInput = deck === "powerpoint-normalized-baseline"
      ? path.join(stagingDirectory, "powerpoint-normalized-baseline.pptx")
      : path.join(stagingDirectory, "mutations", `${deck}.pptx`);
    const reportPath = `renders/${deck}.json`;
    const ownershipPath = `renders/${deck}-ownership.json`;
    const [report, ownership] = await Promise.all([runJson(reportPath), runJson(ownershipPath)]);
    requireEvidence(report.valid === true && report.application === "Microsoft PowerPoint"
      && report.allSessionsOwned === true && report.slideCount === 4 && report.inputSha256 === await sha256File(input)
      && report.sessions?.length === 5
      && report.sessions.every((item) => item.automationProcessOwned === true && item.attachedToPreExistingProcess === false
        && item.version === mutationReport.version && item.build === mutationReport.build
        && identityAbsent({ processId: item.processId, processName: "POWERPNT", processStartTime: item.processStartTime }))
      && ownership.expectedApplicationVisible === false
      && ownership.processId === report.sessions.at(-1).processId
      && ownership.processStartTime === report.sessions.at(-1).processStartTime
      && ownership.purpose === "slide-04"
      && canonicalHash((ownership.ownedPresentationPaths ?? []).map(normalizedAbsolute)) === canonicalHash([normalizedAbsolute(ownershipInput)]), `C18 render ownership drifted for ${deck}.`);
    validateOwnedPowerPointRuntimeReceipt({
      receipt: { schemaVersion: "slidewright-owned-powerpoint-runtime/v1", processes: powerPointRuntimeByStage.get(`render-${deck}`) },
      ownership,
      centralRuntime: runtime.executables.powerPoint,
      expectedProcessCount: 5,
      sessions: report.sessions,
      stage: `render-${deck}`,
    });
    for (let index = 0; index < 4; index += 1) {
      const slide = String(index + 1).padStart(2, "0");
      const item = report.renders[index];
      const [pngDimensions, reviewDimensions] = await Promise.all([
        readRasterDimensions(runFile(`renders/${deck}/slide-${slide}.png`)),
        readRasterDimensions(runFile(`renders/${deck}/slide-${slide}.jpg`)),
      ]);
      requireEvidence(item.slide === index + 1 && item.file === `slide-${slide}.png` && item.reviewFile === `slide-${slide}.jpg`
        && item.width === 1600 && item.height === 900
        && pngDimensions.format === "png" && pngDimensions.width === 1600 && pngDimensions.height === 900
        && reviewDimensions.format === "jpeg" && reviewDimensions.width === 1600 && reviewDimensions.height === 900
        && item.sha256 === await sha256File(runFile(`renders/${deck}/slide-${slide}.png`))
        && item.reviewSha256 === await sha256File(runFile(`renders/${deck}/slide-${slide}.jpg`)), `C18 render bytes drifted for ${deck} slide ${index + 1}.`);
    }
    renderEvidence.push({
      id: deck,
      valid: report.valid,
      inputSha256: report.inputSha256,
      slideCount: report.slideCount,
      allSessionsOwned: report.allSessionsOwned,
      isolation: report.isolation,
      sessions: report.sessions,
      ownershipRecordSha256: await sha256File(runFile(ownershipPath)),
      renderReportSha256: await sha256File(runFile(reportPath)),
      renders: report.renders,
    });
  }
  requireEvidence(canonicalHash(renderEvidence) === canonicalHash(scorecard.renderEvidence), "C18 render-evidence scorecard derivation drifted.");

  const renderMeasurements = [];
  const mutationAudits = [];
  const auditScript = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "semantic_surface", "audit_semantic_mutation.py");
  for (const mutationCase of contract.cases) {
    const variant = runFile(`mutations/${mutationCase.id}.pptx`);
    const renderPath = `render-evidence/${mutationCase.id}.json`;
    const render = await runJson(renderPath);
    const rederived = await rederiveSemanticMutationCase({
      root, python, auditScript, baseline, variant, contractPath, baselineContractPath,
      powerPointReport: runFile("powerpoint-mutation.json"),
      renderPng: runFile(`renders/${mutationCase.id}/slide-02.png`),
      caseId: mutationCase.id,
    });
    requireEvidence(canonicalHash(render) === canonicalHash(rederived.measurement), `C18 independently rederived render evidence drifted for ${mutationCase.id}.`);
    requireEvidence(render.schemaVersion === "slidewright-semantic-mutation-render-evidence/v1"
      && render.valid === true && render.caseId === mutationCase.id
      && render.inputPptxSha256 === await sha256File(variant)
      && render.renderPngSha256 === await sha256File(runFile(`renders/${mutationCase.id}/slide-02.png`))
      && render.slide === 2 && render.width === 1600 && render.height === 900
      && render.charts?.length === 2
      && render.warnings?.length === 0 && render.failures?.length === 0, `C18 render measurement drifted for ${mutationCase.id}.`);
    const baselineCharts = baselineContract.slides.find((slide) => slide.index === 2).charts;
    requireEvidence(canonicalHash(render.charts.map((chart) => chart.name)) === canonicalHash(baselineCharts.map((chart) => chart.name)), `C18 rendered chart identity drifted for ${mutationCase.id}.`);
    for (const chart of render.charts) {
      const baselineChart = baselineCharts.find((item) => item.name === chart.name);
      const expectedMarkCount = mutationCase.operation === "replace-chart-data" && mutationCase.target === chart.name
        ? mutationCase.expected.categories.length
        : baselineChart.categories.length;
      validateRenderMeasurementChart(chart, contract.readability.charts, mutationCase.id, { width: render.width, height: render.height, expectedMarkCount });
    }
    renderMeasurements.push({ id: mutationCase.id, valid: render.valid, variantSha256: render.inputPptxSha256, renderPngSha256: render.renderPngSha256, evidenceSha256: await sha256File(runFile(renderPath)), charts: render.charts, warnings: render.warnings });

    const auditPath = `audits/${mutationCase.id}.json`;
    const audit = await runJson(auditPath);
    requireEvidence(canonicalHash(audit) === canonicalHash(rederived.audit), `C18 independently rederived PPTX audit drifted for ${mutationCase.id}.`);
    const nativeReadability = nativeReadabilityByCase.get(mutationCase.id);
    requireEvidence(audit.schemaVersion === "slidewright-semantic-mutation-audit/v1"
      && audit.valid === true && audit.caseId === mutationCase.id
      && allTrueExact(audit.checks, ["sourceBound", "exactInventory", "exactAuthorizedMutation", "nativeCharts", "nativeTable", "nativeDiagram"]) && audit.packageClosure?.valid === true
      && audit.summary?.objects === 40 && audit.summary?.failures === 0
      && audit.failures?.length === 0 && audit.warnings?.length === 0
      && audit.readability?.charts?.length === 2
      && audit.readability.charts.every((chart) => allTrueExact(chart.checks, ["native", "frame", "font", "categoryCount", "seriesCount", "markThickness", "labelsInBounds", "labelsNoOverlap", "labelTextMatches", "labelsDetectedInRender", "markContrast", "textContrast"])
        && chart.widthPoints >= contract.readability.charts.minimumFramePoints.width
        && chart.heightPoints >= contract.readability.charts.minimumFramePoints.height
        && chart.minimumXmlFontPoints >= contract.readability.charts.minimumLabelFontPoints
        && chart.minimumPowerPointFontPoints >= contract.readability.charts.minimumLabelFontPoints
        && chart.markContrast >= contract.readability.charts.minimumMarkContrast
        && chart.textContrast >= contract.readability.charts.minimumTextContrast
        && Array.isArray(chart.powerPointDataLabels) && chart.powerPointDataLabels.length > 0)
      && audit.readability.table?.native === true
      && audit.readability.table?.font === true
      && audit.readability.table?.symmetricMargins === true
      && audit.readability.table?.staticFit === true
      && audit.readability.table?.powerPointFit === true
      && audit.readability.table?.contrast === true
      && allTrueExact(audit.readability.diagram?.checks, ["labelsInsideNodes", "textOverlapForbidden", "connectorsAttached", "connectorWeight", "connectorContrast", "noNonEndpointCrossings"]), `C18 mutation audit drifted for ${mutationCase.id}.`);
    for (const chart of audit.readability.charts) {
      const nativeChart = nativeReadability.charts.find((item) => item.name === chart.name);
      requireEvidence(nativeChart
        && chart.minimumPowerPointFontPoints === Math.min(nativeChart.categoryAxisFontPoints, nativeChart.valueAxisFontPoints, nativeChart.dataLabelFontPoints)
        && canonicalHash(chart.powerPointDataLabels) === canonicalHash(nativeChart.dataLabels), `C18 audit-to-PowerPoint chart derivation drifted for ${mutationCase.id}/${chart.name}.`);
    }
    requireEvidence(audit.sourceBinding.baselineSha256 === await sha256File(baseline)
      && audit.sourceBinding.variantSha256 === await sha256File(variant)
      && audit.sourceBinding.mutationContractSha256 === await sha256File(contractPath)
      && audit.sourceBinding.baselineContractSha256 === await sha256File(baselineContractPath)
      && audit.sourceBinding.powerPointReportSha256 === await sha256File(runFile("powerpoint-mutation.json"))
      && audit.sourceBinding.renderEvidenceSha256 === await sha256File(runFile(renderPath)), `C18 audit source binding drifted for ${mutationCase.id}.`);
    mutationAudits.push({ id: mutationCase.id, valid: audit.valid, variantSha256: audit.sourceBinding.variantSha256, renderEvidenceSha256: audit.sourceBinding.renderEvidenceSha256, reportSha256: await sha256File(runFile(auditPath)), sourceBinding: audit.sourceBinding, checks: audit.checks, summary: audit.summary, readability: audit.readability, warnings: audit.warnings });
  }
  requireEvidence(canonicalHash(renderMeasurements) === canonicalHash(scorecard.renderMeasurements)
    && canonicalHash(mutationAudits) === canonicalHash(scorecard.mutationAudits), "C18 measurement or mutation-audit scorecard derivation drifted.");

  const negative = await runJson("negative-controls.json");
  validateNegativeSummaryHeader(negative, contract);
  for (let index = 0; index < negative.positiveAudits.length; index += 1) {
    const positive = negative.positiveAudits[index];
    const expectedCase = contract.cases[index];
    requireEvidence(positive.caseId === expectedCase.id
      && positive.auditReport === `positive-audits/${expectedCase.id}.json`, `C18 positive-control path drifted for ${expectedCase.id}.`);
    const report = await runJson(`negative-controls/${positive.auditReport}`);
    requireEvidence(report.valid === true && report.caseId === positive.caseId
      && positive.valid === true && positive.returnCode === 0 && positive.failureCount === 0
      && positive.failureCodes?.length === 0
      && positive.renderEvidenceSha256 === await sha256File(runFile(`render-evidence/${positive.caseId}.json`))
      && positive.variantSha256 === await sha256File(runFile(`mutations/${positive.caseId}.pptx`))
      && canonicalHash(report) === canonicalHash(await runJson(`audits/${positive.caseId}.json`)), `C18 positive control drifted for ${positive.caseId}.`);
  }
  const negativeDerived = [];
  for (let index = 0; index < negative.controls.length; index += 1) {
    const control = negative.controls[index];
    const expectedControl = SEMANTIC_MUTATION_NEGATIVE_EXPECTATIONS[contract.negativeControls[index]];
    requireEvidence(control.id === contract.negativeControls[index] && expectedControl
      && control.caseId === expectedControl.caseId
      && canonicalHash(control.intendedFailureCodes) === canonicalHash([expectedControl.code])
      && canonicalHash(control.matchedIntendedFailureCodes) === canonicalHash([expectedControl.code])
      && control.artifact === `${control.id}/${control.id}.pptx`
      && control.auditReport === `${control.id}/audit.json`, `C18 destructive-control contract drifted for ${control.id}.`);
    const base = `negative-controls/${control.id}`;
    const audit = await runJson(`${base}/audit.json`);
    const rederivedNegative = await rederiveNegativeAudit({
      root, python, auditScript, baseline,
      variant: runFile(`${base}/${control.id}.pptx`),
      contractPath: runFile(`${base}/mutation-contract.json`),
      baselineContractPath,
      powerPointReport: runFile(`${base}/powerpoint-report.json`),
      renderEvidence: runFile(`render-evidence/${control.caseId}.json`),
      caseId: control.caseId,
      controlId: control.id,
    });
    requireEvidence(control.rejected === true && control.actualRejection === true && control.returnCode === 2
      && control.expectedRejection === true
      && control.failureCodes?.length > 0 && control.matchedIntendedFailureCodes?.length > 0
      && audit.schemaVersion === "slidewright-semantic-mutation-audit/v1" && audit.caseId === control.caseId
      && audit.valid === false && audit.failures?.length > 0 && audit.warnings?.length === 0
      && control.failureCount === audit.failures.length
      && canonicalHash(audit) === canonicalHash(rederivedNegative)
      && audit.sourceBinding?.baselineSha256 === await sha256File(baseline)
      && audit.sourceBinding?.variantSha256 === await sha256File(runFile(`${base}/${control.id}.pptx`))
      && audit.sourceBinding?.mutationContractSha256 === await sha256File(runFile(`${base}/mutation-contract.json`))
      && audit.sourceBinding?.baselineContractSha256 === await sha256File(baselineContractPath)
      && audit.sourceBinding?.powerPointReportSha256 === await sha256File(runFile(`${base}/powerpoint-report.json`))
      && audit.sourceBinding?.renderEvidenceSha256 === await sha256File(runFile(`render-evidence/${control.caseId}.json`))
      && canonicalHash([...new Set(audit.failures.map((item) => item.code))].sort()) === canonicalHash([...control.failureCodes].sort())
      && control.artifactSha256 === await sha256File(runFile(`${base}/${control.id}.pptx`))
      && control.contractSha256 === await sha256File(runFile(`${base}/mutation-contract.json`))
      && control.powerPointReportSha256 === await sha256File(runFile(`${base}/powerpoint-report.json`))
      && control.renderEvidenceSha256 === await sha256File(runFile(`render-evidence/${control.caseId}.json`)), `C18 destructive control drifted for ${control.id}.`);
    negativeDerived.push({
      id: control.id,
      rejected: control.rejected,
      failureCodes: control.failureCodes,
      failureCount: control.failureCount,
      artifactSha256: control.artifactSha256,
      contractSha256: control.contractSha256,
      powerPointReportSha256: control.powerPointReportSha256,
      renderEvidenceSha256: control.renderEvidenceSha256,
      auditReportSha256: await sha256File(runFile(`${base}/audit.json`)),
    });
  }
  requireEvidence(canonicalHash(negativeDerived) === canonicalHash(scorecard.negativeControls)
    && scorecard.negativeControlsReportSha256 === await sha256File(runFile("negative-controls.json"))
    && negative.rejected === contract.negativeControls.length
    && negative.rejectedCount === contract.negativeControls.length
    && negative.total === contract.negativeControls.length, "C18 negative-control scorecard derivation drifted.");

  const overflowChecks = [];
  const slidesTestCommands = commandLog.commands.map((item, index) => ({ item, raw: commandRawOutputs[index] }))
    .filter(({ item }) => item.args?.[0] === "<external>/slides_test.py");
  requireEvidence(slidesTestCommands.length === decksFor(contract).length, "C18 raw overflow command inventory drifted.");
  for (let deckIndex = 0; deckIndex < decksFor(contract).length; deckIndex += 1) {
    const deck = decksFor(contract)[deckIndex];
    const input = deck === "powerpoint-normalized-baseline" ? baseline : runFile(`mutations/${deck}.pptx`);
    const reportPath = `overflow/${deck}.json`;
    const report = await runJson(reportPath);
    requireEvidence(report.schemaVersion === "slidewright-semantic-mutation-overflow/v1"
      && report.valid === true && report.target === deck && report.command === "slides_test.py"
      && report.exitCode === 0 && report.inputSha256 === await sha256File(input)
      && report.stdout === slidesTestCommands[deckIndex].raw.stdout.trim()
      && report.stderr === slidesTestCommands[deckIndex].raw.stderr.trim()
      && report.warnings?.length === 0, `C18 overflow evidence drifted for ${deck}.`);
    overflowChecks.push({ target: deck, valid: report.valid, inputSha256: report.inputSha256, reportSha256: await sha256File(runFile(reportPath)) });
  }
  requireEvidence(canonicalHash(overflowChecks) === canonicalHash(scorecard.overflowChecks), "C18 overflow scorecard derivation drifted.");

  requireEvidence(scorecard.valid === true
    && scorecard.provenance.git.cleanBefore === true
    && scorecard.provenance.git.cleanAfter === true
    && scorecard.provenance.git.sameCommit === true
    && scorecard.watchdog.normal.valid === true
    && scorecard.powerPointRuntimeReceiptsValid === true
    && scorecard.workerIntentsValid === true
    && scorecard.nativePowerPointMutation.valid === true
    && scorecard.renderMeasurementsValid === true
    && scorecard.mutationAuditsValid === true
    && scorecard.negativeControlsValid === true
    && scorecard.overflowChecksValid === true
    && scorecard.reviewArtifactsReady === true
    && scorecard.warnings?.length === 0, "C18 derived scorecard gates are invalid.");
  return { valid: true, scorecardHash: scorecard.scorecardHash, receiptCount: receipts.files.length };
}

export async function verifySemanticMutationReview({ root, published = path.join(root, "outputs", "semantic-mutation"), python, slidesTest }) {
  const current = await readJson(path.join(published, "current.json"));
  requireEvidence(current.schemaVersion === "slidewright-semantic-current/v1"
    && /^[a-f0-9]{64}$/u.test(current.scorecardHash ?? "")
    && current.run === `runs/${current.scorecardHash}`, "C18 machine current pointer is invalid during review verification.");
  const pointer = await readJson(path.join(published, "current-review.json"));
  requireEvidence(pointer.schemaVersion === "slidewright-semantic-mutation-current-review/v1"
    && pointer.scorecardHash === current.scorecardHash
    && /^[a-f0-9]{64}$/u.test(pointer.reviewHash ?? "")
    && pointer.review === `reviews/${current.scorecardHash}/${pointer.reviewHash}.json`, "C18 current-review pointer is invalid.");
  const runDirectory = path.resolve(published, ...current.run.split("/"));
  const reviewPath = path.resolve(published, ...pointer.review.split("/"));
  requireEvidence(runDirectory === path.resolve(published, "runs", current.scorecardHash)
    && reviewPath === path.resolve(published, "reviews", current.scorecardHash, `${pointer.reviewHash}.json`), "C18 review or machine pointer escaped its content-addressed directory.");
  const machineVerification = await verifySemanticMutationEvidence({ root, runDirectory, python, slidesTest, requireCurrentGit: false, requireSourceCurrent: false });
  const [scorecard, review, convenienceScorecard, immutableScorecard] = await Promise.all([
    readJson(path.join(runDirectory, "scorecard.json")),
    readJson(reviewPath),
    fs.readFile(path.join(published, "scorecard.json")),
    fs.readFile(path.join(runDirectory, "scorecard.json")),
  ]);
  requireEvidence(convenienceScorecard.equals(immutableScorecard), "C18 convenience scorecard drifted during review verification.");
  const reviewCore = structuredClone(review);
  delete reviewCore.reviewHash;
  requireEvidence(review.schemaVersion === "slidewright-semantic-mutation-review/v1"
    && review.valid === true && review.reviewHash === pointer.reviewHash
    && canonicalHash(reviewCore) === pointer.reviewHash
    && review.scorecardHash === current.scorecardHash
    && review.scorecardSha256 === await sha256File(path.join(runDirectory, "scorecard.json"))
    && canonicalHash(review.machineVerification) === canonicalHash(machineVerification)
    && typeof review.reviewer?.kind === "string" && review.reviewer.kind.length > 0
    && typeof review.reviewer?.id === "string" && review.reviewer.id.length > 0
    && review.inspectionMethod === "Every persisted 1600x900 review image inspected individually at full size; montage review does not qualify."
    && Array.isArray(review.slides) && review.slides.length === 24, "C18 review hash, machine binding, or reviewer metadata drifted.");
  const expected = [];
  for (const deck of scorecard.renderEvidence ?? []) {
    for (const render of deck.renders ?? []) {
      const [png, jpeg] = await Promise.all([
        readRasterDimensions(path.join(runDirectory, "renders", deck.id, render.file)),
        readRasterDimensions(path.join(runDirectory, "renders", deck.id, render.reviewFile)),
      ]);
      requireEvidence(png.format === "png" && jpeg.format === "jpeg"
        && png.width === 1600 && png.height === 900 && jpeg.width === 1600 && jpeg.height === 900
        && render.width === 1600 && render.height === 900, `C18 full-size image dimensions drifted for ${deck.id} slide ${render.slide}.`);
      expected.push({
        deckId: deck.id,
        slide: render.slide,
        pngSha256: await sha256File(path.join(runDirectory, "renders", deck.id, render.file)),
        reviewSha256: await sha256File(path.join(runDirectory, "renders", deck.id, render.reviewFile)),
        width: png.width,
        height: png.height,
        verdict: "pass",
        findings: [],
      });
    }
  }
  requireEvidence(expected.length === 24 && expected.every((item) => item.width === 1600 && item.height === 900)
    && canonicalHash(review.slides) === canonicalHash(expected), "C18 review slide decisions or full-size artifact hashes drifted.");
  return { valid: true, scorecardHash: current.scorecardHash, reviewHash: pointer.reviewHash, slideCount: expected.length };
}
