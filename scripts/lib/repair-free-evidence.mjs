import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REPAIR_FREE_CONTROL_IDS = Object.freeze([
  "powerpoint-repair-dialog",
  "crc-corrupt", "duplicate-part", "traversal-part", "malformed-xml",
  "missing-content-type", "dangling-relationship", "openxml-schema-invalid",
  "removed-content", "removed-chart-label", "removed-diagram-label", "removed-hyperlink-target",
  "watcher-evidence-tamper",
]);

export const REPAIR_FREE_IMPLEMENTATION_PATHS = Object.freeze([
  "package.json",
  "package-lock.json",
  "fixtures/repair-free/v1/fixture-contract.json",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/audit_opc_package.py",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/generate_fidelity_fixtures.mjs",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/negative_controls.py",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/powerpoint_repair_free_roundtrip.ps1",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/semantic_inventory.py",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/setup_openxml.mjs",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/validate_openxml.ps1",
  "plugins/slidewright/skills/slidewright/scripts/repair_free/watch_powerpoint_windows.ps1",
  "plugins/slidewright/skills/slidewright/scripts/benchmark/fidelity_suite.mjs",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/presentation_path_identity.ps1",
  "plugins/slidewright/skills/slidewright/scripts/semantic_surface/cleanup_owned_powerpoint.ps1",
  "scripts/lib/exact-worker-process.mjs",
  "scripts/lib/owned-process-cleanup.mjs",
  "scripts/lib/repair-free-evidence.mjs",
  "scripts/lib/versioned-evidence-publish.mjs",
  "scripts/run-repair-free-benchmark.mjs",
  "scripts/verify-repair-free-evidence.mjs",
  "tests/fixtures/make-opc-package.py",
  "tests/repair-free-opc.test.mjs",
  "tests/repair-free.test.mjs",
]);

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const POSITIVE_REPORTS = Object.freeze([
  "source-opc.json", "source-openxml.json", "source-inventory.json", "powerpoint.json",
  "ownership.json", "window-watch.json", "roundtrip-opc.json", "roundtrip-openxml.json",
  "roundtrip-inventory.json",
]);
const OPC_CONTROL_CODES = Object.freeze({
  "crc-corrupt": "RF001",
  "duplicate-part": "RF002",
  "traversal-part": "RF010",
  "malformed-xml": "RF004",
  "missing-content-type": "RF009",
  "dangling-relationship": "RF007",
});

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function canonicalHash(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
}

export async function sha256File(file) {
  return canonicalHash(await fs.readFile(file));
}

function fail(message) {
  throw new Error(`C04 evidence invalid: ${message}`);
}

function confined(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularFile(root, relative, label = relative, { allowEmpty = false } = {}) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.startsWith("/") || !confined(root, path.resolve(root, ...relative.split("/")))) fail(`${label} path escapes its evidence root`);
  const absolute = path.resolve(root, ...relative.split("/"));
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (!allowEmpty && stat.size < 1)) fail(`${label} is missing, empty, or not a regular file`);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(absolute);
  if (!confined(realRoot, real)) fail(`${label} realpath escapes its evidence root`);
  return { absolute, stat };
}

async function jsonFile(root, relative) {
  const { absolute } = await regularFile(root, relative);
  try { return JSON.parse((await fs.readFile(absolute, "utf8")).replace(/^\uFEFF/u, "")); } catch { fail(`${relative} is not valid JSON`); }
}

async function fileRecord(root, relative) {
  const { absolute, stat } = await regularFile(root, relative, relative, { allowEmpty: true });
  return { path: relative, bytes: stat.size, sha256: await sha256File(absolute) };
}

export async function collectRepairFreeEvidenceTree(runDirectory) {
  const files = [];
  async function visit(current, prefix = "") {
    const entries = (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === "scorecard.json") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push(await fileRecord(runDirectory, relative));
      else fail(`evidence tree contains a non-regular entry at ${relative}`);
    }
  }
  await visit(runDirectory);
  if (new Set(files.map((item) => item.path.toLowerCase())).size !== files.length) fail("evidence tree contains case-folded duplicate paths");
  return { files, fileCount: files.length, treeSha256: canonicalHash(files) };
}

export async function captureRepairFreeImplementation(root, { snapshotRoot = null } = {}) {
  const files = [];
  for (const relative of REPAIR_FREE_IMPLEMENTATION_PATHS) {
    const absolute = path.resolve(root, ...relative.split("/"));
    if (!confined(root, absolute)) fail(`implementation path escapes the repository: ${relative}`);
    const stat = await fs.lstat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) fail(`implementation file is missing or non-regular: ${relative}`);
    const record = { path: relative, bytes: stat.size, sha256: await sha256File(absolute), snapshot: `implementation/${relative}` };
    files.push(record);
    if (snapshotRoot) {
      const target = path.join(snapshotRoot, ...record.snapshot.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(absolute, target);
    }
  }
  return { files, fileCount: files.length, treeSha256: canonicalHash(files) };
}

export async function captureArtifactToolRuntime(root, { snapshotRoot = null } = {}) {
  const packageRoot = await fs.realpath(path.join(root, "node_modules", "@oai", "artifact-tool"));
  const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  const files = [];
  async function visit(current, prefix = "") {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        const record = { path: relative, bytes: stat.size, sha256: await sha256File(absolute), snapshot: `runtime/artifact-tool/${relative}` };
        files.push(record);
        if (snapshotRoot) {
          const target = path.join(snapshotRoot, ...record.snapshot.split("/"));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(absolute, target);
        }
      } else fail(`artifact-tool runtime contains a non-regular entry at ${relative}`);
    }
  }
  await visit(packageRoot);
  return { package: "@oai/artifact-tool", version: packageJson.version, files, fileCount: files.length, treeSha256: canonicalHash(files) };
}

export function repairFreeScorecardHash(scorecard) {
  const value = structuredClone(scorecard);
  delete value.scorecardHash;
  return canonicalHash(value);
}

export function validateRepairFreeContract(contract) {
  if (!contract || contract.schemaVersion !== "slidewright-repair-free-contract/v1") fail("contract schema drifted");
  if (contract.minimumFixtureCount !== 26 || !Array.isArray(contract.fixtures) || contract.fixtures.length !== 26) fail("contract must freeze exactly 26 fixtures");
  const ids = contract.fixtures.map((item) => item.id);
  if (ids.some((id) => !SAFE_ID.test(id)) || new Set(ids).size !== ids.length) fail("contract fixture IDs are unsafe or duplicated");
  const categories = Object.fromEntries(Object.keys(contract.categoryQuotas ?? {}).map((category) => [category, 0]));
  for (const fixture of contract.fixtures) {
    if (!Object.hasOwn(categories, fixture.category)) fail(`fixture '${fixture.id}' has an undeclared category`);
    categories[fixture.category] += 1;
  }
  for (const [category, minimum] of Object.entries(contract.categoryQuotas ?? {})) {
    if (!Number.isInteger(minimum) || minimum < 1 || categories[category] < minimum) fail(`category '${category}' is below its quota`);
  }
  if (contract.openXml?.package !== "DocumentFormat.OpenXml" || contract.openXml?.version !== "2.20.0" || !HASH.test(contract.openXml?.sha256 ?? "") || !HASH.test(contract.openXml?.assemblySha256 ?? "")) fail("Open XML runtime contract drifted");
  return { ids, categories };
}

export function verifyRepairFreeScorecard(scorecard, { requireRelease = true, contract = null, contractSha256 = null } = {}) {
  if (!scorecard || scorecard.schemaVersion !== "slidewright-repair-free-scorecard/v2") fail("scorecard schema drifted");
  if (repairFreeScorecardHash(scorecard) !== scorecard.scorecardHash) fail("scorecard hash drifted");
  if (!Array.isArray(scorecard.warnings) || scorecard.warnings.length !== 0) fail("warnings are not empty");
  if (!scorecard.evidence || scorecard.evidence.fileCount !== scorecard.evidence.files?.length || !HASH.test(scorecard.evidence.treeSha256 ?? "")) fail("evidence inventory is incomplete");
  if (!scorecard.implementation || scorecard.implementation.fileCount !== REPAIR_FREE_IMPLEMENTATION_PATHS.length || !HASH.test(scorecard.implementation.treeSha256 ?? "")) fail("implementation closure is incomplete");
  if (canonicalHash(scorecard.implementation.files?.map((item) => item.path).sort()) !== canonicalHash([...REPAIR_FREE_IMPLEMENTATION_PATHS].sort())) fail("implementation closure paths drifted");
  if (!scorecard.openXmlRuntime?.valid || scorecard.openXmlRuntime.package !== "DocumentFormat.OpenXml" || scorecard.openXmlRuntime.version !== "2.20.0" || !HASH.test(scorecard.openXmlRuntime.packageSha256 ?? "") || !HASH.test(scorecard.openXmlRuntime.assemblySha256 ?? "")) fail("pinned Open XML runtime is missing");
  if (scorecard.environment?.platform !== "win32" || scorecard.environment?.powerPoint?.application !== "Microsoft PowerPoint" || !HASH.test(scorecard.environment?.powerPoint?.executableSha256 ?? "")) fail("PowerPoint environment binding is incomplete");
  if (scorecard.environment?.artifactTool?.package !== "@oai/artifact-tool" || typeof scorecard.environment?.artifactTool?.version !== "string" || scorecard.environment.artifactTool.fileCount !== scorecard.environment.artifactTool.files?.length || !HASH.test(scorecard.environment.artifactTool.treeSha256 ?? "")) fail("artifact-tool runtime binding is incomplete");
  if (!Array.isArray(scorecard.fixtures) || scorecard.fixtureCount !== scorecard.fixtures.length || scorecard.fixtureCount !== 26) fail("fixture count is incomplete");
  const fixtureIds = scorecard.fixtures.map((item) => item.id);
  if (fixtureIds.some((id) => !SAFE_ID.test(id)) || new Set(fixtureIds).size !== fixtureIds.length) fail("fixture IDs are unsafe or duplicated");
  const sourceHashes = new Set();
  const sourceOrigins = new Set();
  const powerPointIdentities = new Set();
  for (const fixture of scorecard.fixtures) {
    if (!fixture.valid || (requireRelease && !fixture.sourceFresh) || !fixture.sourceUnchanged || !fixture.semanticInventoryPreserved || !fixture.sourceOpcValid || fixture.sourceOpenXmlErrors !== 0
      || !fixture.powerpointValid || !fixture.alertsEnabled || !fixture.liveStatePreserved || fixture.visibleWindowCount !== 0
      || fixture.repairSignalCount !== 0 || !fixture.ownedProcessExited || !fixture.roundtripOpcValid || fixture.roundtripOpenXmlErrors !== 0) fail(`fixture '${fixture.id}' lost a required proof`);
    for (const key of ["sourceSha256", "roundtripSha256", "inventorySha256"]) if (!HASH.test(fixture[key] ?? "")) fail(`fixture '${fixture.id}' ${key} is invalid`);
    if (!HASH.test(fixture.powerpointExecutableSha256 ?? "") || typeof fixture.powerpointVersion !== "string" || typeof fixture.powerpointBuild !== "string") fail(`fixture '${fixture.id}' PowerPoint runtime binding is invalid`);
    if (sourceHashes.has(fixture.sourceSha256)) fail(`fixture '${fixture.id}' duplicates source bytes`);
    if (sourceOrigins.has(fixture.originPath?.toLowerCase())) fail(`fixture '${fixture.id}' duplicates a source origin`);
    sourceHashes.add(fixture.sourceSha256);
    sourceOrigins.add(fixture.originPath?.toLowerCase());
    powerPointIdentities.add(`${fixture.powerpointVersion}|${fixture.powerpointBuild}|${fixture.powerpointExecutableSha256}`);
  }
  if (powerPointIdentities.size !== 1 || !powerPointIdentities.has(`${scorecard.environment.powerPoint.version}|${scorecard.environment.powerPoint.build}|${scorecard.environment.powerPoint.executableSha256}`)) fail("PowerPoint runtime changed within the fixture matrix");
  const controls = scorecard.negativeControls ?? [];
  if (controls.length !== REPAIR_FREE_CONTROL_IDS.length || new Set(controls.map((item) => item.id)).size !== controls.length) fail("negative-control set has duplicates, additions, or removals");
  if (canonicalHash(controls.map((item) => item.id).sort()) !== canonicalHash([...REPAIR_FREE_CONTROL_IDS].sort())) fail("negative-control IDs drifted");
  for (const control of controls) if (control.rejected !== true) fail(`negative control '${control.id}' was not rejected`);
  if (contract) {
    const expected = validateRepairFreeContract(contract);
    if (canonicalHash(fixtureIds) !== canonicalHash(expected.ids)) fail("fixture order or identity differs from the committed contract");
    if (canonicalHash(scorecard.categoryCounts) !== canonicalHash(expected.categories) || canonicalHash(scorecard.categoryQuotas) !== canonicalHash(contract.categoryQuotas)) fail("fixture categories or quotas drifted");
    if (contractSha256 !== null && scorecard.contractSha256 !== contractSha256) fail("contract hash differs from the committed contract bytes");
    if (contractSha256 === null && scorecard.contractSha256 !== undefined && !HASH.test(scorecard.contractSha256)) fail("contract hash is invalid");
  }
  if (!scorecard.powerPointQuiescence || !Array.isArray(scorecard.powerPointQuiescence.initial) || scorecard.powerPointQuiescence.initial.length !== 0
    || !Array.isArray(scorecard.powerPointQuiescence.postProducers) || scorecard.powerPointQuiescence.postProducers.length !== 0
    || !Array.isArray(scorecard.powerPointQuiescence.final) || scorecard.powerPointQuiescence.final.length !== 0
    || canonicalHash(scorecard.powerPointQuiescence.perFixture) !== canonicalHash(fixtureIds)) fail("global PowerPoint quiescence proof is incomplete");
  if (requireRelease) {
    if (scorecard.valid !== true || scorecard.releaseEvidence !== true || scorecard.developmentFunctionalValid !== true || scorecard.reusedProducerOutputs !== false) fail("release validity is false");
    if (!scorecard.git?.before?.clean || !scorecard.git?.after?.clean || !scorecard.git?.sameCommit || scorecard.git.before.commit !== scorecard.git.after.commit || !/^[0-9a-f]{40}$/u.test(scorecard.git.before.commit ?? "")) fail("clean exact-commit provenance is absent");
  }
  return true;
}

export async function verifyRepairFreeFixtureDirectory(directory, summary, { expectedId = summary?.id } = {}) {
  if (!SAFE_ID.test(expectedId ?? "") || summary?.id !== expectedId) fail("fixture summary identity is invalid");
  for (const report of POSITIVE_REPORTS) await regularFile(directory, report, `${expectedId}/${report}`);
  const readyMarker = await regularFile(directory, "watcher-ready.marker", `${expectedId}/watcher-ready.marker`);
  const armedMarker = await regularFile(directory, "watcher-armed.marker", `${expectedId}/watcher-armed.marker`);
  const [source, roundtrip] = await Promise.all([regularFile(directory, "source.pptx"), regularFile(directory, "roundtrip.pptx")]);
  const [sourceHash, roundtripHash, sourceOpc, sourceOpenXml, sourceInventory, powerpoint, ownership, watcher, roundtripOpc, roundtripOpenXml, roundtripInventory] = await Promise.all([
    sha256File(source.absolute), sha256File(roundtrip.absolute),
    jsonFile(directory, "source-opc.json"), jsonFile(directory, "source-openxml.json"), jsonFile(directory, "source-inventory.json"),
    jsonFile(directory, "powerpoint.json"), jsonFile(directory, "ownership.json"), jsonFile(directory, "window-watch.json"),
    jsonFile(directory, "roundtrip-opc.json"), jsonFile(directory, "roundtrip-openxml.json"), jsonFile(directory, "roundtrip-inventory.json"),
  ]);
  if (!sourceOpc.valid || sourceOpenXml.valid !== true || sourceOpenXml.errorCount !== 0 || sourceOpenXml.inputSha256 !== sourceHash) fail(`fixture '${expectedId}' source package audit failed`);
  if (!sourceInventory.valid || sourceInventory.inputSha256 !== sourceHash || !HASH.test(sourceInventory.inventorySha256 ?? "")) fail(`fixture '${expectedId}' source semantic inventory failed`);
  if (!roundtripOpc.valid || roundtripOpenXml.valid !== true || roundtripOpenXml.errorCount !== 0 || roundtripOpenXml.inputSha256 !== roundtripHash) fail(`fixture '${expectedId}' roundtrip package audit failed`);
  if (!roundtripInventory.valid || roundtripInventory.inputSha256 !== roundtripHash || roundtripInventory.inventorySha256 !== sourceInventory.inventorySha256) fail(`fixture '${expectedId}' semantic inventory changed`);
  const sameLiveState = canonicalHash(powerpoint.before) === canonicalHash(powerpoint.after);
  if (powerpoint.schemaVersion !== "slidewright-repair-free-powerpoint/v1" || powerpoint.fixtureId !== expectedId || powerpoint.valid !== true || powerpoint.alertsEnabled !== true
    || powerpoint.hiddenThroughoutWorkerChecks !== true || powerpoint.sourceUnchanged !== true || powerpoint.serializedToDistinctPackage !== true || powerpoint.exactLiveSemanticStatePreserved !== true
    || powerpoint.sourceSha256 !== sourceHash || powerpoint.outputSha256 !== roundtripHash || !sameLiveState) fail(`fixture '${expectedId}' PowerPoint state proof failed`);
  if (ownership.schemaVersion !== "slidewright-owned-powerpoint/v1" || ownership.processName !== "POWERPNT" || ownership.purpose !== `repair-free-${expectedId}` || ownership.expectedApplicationVisible !== false
    || ownership.version !== powerpoint.version || ownership.build !== powerpoint.build || ownership.executableSha256 !== powerpoint.executableSha256 || !HASH.test(ownership.executableSha256 ?? "")) fail(`fixture '${expectedId}' ownership record is invalid`);
  const watcherStarted = Date.parse(watcher.startedAt);
  const ownershipStarted = Date.parse(ownership.processStartTime);
  const ownershipObservedAt = Date.parse(watcher.ownershipObservedAt);
  const armedAt = Date.parse((await fs.readFile(armedMarker.absolute, "utf8")).replace(/^\uFEFF/u, "").trim());
  const sourceOpenedAt = Date.parse(powerpoint.sourceOpenedAt);
  const watcherFinished = Date.parse(watcher.finishedAt);
  const readyAt = Date.parse((await fs.readFile(readyMarker.absolute, "utf8")).replace(/^\uFEFF/u, "").trim());
  if (watcher.schemaVersion !== "slidewright-powerpoint-window-watch/v1" || watcher.valid !== true || watcher.timedOut !== false || watcher.identityDrift !== false || watcher.ownedProcessExited !== true || watcher.eventLogQuerySucceeded !== true || watcher.eventLogError !== null
    || !Array.isArray(watcher.unexpectedVisibleWindows) || watcher.unexpectedVisibleWindows.length !== 0 || !Array.isArray(watcher.repairSignals) || watcher.repairSignals.length !== 0
    || !Number.isFinite(readyAt) || readyAt !== watcherStarted || !Number.isFinite(watcherStarted) || !Number.isFinite(ownershipStarted) || !Number.isFinite(ownershipObservedAt)
    || !Number.isFinite(armedAt) || !Number.isFinite(sourceOpenedAt) || !Number.isFinite(watcherFinished)
    || watcherStarted > ownershipStarted || ownershipObservedAt < ownershipStarted || armedAt < ownershipObservedAt || sourceOpenedAt < armedAt || watcherFinished < sourceOpenedAt
    || watcher.armedAt !== powerpoint.armedAt || Date.parse(watcher.armedAt) !== armedAt
    || watcher.processId !== ownership.processId || watcher.processId !== powerpoint.processId || watcher.processStartTime !== ownership.processStartTime || watcher.processStartTime !== powerpoint.processStartTime) fail(`fixture '${expectedId}' window/process proof failed`);
  const derived = {
    sourceSha256: sourceHash,
    roundtripSha256: roundtripHash,
    inventorySha256: sourceInventory.inventorySha256,
    sourceUnchanged: true,
    semanticInventoryPreserved: true,
    sourceOpcValid: true,
    sourceOpenXmlErrors: 0,
    powerpointValid: true,
    alertsEnabled: true,
    liveStatePreserved: true,
    visibleWindowCount: 0,
    repairSignalCount: 0,
    ownedProcessExited: true,
    roundtripOpcValid: true,
    roundtripOpenXmlErrors: 0,
    powerpointVersion: powerpoint.version,
    powerpointBuild: powerpoint.build,
    powerpointExecutableSha256: powerpoint.executableSha256,
  };
  for (const [key, value] of Object.entries(derived)) if (summary[key] !== value) fail(`fixture '${expectedId}' summary field '${key}' drifted`);
  return derived;
}

async function verifyNegativeControls(runDirectory, scorecard) {
  const directory = path.join(runDirectory, "negative-controls");
  const repairControl = scorecard.negativeControls.find((item) => item.id === "powerpoint-repair-dialog");
  const repairDirectory = path.join(directory, "powerpoint-repair-dialog");
  const [repairWatcher, repairOwnership] = await Promise.all([
    jsonFile(repairDirectory, "window-watch.json"),
    jsonFile(repairDirectory, "ownership.json"),
  ]);
  const repairReady = Date.parse((await fs.readFile((await regularFile(repairDirectory, "watcher-ready.marker")).absolute, "utf8")).replace(/^\uFEFF/u, "").trim());
  const repairArmed = Date.parse((await fs.readFile((await regularFile(repairDirectory, "watcher-armed.marker")).absolute, "utf8")).replace(/^\uFEFF/u, "").trim());
  const repairOwnershipStarted = Date.parse(repairOwnership.processStartTime);
  const repairRoundtrip = await fs.lstat(path.join(repairDirectory, "roundtrip.pptx")).catch(() => null);
  const repairWorkerReport = await fs.lstat(path.join(repairDirectory, "powerpoint.json")).catch(() => null);
  if (repairControl?.gate !== "real-powerpoint-watcher" || repairControl.rejected !== true || repairControl.workerTimedOut !== true || repairControl.watcherExitCode !== 2
    || repairControl.cleanupValid !== true || repairControl.cleanupPerformed !== true || repairWatcher.schemaVersion !== "slidewright-powerpoint-window-watch/v1"
    || repairWatcher.valid !== false || repairWatcher.ownedProcessExited !== true || ((repairWatcher.unexpectedVisibleWindows?.length ?? 0) + (repairWatcher.repairSignals?.length ?? 0)) < 1
    || repairControl.visibleWindowCount !== repairWatcher.unexpectedVisibleWindows.length || repairControl.repairSignalCount !== repairWatcher.repairSignals.length
    || !Number.isFinite(repairReady) || !Number.isFinite(repairArmed) || !Number.isFinite(repairOwnershipStarted) || repairReady > repairOwnershipStarted || repairArmed < repairOwnershipStarted
    || repairRoundtrip !== null || repairWorkerReport !== null) fail("real PowerPoint repair-dialog control was not safely rejected without a published output");
  for (const [id, code] of Object.entries(OPC_CONTROL_CODES)) {
    const report = await jsonFile(directory, `${id}-opc.json`);
    const control = scorecard.negativeControls.find((item) => item.id === id);
    const codes = (report.failures ?? []).map((item) => item.code ?? item);
    if (report.valid !== false || !codes.includes(code) || control.gate !== "opc" || !control.failures?.includes(code)) fail(`negative control '${id}' did not reach intended OPC failure ${code}`);
  }
  const schema = await jsonFile(directory, "openxml-schema-invalid-sdk.json");
  const schemaOpc = await jsonFile(directory, "openxml-schema-invalid-opc.json");
  const schemaControl = scorecard.negativeControls.find((item) => item.id === "openxml-schema-invalid");
  if (schemaOpc.valid !== true || schema.valid !== false || schema.errorCount !== 1 || schema.errors?.[0]?.id !== "Sch_InvalidElementContentExpectingComplex" || schema.errors?.[0]?.partUri !== "/ppt/slides/slide1.xml" || schemaControl.gate !== "openxml-sdk" || schemaControl.errorCount !== schema.errorCount) fail("Open XML schema control is not bound to the intended SDK rejection");
  const [baseline, removed, removedOpc, removedSdk] = await Promise.all([
    jsonFile(directory, "baseline-inventory.json"), jsonFile(directory, "removed-content-inventory.json"),
    jsonFile(directory, "removed-content-opc.json"), jsonFile(directory, "removed-content-sdk.json"),
  ]);
  const removedControl = scorecard.negativeControls.find((item) => item.id === "removed-content");
  if (removedOpc.valid !== true || removedSdk.valid !== true || removedSdk.errorCount !== 0 || baseline.inventorySha256 === removed.inventorySha256 || removedControl.gate !== "semantic-inventory" || removedControl.baseline !== baseline.inventorySha256 || removedControl.mutant !== removed.inventorySha256) fail("removed-content control did not prove semantic-only rejection");
  for (const id of ["removed-chart-label", "removed-diagram-label", "removed-hyperlink-target"]) {
    const [semanticBaseline, semanticMutant, semanticOpc, semanticSdk] = await Promise.all([
      jsonFile(directory, `${id}-baseline-inventory.json`),
      jsonFile(directory, `${id}-inventory.json`),
      jsonFile(directory, `${id}-opc.json`),
      jsonFile(directory, `${id}-sdk.json`),
    ]);
    const control = scorecard.negativeControls.find((item) => item.id === id);
    if (semanticOpc.valid !== true || semanticSdk.valid !== true || semanticSdk.errorCount !== 0 || semanticBaseline.inventorySha256 === semanticMutant.inventorySha256
      || control?.gate !== "semantic-inventory" || control.baseline !== semanticBaseline.inventorySha256 || control.mutant !== semanticMutant.inventorySha256) fail(`semantic loss control '${id}' did not reach its intended inventory-only rejection`);
  }
  const watcherControl = scorecard.negativeControls.find((item) => item.id === "watcher-evidence-tamper");
  const watcherReport = await jsonFile(directory, "watcher-evidence-tamper.json");
  const expectedWatcherCases = ["missing-watcher", "unexpected-visible-window", "repair-signal", "watcher-timeout", "identity-drift", "owned-process-survived", "event-log-query-absent", "pid-mismatch", "watcher-start-after-ownership", "watcher-finish-before-ownership", "alerts-disabled", "source-hash-mismatch", "output-hash-mismatch"];
  if (watcherControl.gate !== "fixture-evidence-verifier" || watcherReport.rejected !== true || watcherReport.mutation !== "hostile-watcher-and-worker-matrix" || canonicalHash(watcherReport.cases?.map((item) => item.id)) !== canonicalHash(expectedWatcherCases) || watcherReport.cases.some((item) => item.rejected !== true || typeof item.error !== "string")) fail("watcher tamper control is synthetic or incomplete");
  const baselineSummary = scorecard.fixtures[0];
  for (const item of watcherReport.cases) {
    let rejected = false;
    try { await verifyRepairFreeFixtureDirectory(path.join(directory, "watcher-evidence-tamper", item.id), baselineSummary, { expectedId: baselineSummary.id }); } catch { rejected = true; }
    if (!rejected) fail(`watcher tamper case '${item.id}' passed the production verifier`);
  }
}

function verifyCommandReceipts(receipts, contract, { reusedProducerOutputs = false } = {}) {
  const producers = ["setup:runtime", "fidelity", "copy-resilience", "semantic-mutation", "template", "design-profile", "feedback-contract", "ingestion", "prompt-robustness", "demo", "semantic-surface"];
  const expected = ["git-commit", "git-status", "git-commit", "git-status", "powerpoint-quiescence-initial", "powerpoint-quiescence-post-producers", "powerpoint-quiescence-final", "powerpoint-quiescence-pre-control-repair-dialog", "powerpoint-control-repair-dialog", "powerpoint-quiescence-post-control-repair-dialog", "producer-in-run-design", ...(!reusedProducerOutputs ? producers.map((id) => `producer-${id}`) : [])];
  for (const fixture of contract.fixtures) expected.push(
    `opc-source-${fixture.id}`, `openxml-source-${fixture.id}`, `inventory-source-${fixture.id}`, `powerpoint-quiescence-pre-${fixture.id}`, `powerpoint-${fixture.id}`, `powerpoint-quiescence-post-${fixture.id}`,
    `opc-roundtrip-${fixture.id}`, `openxml-roundtrip-${fixture.id}`, `inventory-roundtrip-${fixture.id}`,
  );
  expected.push("negative-generate");
  for (const id of Object.keys(OPC_CONTROL_CODES)) expected.push(`negative-opc-${id}`);
  expected.push("negative-schema-opc", "negative-schema-sdk", "negative-baseline-inventory", "negative-removed-opc", "negative-removed-sdk", "negative-removed-inventory");
  for (const id of ["removed-chart-label", "removed-diagram-label", "removed-hyperlink-target"]) {
    expected.push(`negative-${id}-baseline-inventory`, `negative-${id}-opc`, `negative-${id}-sdk`, `negative-${id}-inventory`);
  }
  if (canonicalHash(receipts.map((item) => item.id).sort()) !== canonicalHash(expected.sort())) fail("command receipt set is incomplete or contains additions");
  for (const item of receipts) {
    if (item.id === "powerpoint-control-repair-dialog") {
      const logicalRoot = "$RUN/negative-controls/powerpoint-repair-dialog";
      const expectedWorker = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$IMPLEMENTATION/powerpoint_repair_free_roundtrip.ps1", "-FixtureId", "control-repair-dialog", "-InputPptx", `${logicalRoot}/source.pptx`, "-OutputPptx", `${logicalRoot}/roundtrip.pptx`, "-ReportJson", `${logicalRoot}/powerpoint.json`, "-OwnershipRecordJson", `${logicalRoot}/ownership.json`, "-ArmedMarker", `${logicalRoot}/watcher-armed.marker`, "-StopMarker", `${logicalRoot}/stop.marker`];
      const expectedWatcher = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$IMPLEMENTATION/watch_powerpoint_windows.ps1", "-OwnershipRecordJson", `${logicalRoot}/ownership.json`, "-StopMarker", `${logicalRoot}/stop.marker`, "-ReadyMarker", `${logicalRoot}/watcher-ready.marker`, "-ArmedMarker", `${logicalRoot}/watcher-armed.marker`, "-ReportJson", `${logicalRoot}/window-watch.json`, "-TimeoutSeconds", "150"];
      if (item.command !== "powershell" || item.exitCode !== null || item.signal !== "worker-timeout" || item.timedOut !== true || item.workerTimeoutMs !== 20_000
        || item.watcher?.exitCode !== 2 || item.watcher?.signal !== null || item.repairControl?.rejected !== true || item.ownershipCleanup?.valid !== true || item.ownershipCleanup?.cleaned !== true
        || item.quiescence?.before?.length !== 0 || item.quiescence?.after?.length !== 0
        || canonicalHash(item.normalizedArgs) !== canonicalHash(expectedWorker) || canonicalHash(item.watcher.normalizedArgs) !== canonicalHash(expectedWatcher)
        || !Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.finishedAt)) || Date.parse(item.finishedAt) < Date.parse(item.startedAt)) fail("real PowerPoint repair control receipt is incomplete");
      continue;
    }
    const intendedNonzero = item.id?.startsWith("negative-opc-") ? 1 : item.id === "negative-schema-sdk" ? 2 : 0;
    if (item.exitCode !== intendedNonzero || item.signal !== null || item.timedOut !== false || !Number.isFinite(Date.parse(item.startedAt)) || !Number.isFinite(Date.parse(item.finishedAt)) || Date.parse(item.finishedAt) < Date.parse(item.startedAt)) fail(`command receipt '${item.id}' has invalid execution state`);
    if (item.id?.startsWith("producer-") && item.id !== "producer-in-run-design" && (item.command !== "npm.cmd" || canonicalHash(item.args) !== canonicalHash(["run", item.id.slice("producer-".length)]))) fail(`producer receipt '${item.id}' argv drifted`);
    if (item.id === "producer-in-run-design" && (item.command !== "internal" || item.args?.[0] !== "generateFidelityFixtures")) fail("in-run design producer receipt drifted");
    if (item.id?.startsWith("powerpoint-quiescence-") && (item.command !== "powershell" || canonicalHash(item.args?.slice(0, 2)) !== canonicalHash(["-NoProfile", "-Command"]) || item.streams?.length !== 2)) fail(`PowerPoint quiescence receipt '${item.id}' is incomplete`);
    if (item.id?.startsWith("powerpoint-") && !item.id.startsWith("powerpoint-quiescence-")) {
      const fixtureId = item.id.slice("powerpoint-".length);
      const logicalRoot = `$RUN/fixtures/${fixtureId}`;
      const expectedWorker = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$IMPLEMENTATION/powerpoint_repair_free_roundtrip.ps1", "-FixtureId", fixtureId, "-InputPptx", `${logicalRoot}/source.pptx`, "-OutputPptx", `${logicalRoot}/roundtrip.pptx`, "-ReportJson", `${logicalRoot}/powerpoint.json`, "-OwnershipRecordJson", `${logicalRoot}/ownership.json`, "-ArmedMarker", `${logicalRoot}/watcher-armed.marker`, "-StopMarker", `${logicalRoot}/stop.marker`];
      const expectedWatcher = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$IMPLEMENTATION/watch_powerpoint_windows.ps1", "-OwnershipRecordJson", `${logicalRoot}/ownership.json`, "-StopMarker", `${logicalRoot}/stop.marker`, "-ReadyMarker", `${logicalRoot}/watcher-ready.marker`, "-ArmedMarker", `${logicalRoot}/watcher-armed.marker`, "-ReportJson", `${logicalRoot}/window-watch.json`, "-TimeoutSeconds", "150"];
      if (item.command !== "powershell" || item.watcher?.exitCode !== 0 || item.watcher?.signal !== null || item.streams?.length !== 4
        || !Number.isInteger(item.workerIdentity?.processId) || typeof item.workerIdentity?.processStartTime !== "string" || !Number.isInteger(item.watcher?.identity?.processId) || typeof item.watcher?.identity?.processStartTime !== "string"
        || !Number.isFinite(Date.parse(item.workerStartedAt)) || Date.parse(item.workerStartedAt) < Date.parse(item.startedAt) || Date.parse(item.workerStartedAt) > Date.parse(item.finishedAt)
        || item.quiescence?.before?.length !== 0 || item.quiescence?.after?.length !== 0
        || canonicalHash(item.normalizedArgs) !== canonicalHash(expectedWorker) || canonicalHash(item.watcher.normalizedArgs) !== canonicalHash(expectedWatcher)) fail(`PowerPoint receipt '${item.id}' is incomplete`);
    }
  }
}

function expectedProducerReceipt(fixture) {
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
  fail(`fixture '${fixture.id}' has no producer binding`);
}

function runIndependent(command, args, expected, label) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== expected) fail(`${label} independent rerun failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
}

async function rederiveFixturePackages({ root, runDirectory, fixture, assemblyPath, scriptsRoot, scratchRoot }) {
  const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
  const python = process.env.SLIDEWRIGHT_PYTHON || await fs.access(bundledPython).then(() => bundledPython, () => "python");
  const fixtureRoot = path.join(runDirectory, "fixtures", fixture.id);
  const scratch = path.join(scratchRoot, fixture.id);
  await fs.mkdir(scratch, { recursive: true });
  for (const kind of ["source", "roundtrip"]) {
    const pptx = path.join(fixtureRoot, `${kind}.pptx`);
    const opcPath = path.join(scratch, `${kind}-opc.json`);
    const sdkPath = path.join(scratch, `${kind}-openxml.json`);
    const inventoryPath = path.join(scratch, `${kind}-inventory.json`);
    runIndependent(python, [path.join(scriptsRoot, "audit_opc_package.py"), pptx, "--json", opcPath], 0, `${fixture.id}/${kind} OPC`);
    runIndependent("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptsRoot, "validate_openxml.ps1"), "-InputPptx", pptx, "-AssemblyPath", assemblyPath, "-ReportJson", sdkPath], 0, `${fixture.id}/${kind} Open XML`);
    runIndependent(python, [path.join(scriptsRoot, "semantic_inventory.py"), pptx, "--json", inventoryPath], 0, `${fixture.id}/${kind} semantic inventory`);
    const [opc, sdk, inventory, actualHash] = await Promise.all([
      JSON.parse((await fs.readFile(opcPath, "utf8")).replace(/^\uFEFF/u, "")),
      JSON.parse((await fs.readFile(sdkPath, "utf8")).replace(/^\uFEFF/u, "")),
      JSON.parse((await fs.readFile(inventoryPath, "utf8")).replace(/^\uFEFF/u, "")),
      sha256File(pptx),
    ]);
    const expectedHash = kind === "source" ? fixture.sourceSha256 : fixture.roundtripSha256;
    if (opc.valid !== true || opc.file?.sha256 !== actualHash || sdk.valid !== true || sdk.errorCount !== 0 || sdk.inputSha256 !== actualHash || inventory.valid !== true || inventory.inputSha256 !== actualHash || actualHash !== expectedHash || inventory.inventorySha256 !== fixture.inventorySha256) {
      fail(`fixture '${fixture.id}' ${kind} failed independent package re-derivation`);
    }
  }
}

export async function verifyRepairFreeEvidence({ root, runDirectory, requireCurrentGit = true, requireRelease = true, rederive = true }) {
  const scorecard = await jsonFile(runDirectory, "scorecard.json");
  const contractPath = path.join(root, "fixtures", "repair-free", "v1", "fixture-contract.json");
  const contract = JSON.parse((await fs.readFile(contractPath, "utf8")).replace(/^\uFEFF/u, ""));
  const contractSha256 = await sha256File(contractPath);
  verifyRepairFreeScorecard(scorecard, { requireRelease, contract, contractSha256 });
  const tree = await collectRepairFreeEvidenceTree(runDirectory);
  if (canonicalHash(tree) !== canonicalHash(scorecard.evidence)) fail("raw evidence file inventory or bytes drifted");
  const snapshot = [];
  for (const item of scorecard.implementation.files) {
    const record = await fileRecord(runDirectory, item.snapshot);
    if (record.bytes !== item.bytes || record.sha256 !== item.sha256) fail(`implementation snapshot drifted at ${item.path}`);
    snapshot.push(item);
  }
  if (canonicalHash(snapshot) !== canonicalHash(scorecard.implementation.files) || canonicalHash(scorecard.implementation.files) !== scorecard.implementation.treeSha256) fail("implementation closure hash drifted");
  if (requireCurrentGit) {
    const current = await captureRepairFreeImplementation(root);
    if (canonicalHash(current) !== canonicalHash(scorecard.implementation)) fail("current implementation differs from the proven closure");
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
    const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", windowsHide: true });
    if (commit.status !== 0 || status.status !== 0 || commit.stdout.trim() !== scorecard.git.before.commit || status.stdout.trim() !== "") fail("current Git state differs from the clean proven commit");
  }
  for (const item of scorecard.environment.artifactTool.files) {
    const record = await fileRecord(runDirectory, item.snapshot);
    if (record.bytes !== item.bytes || record.sha256 !== item.sha256) fail(`artifact-tool runtime snapshot drifted at ${item.path}`);
  }
  if (canonicalHash(scorecard.environment.artifactTool.files) !== scorecard.environment.artifactTool.treeSha256) fail("artifact-tool runtime tree hash drifted");
  if (requireCurrentGit) {
    const liveArtifactTool = await captureArtifactToolRuntime(root);
    if (canonicalHash(liveArtifactTool) !== canonicalHash(scorecard.environment.artifactTool)) fail("current artifact-tool runtime differs from the proven runtime");
  }
  const runtimePackage = await fileRecord(runDirectory, scorecard.openXmlRuntime.packagePath);
  const runtimeAssembly = await fileRecord(runDirectory, scorecard.openXmlRuntime.assemblyPath);
  if (runtimePackage.sha256 !== contract.openXml.sha256 || runtimeAssembly.sha256 !== contract.openXml.assemblySha256) fail("pinned Open XML package or assembly bytes drifted");
  const commandLog = await jsonFile(runDirectory, "command-log.json");
  if (!Array.isArray(commandLog) || commandLog.length !== scorecard.receipts.length || canonicalHash(commandLog) !== canonicalHash(scorecard.receipts)) fail("command receipt log drifted");
  verifyCommandReceipts(commandLog, contract, { reusedProducerOutputs: scorecard.reusedProducerOutputs });
  const benchmarkStartedMs = Date.parse(scorecard.benchmark?.startedAt);
  if (!Number.isFinite(benchmarkStartedMs)) fail("benchmark start time is invalid");
  const scriptsRoot = requireCurrentGit
    ? path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "repair_free")
    : path.join(runDirectory, "implementation", "plugins", "slidewright", "skills", "slidewright", "scripts", "repair_free");
  const scratchRoot = rederive ? await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c04-verify-")) : null;
  try {
    for (const [index, fixture] of scorecard.fixtures.entries()) {
      const expected = contract.fixtures[index];
      if (fixture.id !== expected.id || fixture.category !== expected.category) fail(`fixture '${fixture.id}' differs from its contract position`);
      if (fixture.source !== `fixtures/${fixture.id}/source.pptx` || fixture.roundtrip !== `fixtures/${fixture.id}/roundtrip.pptx` || fixture.sourceScope !== "run" || typeof fixture.originPath !== "string" || fixture.originPath.includes("..")) fail(`fixture '${fixture.id}' source binding is unsafe`);
      const expectedProducer = expectedProducerReceipt(expected);
      const producer = commandLog.find((item) => item.id === expectedProducer);
      if (fixture.producerReceiptId !== expectedProducer || !producer) fail(`fixture '${fixture.id}' producer binding is missing`);
      const producerStartedMs = Date.parse(producer.startedAt);
      const producerFinishedMs = Date.parse(producer.finishedAt);
      let originMtimeMs = fixture.originMtimeMs;
      if (fixture.originScope === "run" || (fixture.originScope === "workspace" && requireCurrentGit)) {
        const originRoot = fixture.originScope === "run" ? runDirectory : root;
        const origin = await regularFile(originRoot, fixture.originPath, `${fixture.id} origin`);
        originMtimeMs = origin.stat.mtimeMs;
        if (await sha256File(origin.absolute) !== fixture.sourceSha256) fail(`fixture '${fixture.id}' origin bytes differ from its snapshot`);
      } else if (fixture.originScope !== "workspace") fail(`fixture '${fixture.id}' origin scope is invalid`);
      const derivedFresh = !scorecard.reusedProducerOutputs && producer.exitCode === 0 && producer.timedOut === false
        && Number.isFinite(producerStartedMs) && Number.isFinite(producerFinishedMs) && producerStartedMs >= benchmarkStartedMs - 2_000
        && originMtimeMs === fixture.originMtimeMs && originMtimeMs >= benchmarkStartedMs - 2_000 && originMtimeMs >= producerStartedMs - 2_000 && originMtimeMs <= producerFinishedMs + 2_000;
      if (fixture.sourceFresh !== derivedFresh || (requireRelease && !derivedFresh)) fail(`fixture '${fixture.id}' source freshness was not independently proven`);
      await verifyRepairFreeFixtureDirectory(path.join(runDirectory, "fixtures", fixture.id), fixture, { expectedId: expected.id });
      if (rederive) await rederiveFixturePackages({ root, runDirectory, fixture, assemblyPath: path.join(runDirectory, ...scorecard.openXmlRuntime.assemblyPath.split("/")), scriptsRoot, scratchRoot });
    }
  } finally {
    if (scratchRoot) await fs.rm(scratchRoot, { recursive: true, force: true });
  }
  await verifyNegativeControls(runDirectory, scorecard);
  for (const receipt of commandLog) {
    for (const stream of receipt.streams ?? []) {
      const record = await fileRecord(runDirectory, stream.path);
      if (record.bytes !== stream.bytes || record.sha256 !== stream.sha256) fail(`raw command stream drifted at ${stream.path}`);
    }
    if (!Array.isArray(receipt.streams) || receipt.streams.length < 2) fail(`command receipt '${receipt.id}' lacks raw stdout/stderr`);
  }
  return scorecard;
}
