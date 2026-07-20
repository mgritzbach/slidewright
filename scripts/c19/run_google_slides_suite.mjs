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
  validateFileReceipt,
  verifyFileReceipt,
} from "../lib/c19-interop-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIGEST = /^[a-f0-9]{64}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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
    manifest.files.slidesDiscovery,
    manifest.files.driveDiscovery,
    manifest.files.presentationBefore,
    manifest.files.updateResponse,
    manifest.files.presentationAfter,
    manifest.files.visualReview,
    ...manifest.files.renders.map((item) => item.image),
  ];
}

async function verifyAndCopyCapture(captureRoot, bundle, manifest) {
  const seen = new Set();
  for (const item of captureReceipts(manifest)) {
    validateFileReceipt(item, "Google Slides capture");
    invariant(!seen.has(item.path), `Google Slides capture duplicates ${item.path}.`);
    seen.add(item.path);
    await verifyFileReceipt(captureRoot, item, `Google Slides capture ${item.path}`);
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
    manifest.files.presentationBefore,
    manifest.files.updateResponse,
    manifest.files.presentationAfter,
    manifest.files.visualReview,
  ];
  const secret = /Bearer\s+[A-Za-z0-9._~-]{16,}|"(?:access_token|refresh_token|client_secret|private_key|email|user_email|principal_email)"\s*:\s*"(?!<redacted>)[^"]{3,}|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
  for (const item of redactedFiles) {
    const text = await fs.readFile(path.join(captureRoot, ...item.path.replaceAll("\\", "/").split("/")), "utf8");
    invariant(!secret.test(text), `Google Slides capture contains credential material in ${item.path}.`);
  }
}

function validateDiscovery(document, expected) {
  invariant(document.id === expected.id && document.version === expected.version && document.rootUrl === expected.rootUrl
    && document.discoveryVersion === "v1" && document.protocol === "rest" && /^\d{8}$/u.test(document.revision ?? ""), `Google API discovery drifted for ${expected.id}.`);
  return { id: document.id, version: document.version, revision: document.revision, rootUrl: document.rootUrl };
}

function validateSnapshot(snapshot, label, trace, targetObjectId, expectedText) {
  invariant(snapshot.schemaVersion === "slidewright-c19-google-presentation-snapshot/v1", `${label} snapshot schema is invalid.`);
  invariant(snapshot.presentationIdSha256 === trace.resourceIdSha256 && DIGEST.test(snapshot.revisionIdSha256 ?? ""), `${label} snapshot resource/revision binding is invalid.`);
  invariant(snapshot.targetObjectId === targetObjectId && snapshot.targetText === expectedText, `${label} snapshot does not contain the exact sentinel text.`);
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
if (git(["status", "--porcelain"]) !== "") throw new Error("C19 Google Slides evidence requires an exact clean Git checkout.");

const manifest = await readJson(manifestPath);
invariant(manifest.schemaVersion === "slidewright-c19-google-slides-capture/v1"
  && manifest.captureOrigin === "authenticated-google-service-automation"
  && Number.isFinite(Date.parse(manifest.recordedAt)), "Google Slides capture manifest is invalid.");
invariant(manifest.mutation?.targetObjectId && manifest.mutation.beforeText && manifest.mutation.afterText
  && manifest.mutation.beforeText !== manifest.mutation.afterText, "Google Slides capture sentinel mutation is invalid.");
invariant(Array.isArray(manifest.files?.renders) && manifest.files.renders.length > 0, "Google Slides capture renders are missing.");

await rejectSecretBearingCapture(captureRoot, manifest);
await fs.rm(bundle, { recursive: true, force: true });
await fs.mkdir(path.join(bundle, "implementation"), { recursive: true });
await verifyAndCopyCapture(captureRoot, bundle, manifest);
await fs.mkdir(path.join(bundle, "capture"), { recursive: true });
await fs.copyFile(manifestPath, path.join(bundle, "capture", "capture-manifest.json"));

const implementationSources = [
  [path.join(root, "scripts", "c19", "run_google_slides_suite.mjs"), "implementation/run_google_slides_suite.mjs"],
  [path.join(root, "scripts", "c19", "inventory_interop.py"), "implementation/inventory_interop.py"],
  [path.join(root, "scripts", "lib", "c19-interop-evidence.mjs"), "implementation/c19-interop-evidence.mjs"],
  [path.join(root, "schemas", "c19-google-slides-capture.schema.json"), "implementation/c19-google-slides-capture.schema.json"],
  [path.join(root, "schemas", "c19-interop-suite-v2.schema.json"), "implementation/c19-interop-suite-v2.schema.json"],
];
for (const [source, relative] of implementationSources) {
  const target = path.join(bundle, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}

const slidesDiscoveryDocument = await readJson(path.join(bundle, ...manifest.files.slidesDiscovery.path.split("/")));
const driveDiscoveryDocument = await readJson(path.join(bundle, ...manifest.files.driveDiscovery.path.split("/")));
const slidesDiscovery = validateDiscovery(slidesDiscoveryDocument, { id: "slides:v1", version: "v1", rootUrl: "https://slides.googleapis.com/" });
const driveDiscovery = validateDiscovery(driveDiscoveryDocument, { id: "drive:v3", version: "v3", rootUrl: "https://www.googleapis.com/" });
const trace = await readJson(path.join(bundle, ...manifest.files.automationTrace.path.split("/")));
invariant(trace.schemaVersion === "slidewright-c19-google-service-trace/v1" && trace.authenticated === true, "Google Slides authenticated service trace is invalid.");
const traceKeys = ["schemaVersion", "authenticated", "authentication", "resourceIdSha256", "beforeRevisionIdSha256", "afterRevisionIdSha256", "startedAt", "endedAt", "operations"];
invariant(Object.keys(trace).every((key) => traceKeys.includes(key)), "Google Slides service trace contains undeclared or identity-bearing fields.");
invariant(trace.authentication && Object.keys(trace.authentication).every((key) => ["type", "principalSha256", "scopes"].includes(key)), "Google Slides authentication receipt contains undeclared identity fields.");
const operationKeys = ["id", "apiId", "method", "status", "resourceIdSha256", "requestSha256", "responseSha256", "startedAt", "endedAt", "requiredRevisionIdSha256", "revisionIdSha256"];
invariant(Array.isArray(trace.operations) && trace.operations.every((operation) => Object.keys(operation).every((key) => operationKeys.includes(key))), "Google Slides service operations contain undeclared fields.");

const beforeSnapshot = await readJson(path.join(bundle, ...manifest.files.presentationBefore.path.split("/")));
const updateResponse = await readJson(path.join(bundle, ...manifest.files.updateResponse.path.split("/")));
const afterSnapshot = await readJson(path.join(bundle, ...manifest.files.presentationAfter.path.split("/")));
validateSnapshot(beforeSnapshot, "Before", trace, manifest.mutation.targetObjectId, manifest.mutation.beforeText);
validateSnapshot(afterSnapshot, "After", trace, manifest.mutation.targetObjectId, manifest.mutation.afterText);
invariant(beforeSnapshot.revisionIdSha256 === trace.beforeRevisionIdSha256 && afterSnapshot.revisionIdSha256 === trace.afterRevisionIdSha256, "Google Slides snapshot revisions do not bind the service trace.");
invariant(updateResponse.schemaVersion === "slidewright-c19-google-update-response/v1"
  && updateResponse.presentationIdSha256 === trace.resourceIdSha256
  && updateResponse.beforeRevisionIdSha256 === trace.beforeRevisionIdSha256
  && updateResponse.afterRevisionIdSha256 === trace.afterRevisionIdSha256
  && updateResponse.requestCount === 1, "Google Slides batchUpdate response binding is invalid.");

const pdfBytes = await fs.readFile(path.join(bundle, ...manifest.files.resultPdf.path.split("/")));
invariant(pdfBytes.subarray(0, 5).toString("ascii") === "%PDF-", "Google Slides render source is not a PDF export.");

const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const receiptsDirectory = path.join(bundle, "receipts");
await fs.mkdir(receiptsDirectory, { recursive: true });
const sourceInventoryFile = path.join(receiptsDirectory, "source-inventory.json");
const resultInventoryFile = path.join(receiptsDirectory, "result-inventory.json");
const renderReportFile = path.join(receiptsDirectory, "render-report.json");
run(python, [path.join(root, "scripts", "c19", "inventory_interop.py"), "inspect", "--input", path.join(bundle, ...manifest.files.sourcePptx.path.split("/")), "--out", sourceInventoryFile]);
run(python, [path.join(root, "scripts", "c19", "inventory_interop.py"), "inspect", "--input", path.join(bundle, ...manifest.files.resultPptx.path.split("/")), "--out", resultInventoryFile]);
const renderDirectories = new Set(manifest.files.renders.map((item) => path.dirname(item.image.path)));
invariant(renderDirectories.size === 1, "Google Slides render images must share one directory.");
run(python, [path.join(root, "scripts", "c19", "inventory_interop.py"), "inspect-renders", "--input-dir", path.join(bundle, ...[...renderDirectories][0].split("/")), "--out", renderReportFile]);

const sourceAudit = await readJson(sourceInventoryFile);
const resultAudit = await readJson(resultInventoryFile);
const renderAudit = await readJson(renderReportFile);
invariant(sourceAudit.valid && resultAudit.valid && renderAudit.valid, "Google Slides OOXML or render audit failed.");
invariant(sourceAudit.inventory.slides === resultAudit.inventory.slides
  && sourceAudit.inventory.nativeTextObjects === resultAudit.inventory.nativeTextObjects
  && resultAudit.inventory.fullSlidePictures === 0, "Google Slides core native-text or no-raster invariant failed.");
const expectedTextOrder = replaceSentinelInOrder(sourceAudit.inventory.visibleTextOrder, manifest.mutation.beforeText, manifest.mutation.afterText);
const readingOrderExact = JSON.stringify(expectedTextOrder) === JSON.stringify(resultAudit.inventory.visibleTextOrder);
invariant(readingOrderExact, "Google Slides changed native visible-text reading order or made an undeclared text edit.");

const visualReview = await readJson(path.join(bundle, ...manifest.files.visualReview.path.split("/")));
invariant(visualReview.schemaVersion === "slidewright-c19-visual-review/v1"
  && visualReview.sourceDocumentSha256 === manifest.files.resultPdf.sha256
  && typeof visualReview.reviewMethod === "string" && visualReview.reviewMethod.length > 0
  && Number.isFinite(Date.parse(visualReview.reviewedAt)), "Google Slides visual review is invalid.");
invariant(Array.isArray(visualReview.slides) && visualReview.slides.length === resultAudit.inventory.slides, "Google Slides visual review slide set is incomplete.");
const captureRenderBySlide = new Map(manifest.files.renders.map((item) => [item.slide, item.image]));
for (const [index, item] of visualReview.slides.entries()) {
  const slide = index + 1;
  invariant(item.slide === slide && item.decision === "pass"
    && item.checks?.readable === true && item.checks?.["not-clipped"] === true && item.checks?.["not-blank"] === true
    && item.imageSha256 === captureRenderBySlide.get(slide)?.sha256, `Google Slides visual review is not hash-bound for slide ${slide}.`);
}

const mutationReport = {
  schemaVersion: "slidewright-c19-mutation/v2",
  valid: true,
  targetObjectId: manifest.mutation.targetObjectId,
  beforeTextSha256: sha256(manifest.mutation.beforeText),
  afterTextSha256: sha256(manifest.mutation.afterText),
  reopenedNativeTextMatched: true,
  beforeRevisionIdSha256: trace.beforeRevisionIdSha256,
  afterRevisionIdSha256: trace.afterRevisionIdSha256,
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
  return { id, outcome, details: `Source count ${before}; Google Slides PPTX export count ${after}; independently inventoried from OOXML.` };
}

const { contract, hash: contractHash } = await contractWithHash(root);
const applicationVersion = [slidesDiscovery, driveDiscovery].map((item) => `${item.id}@${item.revision}`).join("+");
const evidence = {
  schemaVersion: "slidewright-c19-suite-evidence/v2",
  evidenceOrigin: "suite-runner",
  contractHash,
  suiteId: "google-slides",
  attribution: { repository, sourceCommit, sourceTreeClean: true, hostPlatform: os.platform(), hostArchitecture: os.arch() },
  runner: {
    id: "slidewright-c19-google-slides-capture-importer",
    version: "2.0.0",
    command: ["node", "scripts/c19/run_google_slides_suite.mjs", "--capture", "<capture-root>", "--out", "<artifact-root>", "--repository", repository],
    implementation: await Promise.all(implementationSources.map(([, relative]) => receipt(bundle, relative))),
  },
  application: {
    name: "Google Slides",
    version: applicationVersion,
    versionKind: "api-discovery-revision",
    serviceBuildExposed: false,
    serviceOrigins: ["https://slides.googleapis.com", "https://www.googleapis.com"],
  },
  automation: {
    mode: "authenticated-service-automation",
    protocol: "rest-oauth2",
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    authenticated: true,
    authentication: {
      type: trace.authentication.type,
      principalSha256: trace.authentication.principalSha256,
      scopes: trace.authentication.scopes,
      resourceIdSha256: trace.resourceIdSha256,
    },
    applicationLog: manifest.files.applicationLog,
    trace: manifest.files.automationTrace,
    captureManifest: await receipt(bundle, "capture/capture-manifest.json"),
    discovery: [
      { ...slidesDiscovery, artifact: manifest.files.slidesDiscovery },
      { ...driveDiscovery, artifact: manifest.files.driveDiscovery },
    ],
    snapshots: [manifest.files.presentationBefore, manifest.files.updateResponse, manifest.files.presentationAfter],
    serviceTrace: trace,
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
      { id: "slide-count", outcome: "preserved", details: `Google Slides exported all ${resultAudit.inventory.slides} slides.` },
      { id: "native-visible-text", outcome: "preserved", details: `${resultAudit.inventory.nativeTextObjects} native text objects remain in DrawingML.` },
      { id: "sentinel-edit-roundtrip", outcome: "preserved", details: `Object ${manifest.mutation.targetObjectId} retained the API text edit across revision-bound readback and PPTX export.` },
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
    renderer: { name: "Google Slides PDF export", version: applicationVersion },
    sourceDocument: manifest.files.resultPdf,
    report: await receipt(bundle, "receipts/render-report.json"),
    review: manifest.files.visualReview,
    slides: await Promise.all(renderAudit.slides.map(async (slide) => {
      const captured = captureRenderBySlide.get(slide.slide);
      invariant(captured, `Missing captured render for slide ${slide.slide}.`);
      const review = visualReview.slides[slide.slide - 1];
      return {
        slide: slide.slide,
        widthPixels: slide.width,
        heightPixels: slide.height,
        checks: review.checks,
        image: captured,
      };
    })),
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
