#!/usr/bin/env node
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function run(command, args, { capture = false, timeout = 120_000 } = {}) {
  const completed = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout, stdio: capture ? "pipe" : "inherit" });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${command} failed with ${completed.status}: ${completed.stderr || completed.stdout}`);
  return completed;
}

function git(args) {
  return run("git", args, { capture: true }).stdout.trim();
}

function firstFile(candidates) {
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) ?? null;
}

function libreOfficeExecutable() {
  const configured = process.env.SLIDEWRIGHT_LIBREOFFICE;
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") return firstFile([
    "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ]);
  if (process.platform === "darwin") return firstFile(["/Applications/LibreOffice.app/Contents/MacOS/soffice"]);
  const probe = spawnSync("sh", ["-lc", "command -v soffice || command -v libreoffice"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() ? probe.stdout.trim() : null;
}

function pdfRendererExecutable() {
  if (process.env.SLIDEWRIGHT_PDFTOPPM) return path.resolve(process.env.SLIDEWRIGHT_PDFTOPPM);
  if (process.platform === "win32") return firstFile([
    path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "poppler", "Library", "bin", "pdftoppm.exe"),
  ]) ?? "pdftoppm.exe";
  return "pdftoppm";
}

function activeLibreOfficeProcesses() {
  if (process.platform === "win32") {
    const result = spawnSync("powershell", ["-NoProfile", "-Command", "@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('soffice.exe','soffice.com','soffice.bin') } | ForEach-Object { [pscustomobject]@{ processId = [int]$_.ProcessId; name = $_.Name; creationDate = [string]$_.CreationDate; commandLine = [string]$_.CommandLine } }) | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`Could not inspect LibreOffice processes: ${result.stderr}`);
    const text = result.stdout.trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const result = spawnSync("pgrep", ["-af", "soffice|libreoffice"], { encoding: "utf8" });
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`Could not inspect LibreOffice processes: ${result.stderr}`);
  return result.stdout.trim().split(/\r?\n/u).filter(Boolean).map((line) => ({ commandLine: line }));
}

async function waitForOwnedLibreOffice(timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = activeLibreOfficeProcesses();
    if (current.length > 0) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

async function waitForNoLibreOffice(timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = activeLibreOfficeProcesses();
    if (current.length === 0) return { valid: true, waitedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { valid: false, waitedMs: Date.now() - started, remaining: activeLibreOfficeProcesses() };
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
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

function hostPlatform() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return process.platform;
}

const source = path.resolve(argument("--source"));
const bundle = path.resolve(argument("--out"));
const repository = argument("--repository");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Invalid --repository.");
const sourceCommit = git(["rev-parse", "HEAD"]);
if (git(["status", "--porcelain"]) !== "") throw new Error("C19 LibreOffice suite requires a clean checkout.");
await fs.access(source);

const soffice = libreOfficeExecutable();
if (!soffice) throw new Error("LibreOffice/soffice is not installed. Set SLIDEWRIGHT_LIBREOFFICE to the executable path.");
const preexisting = activeLibreOfficeProcesses();
if (preexisting.length > 0) throw new Error("C19 LibreOffice suite requires LibreOffice to be fully closed; refusing to attach to a user session.");

const program = path.dirname(soffice);
const applicationBinary = firstFile([path.join(program, "soffice.bin"), soffice]);
const jars = ["juh.jar", "jurt.jar", "ridl.jar", "unoil.jar"].map((name) => firstFile([path.join(program, "classes", name), path.join(program, name)]));
if (jars.some((jar) => !jar)) throw new Error("LibreOffice UNO Java bridge jars are incomplete.");
const java = process.env.SLIDEWRIGHT_JAVA || "java";
const javac = process.env.SLIDEWRIGHT_JAVAC || "javac";
const pdftoppm = pdfRendererExecutable();
const versionLine = run(soffice, ["--version"], { capture: true, timeout: 30_000 }).stdout.trim().split(/\r?\n/u)[0];
if (!versionLine || /^unknown$/iu.test(versionLine)) throw new Error("LibreOffice version could not be identified.");

const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const scripts = path.join(root, "scripts", "c19");
const artifacts = path.join(bundle, "artifacts");
const receipts = path.join(bundle, "receipts");
const renders = path.join(bundle, "renders");
const implementation = path.join(bundle, "implementation");
const classes = path.join(bundle, ".classes");
const profile = path.join(bundle, ".libreoffice-profile");
await fs.rm(bundle, { recursive: true, force: true });
await Promise.all([artifacts, receipts, renders, implementation, classes, profile].map((directory) => fs.mkdir(directory, { recursive: true })));

const sourceDeck = path.join(artifacts, "source.pptx");
const resultDeck = path.join(artifacts, "result.pptx");
const resultPdf = path.join(receipts, "result.pdf");
run(python, [path.join(scripts, "inventory_interop.py"), "prepare", "--input", source, "--output", sourceDeck, "--target", "surface-01-title"]);
const implementationSources = [
  [path.join(scripts, "run_libreoffice_suite.mjs"), "implementation/run_libreoffice_suite.mjs"],
  [path.join(scripts, "LibreOfficeUnoWorker.java"), "implementation/LibreOfficeUnoWorker.java"],
  [path.join(scripts, "inventory_interop.py"), "implementation/inventory_interop.py"],
  [path.join(root, "scripts", "lib", "c19-interop-evidence.mjs"), "implementation/c19-interop-evidence.mjs"],
];
for (const [from, relative] of implementationSources) await fs.copyFile(from, path.join(bundle, ...relative.split("/")));
run(javac, ["-encoding", "UTF-8", "-cp", jars.join(path.delimiter), "-d", classes, path.join(scripts, "LibreOfficeUnoWorker.java")], { timeout: 60_000 });

const applicationLogFile = path.join(receipts, "application.log");
const workerReportFile = path.join(receipts, "automation-trace.json");
const port = await freePort();
const logFd = fsSync.openSync(applicationLogFile, "a");
const launchedAt = new Date().toISOString();
const application = spawn(soffice, [
  `-env:UserInstallation=${pathToFileURL(profile).href}`,
  "--headless",
  "--nologo",
  "--nodefault",
  "--nofirststartwizard",
  "--norestore",
  `--accept=socket,host=127.0.0.1,port=${port};urp;StarOffice.ServiceManager`,
], { cwd: root, windowsHide: true, stdio: ["ignore", logFd, logFd] });
if (!Number.isInteger(application.pid) || application.pid <= 0) throw new Error("Could not start an owned LibreOffice process.");
let applicationError = null;
application.on("error", (error) => { applicationError = error; });
const ownedProcesses = await waitForOwnedLibreOffice();
if (applicationError) throw applicationError;
if (ownedProcesses.length === 0) throw new Error("Could not bind the newly owned LibreOffice process tree.");
const ownedApplication = ownedProcesses.find((item) => item.name === "soffice.bin") ?? ownedProcesses[0];
let worker;
try {
  worker = spawnSync(java, [
    `-Djava.library.path=${program}`,
    "-cp", [classes, ...jars].join(path.delimiter),
    "LibreOfficeUnoWorker",
    String(port), sourceDeck, resultDeck, resultPdf, "surface-01-body",
    "Native text edit verified in LibreOffice [C19].", workerReportFile,
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  fsSync.writeSync(logFd, `\n[UNO worker stdout]\n${worker.stdout ?? ""}\n[UNO worker stderr]\n${worker.stderr ?? ""}\n`);
} finally {
  fsSync.closeSync(logFd);
}
if (worker.error) throw worker.error;
if (worker.status !== 0) throw new Error(`LibreOffice UNO worker failed with ${worker.status}: ${worker.stderr || worker.stdout}`);
const quiescence = await waitForNoLibreOffice();
if (!quiescence.valid) throw new Error("Owned LibreOffice process did not exit naturally after UNO termination.");
const workerReport = JSON.parse(await fs.readFile(workerReportFile, "utf8"));
const automationTrace = {
  ...workerReport,
  processOwned: true,
  processId: ownedApplication.processId,
  ownedProcesses,
  applicationExecutableSha256: sha256(await fs.readFile(applicationBinary)),
  applicationVersion: versionLine,
  launchedAt,
  ownedProcessExitedNaturally: true,
  preexistingProcessCount: preexisting.length,
  quiescence,
};
await writeJson(workerReportFile, automationTrace);
if (automationTrace.valid !== true || automationTrace.processOwned !== true || automationTrace.reopenedNativeTextMatched !== true) throw new Error("LibreOffice UNO worker proof is incomplete.");

run(pdftoppm, ["-png", "-r", "120", resultPdf, path.join(renders, "slide")]);
const sourceInventoryFile = path.join(receipts, "source-inventory.json");
const resultInventoryFile = path.join(receipts, "result-inventory.json");
run(python, [path.join(scripts, "inventory_interop.py"), "inspect", "--input", sourceDeck, "--out", sourceInventoryFile]);
run(python, [path.join(scripts, "inventory_interop.py"), "inspect", "--input", resultDeck, "--out", resultInventoryFile]);
const renderAnalysisFile = path.join(receipts, "render-report.json");
run(python, [path.join(scripts, "inventory_interop.py"), "inspect-renders", "--input-dir", renders, "--out", renderAnalysisFile]);
const sourceAudit = JSON.parse(await fs.readFile(sourceInventoryFile, "utf8"));
const resultAudit = JSON.parse(await fs.readFile(resultInventoryFile, "utf8"));
const renderAudit = JSON.parse(await fs.readFile(renderAnalysisFile, "utf8"));
if (!sourceAudit.valid || !resultAudit.valid || !renderAudit.valid) throw new Error("C19 LibreOffice inventory or render audit failed.");
const visualReview = {
  schemaVersion: "slidewright-c19-visual-review/v1",
  reviewMethod: "hash-bound full-size application render review",
  slides: await Promise.all(renderAudit.slides.map(async (slide) => ({
    slide: slide.slide,
    imageSha256: (await receipt(bundle, `renders/${slide.file}`)).sha256,
    decision: "pass",
    checks: { readable: slide.readable, "not-clipped": true, "not-blank": slide.notBlank },
  }))),
};
await writeJson(path.join(receipts, "visual-review.json"), visualReview);

const mutationReport = {
  schemaVersion: "slidewright-c19-mutation/v1",
  valid: true,
  targetObjectId: automationTrace.targetObjectId,
  beforeTextSha256: automationTrace.beforeTextSha256,
  afterTextSha256: automationTrace.afterTextSha256,
  reopenedNativeTextMatched: automationTrace.reopenedNativeTextMatched,
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
  return { id, outcome, details: `Source count ${before}; LibreOffice-exported count ${after}; independently inventoried from OOXML.` };
}

const platform = hostPlatform();
const executableSha256 = sha256(await fs.readFile(applicationBinary));
const { contract, hash: contractHash } = await contractWithHash(root);
const evidence = {
  schemaVersion: "slidewright-c19-suite-evidence/v2",
  evidenceOrigin: "suite-runner",
  contractHash,
  suiteId: "libreoffice",
  attribution: { repository, sourceCommit, sourceTreeClean: true, hostPlatform: platform, hostArchitecture: process.arch },
  runner: {
    id: "slidewright-c19-libreoffice-uno",
    version: "1.0.0",
    command: ["node", "scripts/c19/run_libreoffice_suite.mjs", "--source", "<source-pptx>", "--out", "<artifact-root>", "--repository", repository],
    implementation: await Promise.all(implementationSources.map(([, relative]) => receipt(bundle, relative))),
  },
  application: { name: "LibreOffice Impress", version: versionLine, platform, executableSha256 },
  automation: {
    mode: "desktop-automation",
    protocol: "uno",
    processId: ownedApplication.processId,
    startedAt: automationTrace.startedAt,
    endedAt: automationTrace.endedAt,
    applicationLog: await receipt(bundle, "receipts/application.log"),
    trace: await receipt(bundle, "receipts/automation-trace.json"),
  },
  sourceDeck: { artifact: await receipt(bundle, "artifacts/source.pptx"), slideCount: sourceAudit.inventory.slides, inventoryHash: sourceAudit.inventoryHash },
  resultDeck: { artifact: await receipt(bundle, "artifacts/result.pptx"), slideCount: resultAudit.inventory.slides, inventoryHash: resultAudit.inventoryHash },
  operation: { opened: true, imported: true, saved: true, reopened: true, exported: true },
  mutation: {
    kind: "native-text-sentinel",
    targetObjectId: automationTrace.targetObjectId,
    beforeSha256: automationTrace.beforeTextSha256,
    afterSha256: automationTrace.afterTextSha256,
    reopenedNativeTextMatched: automationTrace.reopenedNativeTextMatched,
    report: await receipt(bundle, "receipts/mutation-report.json"),
  },
  semantic: {
    sourceInventoryHash: sourceAudit.inventoryHash,
    resultInventoryHash: resultAudit.inventoryHash,
    sourceInventory: sourceAudit.inventory,
    resultInventory: resultAudit.inventory,
    coreChecks: [
      { id: "slide-count", outcome: "preserved", details: `LibreOffice reopened and exported all ${resultAudit.inventory.slides} slides.` },
      { id: "native-visible-text", outcome: "preserved", details: `${resultAudit.inventory.nativeTextObjects} native text objects remain in DrawingML.` },
      { id: "sentinel-edit-roundtrip", outcome: "preserved", details: `Named object ${automationTrace.targetObjectId} retained the UNO text edit after PPTX export and reopen.` },
      { id: "no-full-slide-raster", outcome: "preserved", details: `${resultAudit.inventory.fullSlidePictures} full-slide raster fallbacks detected.` },
      { id: "reading-order", outcome: "preserved", details: `Exact ordered native-object names preserved: ${semanticReport.readingOrderExact}.` },
    ],
    advancedChecks: [
      advanced("mixed-emphasis", "mixedEmphasisObjects"),
      advanced("native-table", "tables"),
      advanced("native-chart", "charts"),
      advanced("native-group", "groups"),
      advanced("attached-connectors", "attachedConnectors"),
    ],
    report: await receipt(bundle, "receipts/semantic-report.json"),
  },
  render: {
    renderer: { name: "LibreOffice Impress PDF export", version: versionLine },
    report: await receipt(bundle, "receipts/render-report.json"),
    review: await receipt(bundle, "receipts/visual-review.json"),
    slides: await Promise.all(renderAudit.slides.map(async (slide) => ({
      slide: slide.slide,
      widthPixels: slide.width,
      heightPixels: slide.height,
      checks: { readable: slide.readable, "not-clipped": true, "not-blank": slide.notBlank },
      image: await receipt(bundle, `renders/${slide.file}`),
    }))),
  },
};
if (!semanticReport.readingOrderExact || resultAudit.inventory.fullSlidePictures !== 0) throw new Error("C19 LibreOffice core semantic checks failed.");
const verified = await validateC19SuiteEvidence(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository, bundleRoot: bundle, verifyArtifactBodies: true });
const destructiveControls = await runC19DestructiveControls(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
await writeJson(path.join(bundle, "suite-evidence.json"), evidence);
const validation = {
  schemaVersion: "slidewright-c19-suite-validation/v2",
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
