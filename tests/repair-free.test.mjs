import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REPAIR_FREE_CONTROL_IDS, REPAIR_FREE_IMPLEMENTATION_PATHS, collectRepairFreeEvidenceTree, repairFreeScorecardHash, verifyRepairFreeScorecard } from "../scripts/lib/repair-free-evidence.mjs";

const contract = JSON.parse(await fs.readFile(new URL("../fixtures/repair-free/v1/fixture-contract.json", import.meta.url), "utf8"));
const worker = await fs.readFile(new URL("../plugins/slidewright/skills/slidewright/scripts/repair_free/powerpoint_repair_free_roundtrip.ps1", import.meta.url), "utf8");
const watcher = await fs.readFile(new URL("../plugins/slidewright/skills/slidewright/scripts/repair_free/watch_powerpoint_windows.ps1", import.meta.url), "utf8");
const orchestrator = await fs.readFile(new URL("../scripts/run-repair-free-benchmark.mjs", import.meta.url), "utf8");
const inventory = await fs.readFile(new URL("../plugins/slidewright/skills/slidewright/scripts/repair_free/semantic_inventory.py", import.meta.url), "utf8");
const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));

test("C04 contract freezes 26 unique release fixtures and every category quota", () => {
  assert.equal(contract.schemaVersion, "slidewright-repair-free-contract/v1");
  assert.equal(contract.minimumFixtureCount, 26);
  assert.equal(contract.fixtures.length, 26);
  assert.equal(new Set(contract.fixtures.map((item) => item.id)).size, 26);
  assert.equal(new Set(contract.fixtures.map((item) => `${item.resolver}:${item.pointer ?? ""}:${item.value}`)).size, 26);
  for (const [category, minimum] of Object.entries(contract.categoryQuotas)) {
    assert.ok(contract.fixtures.filter((item) => item.category === category).length >= minimum, category);
  }
});

test("C04 pins the official Open XML SDK package by version and SHA-256", () => {
  assert.deepEqual(contract.openXml, {
    package: "DocumentFormat.OpenXml",
    version: "2.20.0",
    targetFramework: "net46",
    url: "https://api.nuget.org/v3-flatcontainer/documentformat.openxml/2.20.0/documentformat.openxml.2.20.0.nupkg",
    sha256: "053312e1a2a606dcc5bcfcff6cc9f37235a1f43b3745ac907283d3122ce9f768",
    assemblySha256: "379dfb830452b1b7476f1cd3f21423d9f99cf0c84bbf70b1611ba5e53d320f4b",
  });
});

test("C04 PowerPoint worker is isolated, alert-visible, SaveAs/reopen, and state preserving", () => {
  const existingGuard = worker.indexOf("Get-Process POWERPNT");
  const comCreation = worker.indexOf("New-Object -ComObject PowerPoint.Application");
  assert.ok(existingGuard >= 0 && existingGuard < comCreation);
  assert.match(worker, /\$application\.DisplayAlerts = 2/u);
  assert.match(worker, /CommandLine -notmatch '[^']*\\s\)\/AUTOMATION/u);
  assert.match(worker, /Presentations\.Open\(\$inputPath/u);
  assert.ok(worker.indexOf("Set-Content -Encoding UTF8 -LiteralPath $ownershipPath") < worker.indexOf("while (-not (Test-Path -LiteralPath $armedPath)"));
  assert.ok(worker.indexOf("while (-not (Test-Path -LiteralPath $armedPath)") < worker.indexOf("Presentations.Open($inputPath"));
  assert.match(worker, /SaveAs\(\$outputPath, 24\)/u);
  assert.match(worker, /Presentations\.Open\(\$outputPath/u);
  assert.match(worker, /exactLiveSemanticStatePreserved = \$statePreserved/u);
  assert.match(worker, /sourceUnchanged = \$sourceHashBefore -eq \$sourceHashAfter/u);
  assert.doesNotMatch(worker, /Stop-Process\s+(?:-Name\s+)?POWERPNT|taskkill[^\r\n]*POWERPNT/iu);
});

test("C04 watcher binds modal evidence to the exact owned PowerPoint identity", () => {
  assert.match(watcher, /processId = \$ownedPid/u);
  assert.match(watcher, /processStartTime = \$ownedStart/u);
  assert.match(watcher, /GetWindowThreadProcessId/u);
  assert.match(watcher, /IsWindowVisible/u);
  assert.match(watcher, /unexpectedVisibleWindows = \$visible/u);
  assert.match(watcher, /repairSignals = \$signals/u);
  assert.match(watcher, /eventLogQuerySucceeded = \$eventLogQuerySucceeded/u);
  assert.match(watcher, /Set-Content -Encoding UTF8 -LiteralPath \$readyPath/u);
  assert.match(watcher, /Set-Content -Encoding UTF8 -LiteralPath \$armedPath/u);
  assert.ok(watcher.indexOf("Get-Process -Id $ownedPid") < watcher.indexOf("Set-Content -Encoding UTF8 -LiteralPath $armedPath"));
  assert.match(watcher, /repair\|removed content\|unreadable\|damaged\|corrupt/u);
});

test("C04 orchestrator requires pre/post OPC, schema, semantic, and real PowerPoint proof", () => {
  for (const evidence of [
    "source-opc.json", "source-openxml.json", "source-inventory.json", "powerpoint.json",
    "window-watch.json", "roundtrip-opc.json", "roundtrip-openxml.json", "roundtrip-inventory.json",
  ]) assert.match(orchestrator, new RegExp(evidence.replaceAll(".", "\\."), "u"));
  assert.match(orchestrator, /uniqueFixtureHashes/u);
  assert.match(orchestrator, /semanticInventoryPreserved/u);
  assert.match(orchestrator, /sourceOpenXmlErrors/u);
  assert.match(orchestrator, /roundtripOpenXmlErrors/u);
  assert.match(orchestrator, /cleanupOwnedPowerPoint/u);
  assert.match(orchestrator, /gitBefore\.clean && gitAfter\.clean/u);
  assert.match(orchestrator, /powerpoint-control-repair-dialog/u);
  assert.match(orchestrator, /powerpoint-quiescence-final/u);
  assert.ok(orchestrator.indexOf("fsSync.existsSync(watcherReady)") < orchestrator.indexOf('spawn("powershell", workerArgs'));
});

test("C04 release mode regenerates producers and cannot reuse development outputs", () => {
  assert.equal(packageJson.scripts["repair-free"], "node scripts/run-repair-free-benchmark.mjs");
  assert.match(packageJson.scripts["repair-free:reuse"], /--allow-dirty --reuse-release-outputs/u);
  assert.match(packageJson.scripts["release:check"], /npm run repair-free && npm run repair-free:verify/u);
  assert.doesNotMatch(packageJson.scripts["release:check"], /repair-free:reuse/u);
  assert.match(orchestrator, /const sourceFresh = !reuseReleaseOutputs && producer\?\.exitCode === 0 && producer\?\.timedOut === false/u);
  assert.match(orchestrator, /origin\.stat\.mtimeMs >= benchmarkStartedAtMs - 2_000/u);
  assert.match(orchestrator, /origin\.stat\.mtimeMs <= producerFinishedMs \+ 2_000/u);
  assert.match(orchestrator, /const publicationRoot = releaseValid \? outputRoot : path\.join\(outputRoot, "development"\)/u);
  assert.match(orchestrator, /process\.env\.npm_execpath/u);
  assert.match(orchestrator, /run\(process\.execPath, \[npmCli, "run", name\]/u);
  assert.match(orchestrator, /const DEFAULT_COMMAND_TIMEOUT_MS = 600_000/u);
  assert.match(orchestrator, /"semantic-mutation": 1_800_000/u);
  assert.match(orchestrator, /timeoutMs: PRODUCER_TIMEOUT_MS\[name\] \?\? DEFAULT_COMMAND_TIMEOUT_MS/u);
  assert.match(orchestrator, /const receipt = \{ id, command, args, timeoutMs,/u);
});

test("C04 semantic inventory ignores serialization-only normalization but binds user content", () => {
  assert.match(inventory, /"paragraphs": paragraph_text/u);
  assert.doesNotMatch(inventory, /"runCount"/u);
  assert.match(inventory, /"sha256": sha256\(parts\[relation\["target"\]\]\)/u);
  assert.match(inventory, /"table"\] = rows/u);
  assert.match(inventory, /"chart"\] = chart_payload/u);
  assert.match(inventory, /record\["hyperlinks"\] = hyperlinks/u);
  assert.match(inventory, /record\["diagramParts"\] = diagram_parts/u);
  assert.match(inventory, /"dataLabelsPresent"/u);
  assert.match(inventory, /"notes": notes/u);
});

function syntheticScorecard() {
  const fixtures = contract.fixtures.map((item, index) => ({
    id: item.id, category: item.category, valid: true, sourceUnchanged: true,
    sourceFresh: true, originPath: `outputs/source-${index}.pptx`,
    semanticInventoryPreserved: true, sourceOpcValid: true, sourceOpenXmlErrors: 0,
    powerpointValid: true, alertsEnabled: true, liveStatePreserved: true,
    visibleWindowCount: 0, repairSignalCount: 0, ownedProcessExited: true, roundtripOpcValid: true,
    roundtripOpenXmlErrors: 0, sourceSha256: index.toString(16).padStart(64, "0"),
    roundtripSha256: (index + 100).toString(16).padStart(64, "0"),
    inventorySha256: (index + 200).toString(16).padStart(64, "0"),
    powerpointVersion: "16.0", powerpointBuild: "12345", powerpointExecutableSha256: "9".repeat(64),
  }));
  const scorecard = {
    schemaVersion: "slidewright-repair-free-scorecard/v2", valid: true,
    developmentFunctionalValid: true, releaseEvidence: true, fixtureCount: 26,
    reusedProducerOutputs: false,
    minimumFixtureCount: 26, quotasMet: true, uniqueFixturePaths: true,
    uniqueFixtureHashes: true,
    categoryCounts: Object.fromEntries(Object.entries(Object.groupBy(contract.fixtures, (item) => item.category)).map(([key, items]) => [key, items.length])),
    categoryQuotas: contract.categoryQuotas,
    environment: { node: process.version, platform: "win32", arch: "x64", artifactTool: { package: "@oai/artifact-tool", version: "2.8.24", fileCount: 1, treeSha256: "8".repeat(64), files: [{ path: "index.js", bytes: 1, sha256: "7".repeat(64), snapshot: "runtime/artifact-tool/index.js" }] }, powerPoint: { application: "Microsoft PowerPoint", version: "16.0", build: "12345", executableSha256: "9".repeat(64) } },
    openXmlRuntime: { valid: true, package: "DocumentFormat.OpenXml", version: "2.20.0", packageSha256: "b".repeat(64), assemblySha256: "c".repeat(64), packagePath: "runtime/package.nupkg", assemblyPath: "runtime/assembly.dll" },
    implementation: { fileCount: REPAIR_FREE_IMPLEMENTATION_PATHS.length, treeSha256: "d".repeat(64), files: REPAIR_FREE_IMPLEMENTATION_PATHS.map((path) => ({ path })) },
    evidence: { fileCount: 1, treeSha256: "e".repeat(64), files: [{ path: "proof", bytes: 1, sha256: "f".repeat(64) }] },
    powerPointQuiescence: { initial: [], postProducers: [], final: [], perFixture: contract.fixtures.map((item) => item.id) },
    warnings: [], fixtures, negativeControls: REPAIR_FREE_CONTROL_IDS.map((id) => ({ id, rejected: true })),
    git: { before: { clean: true, commit: "a".repeat(40) }, after: { clean: true, commit: "a".repeat(40) }, sameCommit: true },
  };
  scorecard.scorecardHash = repairFreeScorecardHash(scorecard);
  return scorecard;
}

test("C04 evidence verifier rejects missing modal, schema, semantic, uniqueness, and Git proof", () => {
  const valid = syntheticScorecard();
  assert.equal(verifyRepairFreeScorecard(valid), true);
  for (const mutate of [
    (value) => { value.fixtures[0].visibleWindowCount = 1; },
    (value) => { value.fixtures[0].roundtripOpenXmlErrors = 1; },
    (value) => { value.fixtures[0].semanticInventoryPreserved = false; },
    (value) => { value.fixtures[1].sourceSha256 = value.fixtures[0].sourceSha256; },
    (value) => { value.negativeControls[0].rejected = false; },
    (value) => { value.negativeControls.push({ id: "extra-control", rejected: true }); },
    (value) => { value.negativeControls[1].id = value.negativeControls[0].id; },
    (value) => { value.git.after.clean = false; },
  ]) {
    const broken = structuredClone(valid);
    mutate(broken);
    broken.scorecardHash = repairFreeScorecardHash(broken);
    assert.throws(() => verifyRepairFreeScorecard(broken), /C04 evidence invalid/u);
  }
});

test("C04 raw evidence inventory binds additions, byte drift, and non-regular entries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c04-tree-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "nested"));
  await fs.writeFile(path.join(directory, "nested", "proof.json"), "{}\n");
  const first = await collectRepairFreeEvidenceTree(directory);
  await fs.writeFile(path.join(directory, "nested", "proof.json"), "{\"changed\":true}\n");
  const changed = await collectRepairFreeEvidenceTree(directory);
  assert.notEqual(changed.treeSha256, first.treeSha256);
  await fs.writeFile(path.join(directory, "extra.txt"), "extra\n");
  const added = await collectRepairFreeEvidenceTree(directory);
  assert.equal(added.fileCount, first.fileCount + 1);
  try {
    await fs.symlink(path.join(directory, "extra.txt"), path.join(directory, "escape-link"), "file");
    await assert.rejects(collectRepairFreeEvidenceTree(directory), /non-regular entry/u);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
});
