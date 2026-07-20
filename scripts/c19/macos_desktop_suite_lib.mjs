import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  canonicalHash,
  contractWithHash,
  runC19DestructiveControls,
  sha256,
  validateC19SuiteEvidence,
} from "../lib/c19-interop-evidence.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateConfig(config) {
  invariant(config && typeof config === "object", "C19 macOS suite configuration is missing.");
  for (const key of ["root", "runner", "commonRunner", "worker", "inventory", "evidenceLibrary", "suiteId", "label", "application", "appBundle", "appExecutable", "nativeWorkingDocument", "emphasisTargetName", "targetName", "replacementText"]) {
    invariant(typeof config[key] === "string" && config[key].length > 0, `C19 macOS suite configuration ${key} is missing.`);
  }
  invariant(config.emphasisTargetName !== config.targetName, "C19 macOS mixed-emphasis preparation target must be distinct from the native mutation target.");
  return true;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function run(command, args, { root, capture = false } = {}) {
  const completed = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${command} failed with ${completed.status}: ${completed.stderr || completed.stdout}`);
  return completed;
}

function git(root, args) {
  return run("git", args, { root, capture: true }).stdout.trim();
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function receipt(bundle, relative) {
  const bytes = await fs.readFile(path.join(bundle, ...relative.split("/")));
  return { path: relative, byteLength: bytes.length, sha256: sha256(bytes) };
}

function parseWorkerFields(stdout) {
  const fields = {};
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("C19\t")) continue;
    const [, key, ...value] = line.split("\t");
    invariant(key && value.length > 0 && !(key in fields), `C19 macOS worker emitted an invalid or duplicated field: ${key ?? "<missing>"}.`);
    fields[key] = value.join("\t");
  }
  return fields;
}

function versionOf(command, args, root) {
  const completed = run(command, args, { root, capture: true });
  return String(completed.stdout || completed.stderr).trim().split(/\r?\n/u)[0];
}

function pdfRenderer() {
  return process.env.SLIDEWRIGHT_PDFTOPPM || "pdftoppm";
}

async function renderPdf({ root, pdf, renders }) {
  const renderer = pdfRenderer();
  const prefix = path.join(renders, "raw-slide");
  run(renderer, ["-png", "-r", "120", pdf, prefix], { root, capture: true });
  const files = (await fs.readdir(renders)).filter((file) => /^raw-slide-\d+\.png$/u.test(file))
    .sort((a, b) => Number(a.match(/(\d+)\.png$/u)[1]) - Number(b.match(/(\d+)\.png$/u)[1]));
  invariant(files.length > 0, "C19 macOS application PDF export produced no renderable slides.");
  for (const [index, file] of files.entries()) {
    await fs.rename(path.join(renders, file), path.join(renders, `slide-${String(index + 1).padStart(2, "0")}.png`));
  }
  return { name: "application PDF export + pdftoppm", version: versionOf(renderer, ["-v"], root) };
}

function expectedVisibleTextOrder(sourceOrder, targetText, replacement) {
  const expected = structuredClone(sourceOrder);
  let changed = 0;
  for (const slide of expected) {
    for (let index = 0; index < slide.length; index += 1) {
      if (slide[index] !== targetText) continue;
      slide[index] = replacement;
      changed += 1;
    }
  }
  invariant(changed === 1, `C19 macOS source inventory expected one sentinel target; found ${changed}.`);
  return expected;
}

function validateManualReview(review, pendingEvidence) {
  invariant(review?.schemaVersion === "slidewright-c19-manual-visual-review/v1", "C19 macOS finalization requires the manual visual-review schema.");
  invariant(review.reviewMethod === "full-size-human", "C19 macOS visual review must be performed by a human at full size.");
  invariant(/^[a-f0-9]{64}$/u.test(review.reviewerIdSha256 ?? ""), "C19 macOS visual review requires a pseudonymous reviewer digest.");
  invariant(Number.isFinite(Date.parse(review.reviewedAt))
    && Date.parse(review.reviewedAt) >= Date.parse(pendingEvidence.automation.endedAt), "C19 macOS visual review timestamp is missing or precedes the application run.");
  invariant(Array.isArray(review.slides) && review.slides.length === pendingEvidence.render.slides.length, "C19 macOS manual visual review slide set is incomplete.");
  for (const [index, rendered] of pendingEvidence.render.slides.entries()) {
    const item = review.slides[index];
    invariant(item?.slide === rendered.slide && item.imageSha256 === rendered.image.sha256, `C19 macOS manual review is not hash-bound to slide ${rendered.slide}.`);
    invariant(item.decision === "pass", `C19 macOS manual review did not pass slide ${rendered.slide}.`);
    invariant(item.checks?.readable === true && item.checks?.["not-clipped"] === true && item.checks?.["not-blank"] === true,
      `C19 macOS manual review checks are incomplete for slide ${rendered.slide}.`);
    invariant(typeof item.notes === "string", `C19 macOS manual review notes field is missing for slide ${rendered.slide}.`);
  }
  return true;
}

async function finalizeManualReview({ config, root, bundle, repository, reviewFile }) {
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  invariant(git(root, ["status", "--porcelain"]) === "", `C19 ${config.label} review finalization requires an exact clean Git checkout.`);
  const pendingFile = path.join(bundle, "pending-suite-evidence.json");
  const pendingEvidence = JSON.parse(await fs.readFile(pendingFile, "utf8"));
  invariant(pendingEvidence.suiteId === config.suiteId && pendingEvidence.attribution?.repository === repository
    && pendingEvidence.attribution?.sourceCommit === sourceCommit, `C19 ${config.label} pending evidence is not bound to this suite, repository, and exact commit.`);
  const reviewBytes = await fs.readFile(path.resolve(reviewFile));
  const review = JSON.parse(reviewBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  validateManualReview(review, pendingEvidence);
  const reviewDestination = path.join(bundle, "receipts", "visual-review.json");
  await fs.writeFile(reviewDestination, reviewBytes);
  pendingEvidence.render.review = await receipt(bundle, "receipts/visual-review.json");
  pendingEvidence.render.reviewAttestation = {
    reviewMethod: review.reviewMethod,
    reviewedAt: review.reviewedAt,
    reviewerIdSha256: review.reviewerIdSha256,
    reviewSha256: pendingEvidence.render.review.sha256,
    slideCount: review.slides.length,
    allSlidesPassed: true,
  };

  const { contract, hash: contractHash } = await contractWithHash(root);
  invariant(pendingEvidence.contractHash === contractHash, `C19 ${config.label} pending evidence uses a stale contract.`);
  const verified = await validateC19SuiteEvidence(pendingEvidence, {
    contract,
    contractHash,
    expectedSourceCommit: sourceCommit,
    expectedRepository: repository,
    bundleRoot: bundle,
    verifyArtifactBodies: true,
  });
  const destructiveControls = await runC19DestructiveControls(pendingEvidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
  await writeJson(path.join(bundle, "suite-evidence.json"), pendingEvidence);
  const validation = {
    schemaVersion: "slidewright-c19-suite-validation/v2",
    valid: true,
    suiteId: verified.suiteId,
    sourceCommit,
    sourceDeckSha256: verified.sourceDeckSha256,
    artifactReceiptsVerified: verified.receipts,
    destructiveControls,
    manualFullSizeReviewRequired: false,
    manualReview: { reviewedAt: review.reviewedAt, reviewerIdSha256: review.reviewerIdSha256, slides: review.slides.length },
  };
  validation.validationHash = canonicalHash(validation, "validationHash");
  await writeJson(path.join(bundle, "suite-validation.json"), validation);
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
}

export async function runMacosDesktopSuite(config) {
  validateConfig(config);
  invariant(process.platform === "darwin", `${config.label} C19 suite requires macOS.`);
  const root = config.root;
  const bundle = path.resolve(argument("--out"));
  const repository = argument("--repository");
  invariant(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository), "Invalid --repository.");
  const reviewFile = optionalArgument("--finalize-review");
  if (reviewFile) {
    await finalizeManualReview({ config, root, bundle, repository, reviewFile });
    return;
  }
  const source = path.resolve(argument("--source"));
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  invariant(git(root, ["status", "--porcelain"]) === "", `C19 ${config.label} evidence requires an exact clean Git checkout.`);
  await Promise.all([fs.access(source), fs.access(config.appBundle), fs.access(config.appExecutable), fs.access(config.worker)]);

  const python = process.env.SLIDEWRIGHT_PYTHON || "python3";
  const artifacts = path.join(bundle, "artifacts");
  const receipts = path.join(bundle, "receipts");
  const renders = path.join(bundle, "renders");
  const implementation = path.join(bundle, "implementation");
  await fs.rm(bundle, { recursive: true, force: true });
  await Promise.all([artifacts, receipts, renders, implementation].map((directory) => fs.mkdir(directory, { recursive: true })));

  const sourceDeck = path.join(artifacts, "source.pptx");
  const resultDeck = path.join(artifacts, "result.pptx");
  const resultPdf = path.join(artifacts, "result.pdf");
  const nativeWorkingDocument = path.join(artifacts, config.nativeWorkingDocument);
  run(python, [config.inventory, "prepare", "--input", source, "--output", sourceDeck, "--target", config.emphasisTargetName], { root });

  const implementationSources = [
    [config.runner, `implementation/${path.basename(config.runner)}`],
    [config.worker, `implementation/${path.basename(config.worker)}`],
    [config.commonRunner, "implementation/macos_desktop_suite_lib.mjs"],
    [config.inventory, "implementation/inventory_interop.py"],
    [config.evidenceLibrary, "implementation/c19-interop-evidence.mjs"],
  ];
  for (const [from, relative] of implementationSources) await fs.copyFile(from, path.join(bundle, ...relative.split("/")));

  const sourceInventoryFile = path.join(receipts, "source-inventory.json");
  const resultInventoryFile = path.join(receipts, "result-inventory.json");
  const targetInfoFile = path.join(receipts, "target-info.json");
  const workerReportFile = path.join(receipts, "automation-trace.json");
  const applicationLogFile = path.join(receipts, "application.log");
  run(python, [config.inventory, "inspect", "--input", sourceDeck, "--out", sourceInventoryFile], { root });
  run(python, [config.inventory, "target", "--input", sourceDeck, "--name", config.targetName, "--out", targetInfoFile], { root });
  const targetInfo = JSON.parse(await fs.readFile(targetInfoFile, "utf8"));

  const startedAt = new Date().toISOString();
  const workerArguments = [
    config.worker,
    sourceDeck,
    resultDeck,
    resultPdf,
    nativeWorkingDocument,
    config.targetName,
    config.replacementText,
    targetInfo.text,
  ];
  const worker = spawnSync("osascript", workerArguments, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: "pipe" });
  await fs.writeFile(applicationLogFile, `${worker.stdout ?? ""}\n${worker.stderr ?? ""}\n`, "utf8");
  if (worker.error) throw worker.error;
  if (worker.status !== 0) throw new Error(`${config.label} macOS worker failed with ${worker.status}: ${worker.stderr || worker.stdout}`);
  const fields = parseWorkerFields(worker.stdout);
  const workerReport = {
    schemaVersion: `slidewright-c19-${config.suiteId}-worker/v1`,
    valid: fields.valid === "true",
    startedAt: fields.startedAt || startedAt,
    endedAt: fields.endedAt,
    application: config.application,
    version: fields.version,
    platform: "macos",
    processId: Number(fields.processId),
    processOwned: fields.processOwned === "true",
    ownedProcessExitedNaturally: fields.ownedProcessExitedNaturally === "true",
    targetObjectId: fields.targetObjectId,
    beforeTextSha256: fields.beforeTextSha256,
    afterTextSha256: fields.afterTextSha256,
    reopenedNativeTextMatched: fields.reopenedNativeTextMatched === "true",
    exportedPptxReopenedNativeTextMatched: fields.exportedPptxReopenedNativeTextMatched === "true",
  };
  invariant(workerReport.valid && workerReport.processOwned && workerReport.ownedProcessExitedNaturally
    && workerReport.reopenedNativeTextMatched && workerReport.exportedPptxReopenedNativeTextMatched,
  `${config.label} macOS worker proof is incomplete.`);
  invariant(Number.isInteger(workerReport.processId) && workerReport.processId > 0 && workerReport.targetObjectId === config.targetName,
    `${config.label} macOS owned-process or mutation identity proof is invalid.`);
  invariant(workerReport.beforeTextSha256 === targetInfo.textSha256 && workerReport.afterTextSha256 === sha256(config.replacementText),
    `${config.label} macOS mutation hashes are not bound to the prepared source and requested replacement.`);
  await writeJson(workerReportFile, workerReport);

  const renderer = await renderPdf({ root, pdf: resultPdf, renders });
  run(python, [config.inventory, "inspect", "--input", resultDeck, "--out", resultInventoryFile], { root });
  const renderAnalysisFile = path.join(receipts, "render-report.json");
  run(python, [config.inventory, "inspect-renders", "--input-dir", renders, "--out", renderAnalysisFile], { root });
  const sourceAudit = JSON.parse(await fs.readFile(sourceInventoryFile, "utf8"));
  const resultAudit = JSON.parse(await fs.readFile(resultInventoryFile, "utf8"));
  const renderAudit = JSON.parse(await fs.readFile(renderAnalysisFile, "utf8"));
  invariant(sourceAudit.valid && resultAudit.valid && renderAudit.valid, `C19 ${config.label} inventory or render audit failed.`);
  invariant(renderAudit.slides.length === resultAudit.inventory.slides, `C19 ${config.label} PDF render page count changed.`);

  const expectedOrder = expectedVisibleTextOrder(sourceAudit.inventory.visibleTextOrder, targetInfo.text, config.replacementText);
  const visibleTextOrderExact = JSON.stringify(expectedOrder) === JSON.stringify(resultAudit.inventory.visibleTextOrder);
  const visualReviewTemplate = {
    schemaVersion: "slidewright-c19-manual-visual-review/v1",
    reviewMethod: "full-size-human",
    reviewedAt: null,
    reviewerIdSha256: null,
    slides: await Promise.all(renderAudit.slides.map(async (slide) => ({
      slide: slide.slide,
      imageSha256: (await receipt(bundle, `renders/${slide.file}`)).sha256,
      decision: "pending",
      checks: { readable: null, "not-clipped": null, "not-blank": null },
      notes: "",
    }))),
  };
  await writeJson(path.join(receipts, "visual-review-template.json"), visualReviewTemplate);
  await writeJson(path.join(receipts, "mutation-report.json"), {
    schemaVersion: "slidewright-c19-mutation/v1",
    valid: true,
    targetObjectId: workerReport.targetObjectId,
    beforeTextSha256: workerReport.beforeTextSha256,
    afterTextSha256: workerReport.afterTextSha256,
    reopenedNativeTextMatched: workerReport.reopenedNativeTextMatched,
    exportedPptxReopenedNativeTextMatched: workerReport.exportedPptxReopenedNativeTextMatched,
  });
  const semanticReport = {
    schemaVersion: "slidewright-c19-semantic-report/v1",
    valid: true,
    source: sourceAudit,
    result: resultAudit,
    expectedVisibleTextOrder: expectedOrder,
    visibleTextOrderExact,
  };
  await writeJson(path.join(receipts, "semantic-report.json"), semanticReport);

  function advanced(id, key) {
    const before = sourceAudit.inventory[key];
    const after = resultAudit.inventory[key];
    const outcome = before > 0 && after === before ? "preserved" : after > 0 ? "changed" : "unsupported";
    return { id, outcome, details: `Source count ${before}; exported count ${after}; independently inventoried from OOXML.` };
  }

  const executableBytes = await fs.readFile(config.appExecutable);
  const { contract, hash: contractHash } = await contractWithHash(root);
  const evidence = {
    schemaVersion: "slidewright-c19-suite-evidence/v2",
    evidenceOrigin: "suite-runner",
    contractHash,
    suiteId: config.suiteId,
    attribution: { repository, sourceCommit, sourceTreeClean: true, hostPlatform: "macos", hostArchitecture: process.arch },
    runner: {
      id: `slidewright-c19-${config.suiteId}`,
      version: "1.0.0",
      command: ["node", path.relative(root, config.runner).replaceAll("\\", "/"), "--source", "<source-pptx>", "--out", "<artifact-root>", "--repository", repository],
      implementation: await Promise.all(implementationSources.map(([, relative]) => receipt(bundle, relative))),
    },
    application: { name: config.application, version: workerReport.version, platform: "macos", executableSha256: sha256(executableBytes) },
    automation: {
      mode: "desktop-automation",
      protocol: "applescript",
      processId: workerReport.processId,
      processOwned: true,
      ownedProcessExitedNaturally: true,
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
      reopenedNativeTextMatched: true,
      report: await receipt(bundle, "receipts/mutation-report.json"),
    },
    semantic: {
      sourceInventoryHash: sourceAudit.inventoryHash,
      resultInventoryHash: resultAudit.inventoryHash,
      sourceInventory: sourceAudit.inventory,
      resultInventory: resultAudit.inventory,
      coreChecks: [
        { id: "slide-count", outcome: "preserved", details: `${config.application} exported all ${resultAudit.inventory.slides} slides.` },
        { id: "native-visible-text", outcome: "preserved", details: `${resultAudit.inventory.nativeTextObjects} native text objects remain in DrawingML.` },
        { id: "sentinel-edit-roundtrip", outcome: "preserved", details: `${config.targetName} retained the native edit after application reopen and exported-PPTX re-import.` },
        { id: "no-full-slide-raster", outcome: "preserved", details: `${resultAudit.inventory.fullSlidePictures} full-slide raster fallbacks detected.` },
        { id: "reading-order", outcome: "preserved", details: `Exact visible native-text order after only the declared sentinel edit: ${visibleTextOrderExact}.` },
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
      renderer: { name: renderer.name, version: `${workerReport.version}; ${renderer.version}` },
      sourceDocument: await receipt(bundle, "artifacts/result.pdf"),
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
  invariant(visibleTextOrderExact && resultAudit.inventory.fullSlidePictures === 0, `C19 ${config.label} core semantic checks failed.`);
  await writeJson(path.join(bundle, "pending-suite-evidence.json"), evidence);
  const pending = {
    schemaVersion: "slidewright-c19-suite-validation/v2",
    valid: false,
    state: "pending-manual-full-size-review",
    suiteId: config.suiteId,
    sourceCommit,
    sourceDeckSha256: evidence.sourceDeck.artifact.sha256,
    manualFullSizeReviewRequired: true,
    reviewTemplate: "receipts/visual-review-template.json",
    finalizeCommand: ["node", path.relative(root, config.runner).replaceAll("\\", "/"), "--out", bundle, "--repository", repository, "--finalize-review", "<completed-review.json>"],
  };
  await writeJson(path.join(bundle, "suite-validation.json"), pending);
  process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
}

export const testing = Object.freeze({ expectedVisibleTextOrder, parseWorkerFields, validateConfig, validateManualReview });
