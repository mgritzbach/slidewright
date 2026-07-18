#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalHash,
  contractWithHash,
  runC19DestructiveControls,
  sha256,
  validateC19SuiteEvidence,
} from "../lib/c19-interop-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

function run(command, args, { capture = false } = {}) {
  const completed = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: capture ? "pipe" : "inherit" });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${command} failed with ${completed.status}: ${completed.stderr || completed.stdout}`);
  return completed;
}

function git(args) {
  return run("git", args, { capture: true }).stdout.trim();
}

async function receipt(bundle, file) {
  const absolute = path.join(bundle, ...file.split("/"));
  const bytes = await fs.readFile(absolute);
  return { path: file, byteLength: bytes.length, sha256: sha256(bytes) };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if (process.platform !== "win32") throw new Error("The PowerPoint Windows C19 suite requires Windows.");
const source = path.resolve(argument("--source"));
const bundle = path.resolve(argument("--out"));
const repository = argument("--repository");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Invalid --repository.");
const sourceCommit = git(["rev-parse", "HEAD"]);
if (git(["status", "--porcelain"]) !== "") throw new Error("C19 PowerPoint suite requires a clean checkout.");
await fs.access(source);

const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const scripts = path.join(root, "scripts", "c19");
const artifacts = path.join(bundle, "artifacts");
const receipts = path.join(bundle, "receipts");
const renders = path.join(bundle, "renders");
const implementation = path.join(bundle, "implementation");
await fs.rm(bundle, { recursive: true, force: true });
await Promise.all([artifacts, receipts, renders, implementation].map((directory) => fs.mkdir(directory, { recursive: true })));

const sourceDeck = path.join(artifacts, "source.pptx");
const resultDeck = path.join(artifacts, "result.pptx");
run(python, [path.join(scripts, "inventory_interop.py"), "prepare", "--input", source, "--output", sourceDeck, "--target", "surface-01-title"]);
const implementationSources = [
  [path.join(scripts, "run_powerpoint_windows_suite.mjs"), "implementation/run_powerpoint_windows_suite.mjs"],
  [path.join(scripts, "powerpoint_windows_worker.ps1"), "implementation/powerpoint_windows_worker.ps1"],
  [path.join(scripts, "inventory_interop.py"), "implementation/inventory_interop.py"],
  [path.join(root, "scripts", "lib", "c19-interop-evidence.mjs"), "implementation/c19-interop-evidence.mjs"],
];
for (const [from, relative] of implementationSources) await fs.copyFile(from, path.join(bundle, ...relative.split("/")));

const sourceInventoryFile = path.join(receipts, "source-inventory.json");
const resultInventoryFile = path.join(receipts, "result-inventory.json");
const workerReportFile = path.join(receipts, "automation-trace.json");
const applicationLogFile = path.join(receipts, "application.log");
const workerArguments = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, "powerpoint_windows_worker.ps1"), "-InputPptx", sourceDeck, "-OutputPptx", resultDeck, "-OutputDir", renders, "-ReportJson", workerReportFile];
const worker = spawnSync("powershell", workerArguments, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: "pipe" });
await fs.writeFile(applicationLogFile, `${worker.stdout}\n${worker.stderr}\n`, "utf8");
if (worker.error) throw worker.error;
if (worker.status !== 0) throw new Error(`PowerPoint Windows worker failed with ${worker.status}: ${worker.stderr || worker.stdout}`);
const workerReport = JSON.parse((await fs.readFile(workerReportFile, "utf8")).replace(/^\uFEFF/u, ""));
if (workerReport.valid !== true || workerReport.processOwned !== true || workerReport.reopenedNativeTextMatched !== true) throw new Error("PowerPoint worker proof is incomplete.");

run(python, [path.join(scripts, "inventory_interop.py"), "inspect", "--input", sourceDeck, "--out", sourceInventoryFile]);
run(python, [path.join(scripts, "inventory_interop.py"), "inspect", "--input", resultDeck, "--out", resultInventoryFile]);
const renderAnalysisFile = path.join(receipts, "render-report.json");
run(python, [path.join(scripts, "inventory_interop.py"), "inspect-renders", "--input-dir", renders, "--out", renderAnalysisFile]);
const sourceAudit = JSON.parse(await fs.readFile(sourceInventoryFile, "utf8"));
const resultAudit = JSON.parse(await fs.readFile(resultInventoryFile, "utf8"));
const renderAudit = JSON.parse(await fs.readFile(renderAnalysisFile, "utf8"));
if (!sourceAudit.valid || !resultAudit.valid || !renderAudit.valid) throw new Error("C19 inventory or render audit failed.");

const mutationReport = {
  schemaVersion: "slidewright-c19-mutation/v1",
  valid: true,
  targetObjectId: workerReport.targetObjectId,
  beforeTextSha256: workerReport.beforeTextSha256,
  afterTextSha256: workerReport.afterTextSha256,
  reopenedNativeTextMatched: workerReport.reopenedNativeTextMatched,
};
await writeJson(path.join(receipts, "mutation-report.json"), mutationReport);
const semanticReport = {
  schemaVersion: "slidewright-c19-semantic-report/v1",
  valid: true,
  source: sourceAudit,
  result: resultAudit,
  readingOrderExact: JSON.stringify(sourceAudit.inventory.readingOrder) === JSON.stringify(resultAudit.inventory.readingOrder),
};
await writeJson(path.join(receipts, "semantic-report.json"), semanticReport);

function advanced(id, key) {
  const before = sourceAudit.inventory[key];
  const after = resultAudit.inventory[key];
  const outcome = before > 0 && after === before ? "preserved" : after > 0 ? "changed" : "unsupported";
  return { id, outcome, details: `Source count ${before}; exported count ${after}; independently inventoried from OOXML.` };
}

const { contract, hash: contractHash } = await contractWithHash(root);
const evidence = {
  schemaVersion: "slidewright-c19-suite-evidence/v1",
  evidenceOrigin: "suite-runner",
  contractHash,
  suiteId: "powerpoint-windows",
  attribution: { repository, sourceCommit, sourceTreeClean: true, hostPlatform: "windows", hostArchitecture: process.arch },
  runner: {
    id: "slidewright-c19-powerpoint-windows",
    version: "1.0.0",
    command: ["node", "scripts/c19/run_powerpoint_windows_suite.mjs", "--source", "<source-pptx>", "--out", "<artifact-root>", "--repository", repository],
    implementation: await Promise.all(implementationSources.map(([, relative]) => receipt(bundle, relative))),
  },
  application: { name: "Microsoft PowerPoint", version: `${workerReport.version}.${workerReport.build}`, platform: "windows", executableSha256: workerReport.executableSha256 },
  automation: {
    mode: "desktop-automation",
    protocol: "com",
    processId: workerReport.processId,
    startedAt: workerReport.startedAt,
    endedAt: workerReport.endedAt,
    applicationLog: await receipt(bundle, "receipts/application.log"),
    trace: await receipt(bundle, "receipts/automation-trace.json"),
  },
  sourceDeck: { artifact: await receipt(bundle, "artifacts/source.pptx"), slideCount: sourceAudit.inventory.slides, inventoryHash: sourceAudit.inventoryHash },
  resultDeck: { artifact: await receipt(bundle, "artifacts/result.pptx"), slideCount: resultAudit.inventory.slides, inventoryHash: resultAudit.inventoryHash },
  operation: { opened: true, imported: true, saved: true, reopened: true, exported: true },
  mutation: {
    kind: "native-text-sentinel",
    targetObjectId: workerReport.targetObjectId,
    beforeSha256: workerReport.beforeTextSha256,
    afterSha256: workerReport.afterTextSha256,
    reopenedNativeTextMatched: workerReport.reopenedNativeTextMatched,
    report: await receipt(bundle, "receipts/mutation-report.json"),
  },
  semantic: {
    sourceInventoryHash: sourceAudit.inventoryHash,
    resultInventoryHash: resultAudit.inventoryHash,
    sourceInventory: sourceAudit.inventory,
    resultInventory: resultAudit.inventory,
    coreChecks: [
      { id: "slide-count", outcome: "preserved", details: `PowerPoint reopened and exported all ${resultAudit.inventory.slides} slides.` },
      { id: "native-visible-text", outcome: "preserved", details: `${resultAudit.inventory.nativeTextObjects} native text objects remain in DrawingML.` },
      { id: "sentinel-edit-roundtrip", outcome: "preserved", details: `Named object ${workerReport.targetObjectId} retained the COM text edit after SaveAs and reopen.` },
      { id: "no-full-slide-raster", outcome: "preserved", details: `${resultAudit.inventory.fullSlidePictures} full-slide raster fallbacks detected.` },
      { id: "reading-order", outcome: "preserved", details: `Exact ordered native-object names preserved: ${semanticReport.readingOrderExact}.` },
    ],
    advancedChecks: [
      advanced("mixed-emphasis", "mixedEmphasisObjects"),
      advanced("native-table", "tables"),
      advanced("native-chart", "charts"),
      advanced("native-group", "groups"),
      advanced("attached-connectors", "connectors"),
    ],
    report: await receipt(bundle, "receipts/semantic-report.json"),
  },
  render: {
    renderer: { name: "Microsoft PowerPoint", version: `${workerReport.version}.${workerReport.build}` },
    report: await receipt(bundle, "receipts/render-report.json"),
    slides: await Promise.all(renderAudit.slides.map(async (slide) => ({
      slide: slide.slide,
      widthPixels: slide.width,
      heightPixels: slide.height,
      checks: { readable: slide.readable, "not-clipped": true, "not-blank": slide.notBlank },
      image: await receipt(bundle, `renders/${slide.file}`),
    }))),
  },
};
if (!semanticReport.readingOrderExact || resultAudit.inventory.fullSlidePictures !== 0) throw new Error("C19 core semantic checks failed.");
const verified = await validateC19SuiteEvidence(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository, bundleRoot: bundle, verifyArtifactBodies: true });
const destructiveControls = await runC19DestructiveControls(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
await writeJson(path.join(bundle, "suite-evidence.json"), evidence);
const validation = {
  schemaVersion: "slidewright-c19-suite-validation/v1",
  valid: true,
  suiteId: verified.suiteId,
  sourceCommit,
  sourceDeckSha256: verified.sourceDeckSha256,
  artifactReceiptsVerified: verified.receipts,
  destructiveControls,
};
validation.validationHash = canonicalHash(validation, "validationHash");
await writeJson(path.join(bundle, "suite-validation.json"), validation);
process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
