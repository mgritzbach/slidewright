#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalHash,
  containsBrowserCredentialMaterial,
  contractWithHash,
  runC19DestructiveControls,
  sha256,
  validateC19SuiteEvidence,
  validateFileReceipt,
  verifyFileReceipt,
} from "../lib/c19-interop-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIGEST = /^[a-f0-9]{64}$/u;
const ORIGIN = "https://www.canva.com";
const OPERATION_IDS = [
  "import-pptx",
  "open-before",
  "native-edit",
  "save",
  "reopen-after",
  "export-pptx",
  "export-pdf",
  "cleanup-delete",
];
const OPERATION_OBSERVATIONS = {
  "import-pptx": "imported-pptx",
  "open-before": "sentinel-before-visible",
  "native-edit": "sentinel-after-visible",
  save: "save-complete",
  "reopen-after": "reopen-complete",
  "export-pptx": "pptx-download-complete",
  "export-pdf": "pdf-download-complete",
  "cleanup-delete": "resource-deleted",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, allowed, label) {
  invariant(value && typeof value === "object" && Object.keys(value).every((key) => allowed.includes(key)), `${label} contains undeclared or identity-bearing fields.`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

function run(command, args, { capture = false } = {}) {
  const completed = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${command} failed with ${completed.status}: ${completed.stderr || completed.stdout}`);
  return completed;
}

function git(args) {
  return run("git", args, { capture: true }).stdout.trim();
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function receipt(bundle, relative) {
  const bytes = await fs.readFile(path.join(bundle, ...relative.split("/")));
  return { path: relative, byteLength: bytes.length, sha256: sha256(bytes) };
}

function captureReceipts(manifest) {
  return [
    manifest.files.sourcePptx,
    manifest.files.resultPptx,
    manifest.files.resultPdf,
    manifest.files.applicationLog,
    manifest.files.automationTrace,
    manifest.files.visualReview,
    ...manifest.files.operationEvidence.map((item) => item.artifact),
    ...manifest.files.renders.map((item) => item.image),
  ];
}

async function verifyAndCopyCapture(captureRoot, bundle, manifest) {
  const seen = new Set();
  for (const item of captureReceipts(manifest)) {
    validateFileReceipt(item, "Canva browser capture");
    invariant(!seen.has(item.path), `Canva browser capture duplicates ${item.path}.`);
    seen.add(item.path);
    await verifyFileReceipt(captureRoot, item, `Canva browser capture ${item.path}`);
    const source = path.join(captureRoot, ...item.path.replaceAll("\\", "/").split("/"));
    const target = path.join(bundle, ...item.path.replaceAll("\\", "/").split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

async function rejectSecretBearingCapture(captureRoot, manifest) {
  const redactedFiles = [
    manifest.files.applicationLog,
    manifest.files.automationTrace,
    manifest.files.visualReview,
    ...manifest.files.operationEvidence.map((item) => item.artifact),
  ];
  for (const item of redactedFiles) {
    const text = await fs.readFile(path.join(captureRoot, ...item.path.replaceAll("\\", "/").split("/")), "utf8");
    invariant(!containsBrowserCredentialMaterial(text), `Canva browser capture contains credential or identity material in ${item.path}.`);
  }
}

function replaceSentinelInOrder(order, beforeText, afterText) {
  const copy = structuredClone(order);
  let matches = 0;
  for (const slide of copy) {
    for (let index = 0; index < slide.length; index += 1) {
      if (slide[index] === beforeText) {
        slide[index] = afterText;
        matches += 1;
      }
    }
  }
  invariant(matches === 1, `The source deck must contain the sentinel text exactly once; found ${matches}.`);
  return copy;
}

const captureRoot = path.resolve(argument("--capture"));
const bundle = path.resolve(argument("--out"));
const repository = argument("--repository");
const manifestPath = path.join(captureRoot, "capture-manifest.json");
const sourceCommit = git(["rev-parse", "HEAD"]);
if (git(["status", "--porcelain"]) !== "") throw new Error("C19 Canva evidence requires an exact clean Git checkout.");

const manifest = await readJson(manifestPath);
exactKeys(manifest, ["schemaVersion", "captureOrigin", "recordedAt", "files", "mutation"], "Canva capture manifest");
invariant(manifest.schemaVersion === "slidewright-c19-canva-browser-capture/v1"
  && manifest.captureOrigin === "authenticated-canva-browser-automation"
  && Number.isFinite(Date.parse(manifest.recordedAt)), "Canva browser capture manifest is invalid.");
exactKeys(manifest.files, ["sourcePptx", "resultPptx", "resultPdf", "applicationLog", "automationTrace", "visualReview", "operationEvidence", "renders"], "Canva capture files");
exactKeys(manifest.mutation, ["targetObjectId", "beforeText", "afterText"], "Canva capture mutation");
invariant(manifest.mutation.targetObjectId && manifest.mutation.beforeText && manifest.mutation.afterText
  && manifest.mutation.beforeText !== manifest.mutation.afterText, "Canva browser capture sentinel mutation is invalid.");
invariant(Array.isArray(manifest.files.operationEvidence) && manifest.files.operationEvidence.length === OPERATION_IDS.length
  && JSON.stringify(manifest.files.operationEvidence.map((item) => item.id)) === JSON.stringify(OPERATION_IDS), "Canva browser operation evidence set is incomplete or reordered.");
invariant(Array.isArray(manifest.files.renders) && manifest.files.renders.length > 0, "Canva browser capture renders are missing.");
invariant(!containsBrowserCredentialMaterial(JSON.stringify(manifest)), "Canva browser capture manifest contains credential or identity material.");

await rejectSecretBearingCapture(captureRoot, manifest);
await fs.rm(bundle, { recursive: true, force: true });
await fs.mkdir(path.join(bundle, "implementation"), { recursive: true });
await verifyAndCopyCapture(captureRoot, bundle, manifest);
await fs.mkdir(path.join(bundle, "capture"), { recursive: true });
await fs.copyFile(manifestPath, path.join(bundle, "capture", "capture-manifest.json"));

const implementationSources = [
  [path.join(root, "scripts", "c19", "run_canva_suite.mjs"), "implementation/run_canva_suite.mjs"],
  [path.join(root, "scripts", "c19", "inventory_interop.py"), "implementation/inventory_interop.py"],
  [path.join(root, "scripts", "lib", "c19-interop-evidence.mjs"), "implementation/c19-interop-evidence.mjs"],
  [path.join(root, "schemas", "c19-browser-operation-evidence.schema.json"), "implementation/c19-browser-operation-evidence.schema.json"],
  [path.join(root, "schemas", "c19-browser-trace.schema.json"), "implementation/c19-browser-trace.schema.json"],
  [path.join(root, "schemas", "c19-canva-browser-capture.schema.json"), "implementation/c19-canva-browser-capture.schema.json"],
  [path.join(root, "schemas", "c19-interop-suite-v2.schema.json"), "implementation/c19-interop-suite-v2.schema.json"],
];
for (const [source, relative] of implementationSources) {
  const target = path.join(bundle, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

const trace = await readJson(path.join(bundle, ...manifest.files.automationTrace.path.split("/")));
exactKeys(trace, ["schemaVersion", "authenticated", "authentication", "browser", "serviceOrigins", "resourceIdSha256", "clientBuildSha256", "beforeStateSha256", "afterStateSha256", "startedAt", "endedAt", "operations"], "Canva browser trace");
exactKeys(trace.authentication, ["type", "principalSha256"], "Canva browser authentication");
exactKeys(trace.browser, ["name", "version"], "Canva browser identity");
invariant(trace.schemaVersion === "slidewright-c19-browser-trace/v1" && trace.authenticated === true
  && trace.authentication.type === "browser-session" && DIGEST.test(trace.authentication.principalSha256 ?? "")
  && typeof trace.browser.name === "string" && trace.browser.name.length > 0
  && typeof trace.browser.version === "string" && trace.browser.version.length > 0 && !/^unknown$/iu.test(trace.browser.version)
  && JSON.stringify(trace.serviceOrigins) === JSON.stringify([ORIGIN])
  && [trace.resourceIdSha256, trace.clientBuildSha256, trace.beforeStateSha256, trace.afterStateSha256].every((item) => DIGEST.test(item ?? ""))
  && trace.beforeStateSha256 !== trace.afterStateSha256, "Canva authenticated browser trace is invalid.");
invariant(Number.isFinite(Date.parse(trace.startedAt)) && Number.isFinite(Date.parse(trace.endedAt))
  && Date.parse(trace.endedAt) >= Date.parse(trace.startedAt), "Canva browser trace timestamps are invalid.");
invariant(Array.isArray(trace.operations) && trace.operations.length === OPERATION_IDS.length, "Canva browser trace operation sequence is incomplete.");

let previousEndedAt = null;
for (const [index, id] of OPERATION_IDS.entries()) {
  const operation = trace.operations[index];
  exactKeys(operation, ["id", "origin", "status", "resourceIdSha256", "startedAt", "endedAt", "evidence", "stateSha256", "beforeStateSha256", "afterStateSha256", "artifactSha256", "resourceDeleted"], `Canva browser operation ${id}`);
  invariant(operation.id === id && operation.origin === ORIGIN && operation.status === "succeeded"
    && operation.resourceIdSha256 === trace.resourceIdSha256, `Canva browser operation sequence or resource binding drifted at ${id}.`);
  invariant(Number.isFinite(Date.parse(operation.startedAt)) && Number.isFinite(Date.parse(operation.endedAt))
    && Date.parse(operation.endedAt) >= Date.parse(operation.startedAt)
    && (previousEndedAt === null || Date.parse(operation.startedAt) >= previousEndedAt), `Canva browser operation ${id} timestamps overlap or are invalid.`);
  previousEndedAt = Date.parse(operation.endedAt);
  invariant(JSON.stringify(operation.evidence) === JSON.stringify(manifest.files.operationEvidence[index].artifact), `Canva browser operation ${id} evidence receipt drifted.`);

  const observation = await readJson(path.join(bundle, ...operation.evidence.path.split("/")));
  exactKeys(observation, ["schemaVersion", "operationId", "origin", "resourceIdSha256", "recordedAt", "actionSha256", "observationSha256", "observations"], `Canva operation evidence ${id}`);
  invariant(observation.schemaVersion === "slidewright-c19-browser-operation-evidence/v1"
    && observation.operationId === id && observation.origin === ORIGIN && observation.resourceIdSha256 === trace.resourceIdSha256
    && Number.isFinite(Date.parse(observation.recordedAt)) && DIGEST.test(observation.actionSha256 ?? "") && DIGEST.test(observation.observationSha256 ?? "")
    && Array.isArray(observation.observations) && observation.observations.includes(OPERATION_OBSERVATIONS[id]), `Canva operation evidence ${id} is incomplete.`);
}
invariant(trace.operations[1].stateSha256 === trace.beforeStateSha256
  && trace.operations[2].beforeStateSha256 === trace.beforeStateSha256
  && trace.operations[2].afterStateSha256 === trace.afterStateSha256
  && trace.operations[4].stateSha256 === trace.afterStateSha256, "Canva browser before/edit/reopen state binding drifted.");
invariant(trace.operations[5].artifactSha256 === manifest.files.resultPptx.sha256
  && trace.operations[6].artifactSha256 === manifest.files.resultPdf.sha256, "Canva browser export artifact binding drifted.");
invariant(trace.operations[7].resourceDeleted === true, "Canva browser-created resource deletion is unproven.");

const pdfBytes = await fs.readFile(path.join(bundle, ...manifest.files.resultPdf.path.split("/")));
invariant(pdfBytes.subarray(0, 5).toString("ascii") === "%PDF-", "Canva render source is not a PDF export.");

const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const receiptsDirectory = path.join(bundle, "receipts");
await fs.mkdir(receiptsDirectory, { recursive: true });
const sourceInventoryFile = path.join(receiptsDirectory, "source-inventory.json");
const resultInventoryFile = path.join(receiptsDirectory, "result-inventory.json");
const renderReportFile = path.join(receiptsDirectory, "render-report.json");
run(python, [path.join(root, "scripts", "c19", "inventory_interop.py"), "inspect", "--input", path.join(bundle, ...manifest.files.sourcePptx.path.split("/")), "--out", sourceInventoryFile]);
run(python, [path.join(root, "scripts", "c19", "inventory_interop.py"), "inspect", "--input", path.join(bundle, ...manifest.files.resultPptx.path.split("/")), "--out", resultInventoryFile]);
const renderDirectories = new Set(manifest.files.renders.map((item) => path.dirname(item.image.path)));
invariant(renderDirectories.size === 1, "Canva render images must share one directory.");
run(python, [path.join(root, "scripts", "c19", "inventory_interop.py"), "inspect-renders", "--input-dir", path.join(bundle, ...[...renderDirectories][0].split("/")), "--out", renderReportFile]);

const sourceAudit = await readJson(sourceInventoryFile);
const resultAudit = await readJson(resultInventoryFile);
const renderAudit = await readJson(renderReportFile);
invariant(sourceAudit.valid && resultAudit.valid && renderAudit.valid, "Canva OOXML or render audit failed.");
invariant(sourceAudit.inventory.slides === resultAudit.inventory.slides
  && sourceAudit.inventory.nativeTextObjects === resultAudit.inventory.nativeTextObjects
  && resultAudit.inventory.fullSlidePictures === 0, "Canva core native-text or no-raster invariant failed.");
const expectedTextOrder = replaceSentinelInOrder(sourceAudit.inventory.visibleTextOrder, manifest.mutation.beforeText, manifest.mutation.afterText);
const readingOrderExact = JSON.stringify(expectedTextOrder) === JSON.stringify(resultAudit.inventory.visibleTextOrder);
invariant(readingOrderExact, "Canva changed native visible-text reading order or made an undeclared text edit.");

const visualReview = await readJson(path.join(bundle, ...manifest.files.visualReview.path.split("/")));
invariant(visualReview.schemaVersion === "slidewright-c19-visual-review/v1"
  && visualReview.sourceDocumentSha256 === manifest.files.resultPdf.sha256
  && typeof visualReview.reviewMethod === "string" && visualReview.reviewMethod.length > 0
  && Number.isFinite(Date.parse(visualReview.reviewedAt)), "Canva visual review is invalid.");
invariant(Array.isArray(visualReview.slides) && visualReview.slides.length === resultAudit.inventory.slides, "Canva visual review slide set is incomplete.");
const captureRenderBySlide = new Map(manifest.files.renders.map((item) => [item.slide, item.image]));
for (const [index, item] of visualReview.slides.entries()) {
  const slide = index + 1;
  invariant(item.slide === slide && item.decision === "pass"
    && item.checks?.readable === true && item.checks?.["not-clipped"] === true && item.checks?.["not-blank"] === true
    && item.imageSha256 === captureRenderBySlide.get(slide)?.sha256, `Canva visual review is not hash-bound for slide ${slide}.`);
}

const mutationReport = {
  schemaVersion: "slidewright-c19-mutation/v2",
  valid: true,
  targetObjectId: manifest.mutation.targetObjectId,
  beforeTextSha256: sha256(manifest.mutation.beforeText),
  afterTextSha256: sha256(manifest.mutation.afterText),
  reopenedNativeTextMatched: true,
  beforeStateSha256: trace.beforeStateSha256,
  afterStateSha256: trace.afterStateSha256,
};
await writeJson(path.join(receiptsDirectory, "mutation-report.json"), mutationReport);
const semanticReport = {
  schemaVersion: "slidewright-c19-semantic-report/v2",
  valid: true,
  source: sourceAudit,
  result: resultAudit,
  visibleTextReadingOrderExactAfterSentinel: readingOrderExact,
};
await writeJson(path.join(receiptsDirectory, "semantic-report.json"), semanticReport);

function advanced(id, key) {
  const before = sourceAudit.inventory[key];
  const after = resultAudit.inventory[key];
  const outcome = before > 0 && after === before ? "preserved" : after > 0 ? "changed" : "unsupported";
  return { id, outcome, details: `Source count ${before}; Canva PPTX export count ${after}; independently inventoried from OOXML.` };
}

const { contract, hash: contractHash } = await contractWithHash(root);
const applicationVersion = `web-client@${trace.clientBuildSha256.slice(0, 16)}`;
const evidence = {
  schemaVersion: "slidewright-c19-suite-evidence/v2",
  evidenceOrigin: "suite-runner",
  contractHash,
  suiteId: "canva",
  attribution: { repository, sourceCommit, sourceTreeClean: true, hostPlatform: os.platform(), hostArchitecture: os.arch() },
  runner: {
    id: "slidewright-c19-canva-browser-capture-importer",
    version: "1.0.0",
    command: ["node", "scripts/c19/run_canva_suite.mjs", "--capture", "<capture-root>", "--out", "<artifact-root>", "--repository", repository],
    implementation: await Promise.all(implementationSources.map(([, relative]) => receipt(bundle, relative))),
  },
  application: {
    name: "Canva",
    version: applicationVersion,
    versionKind: "web-client-fingerprint",
    serviceBuildExposed: false,
    serviceOrigins: [ORIGIN],
    clientBuildSha256: trace.clientBuildSha256,
  },
  automation: {
    mode: "browser-automation",
    protocol: "browser",
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    authenticated: true,
    authentication: { type: "browser-session", principalSha256: trace.authentication.principalSha256 },
    browser: trace.browser,
    applicationLog: manifest.files.applicationLog,
    trace: manifest.files.automationTrace,
    captureManifest: await receipt(bundle, "capture/capture-manifest.json"),
    browserTrace: trace,
    browserEvidence: manifest.files.operationEvidence.map((item) => item.artifact),
  },
  sourceDeck: { artifact: manifest.files.sourcePptx, slideCount: sourceAudit.inventory.slides, inventoryHash: sourceAudit.inventoryHash },
  resultDeck: { artifact: manifest.files.resultPptx, slideCount: resultAudit.inventory.slides, inventoryHash: resultAudit.inventoryHash },
  operation: { opened: true, imported: true, saved: true, reopened: true, exported: true },
  mutation: {
    kind: "native-text-sentinel",
    targetObjectId: manifest.mutation.targetObjectId,
    beforeSha256: mutationReport.beforeTextSha256,
    afterSha256: mutationReport.afterTextSha256,
    reopenedNativeTextMatched: true,
    report: await receipt(bundle, "receipts/mutation-report.json"),
  },
  semantic: {
    sourceInventoryHash: sourceAudit.inventoryHash,
    resultInventoryHash: resultAudit.inventoryHash,
    sourceInventory: sourceAudit.inventory,
    resultInventory: resultAudit.inventory,
    coreChecks: [
      { id: "slide-count", outcome: "preserved", details: `Canva exported all ${resultAudit.inventory.slides} slides.` },
      { id: "native-visible-text", outcome: "preserved", details: `${resultAudit.inventory.nativeTextObjects} native text objects remain in DrawingML.` },
      { id: "sentinel-edit-roundtrip", outcome: "preserved", details: `Object ${manifest.mutation.targetObjectId} retained the browser-native text edit across save, reopen, and PPTX export.` },
      { id: "no-full-slide-raster", outcome: "preserved", details: `${resultAudit.inventory.fullSlidePictures} full-slide raster fallbacks detected.` },
      { id: "reading-order", outcome: "preserved", details: "Exact ordered native visible text was preserved after applying only the declared sentinel substitution." },
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
    renderer: { name: "Canva PDF export", version: applicationVersion },
    sourceDocument: manifest.files.resultPdf,
    report: await receipt(bundle, "receipts/render-report.json"),
    review: manifest.files.visualReview,
    slides: renderAudit.slides.map((slide) => {
      const captured = captureRenderBySlide.get(slide.slide);
      invariant(captured, `Missing captured Canva render for slide ${slide.slide}.`);
      const review = visualReview.slides[slide.slide - 1];
      return {
        slide: slide.slide,
        widthPixels: slide.width,
        heightPixels: slide.height,
        checks: review.checks,
        image: captured,
      };
    }),
  },
};

const verified = await validateC19SuiteEvidence(evidence, {
  contract,
  contractHash,
  expectedSourceCommit: sourceCommit,
  expectedRepository: repository,
  bundleRoot: bundle,
  verifyArtifactBodies: true,
});
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
