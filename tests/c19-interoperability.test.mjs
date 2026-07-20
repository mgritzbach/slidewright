import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importC19Evidence } from "../scripts/import-c19-evidence.mjs";
import {
  C19_REQUIRED_SUITES,
  contractWithHash,
  matrixArtifactNames,
  runC19DestructiveControls,
  sha256,
  validateC19SuiteEvidence,
  verifyPublishedC19Evidence,
} from "../scripts/lib/c19-interop-evidence.mjs";

const root = process.cwd();
const sourceCommit = "1".repeat(40);
const repository = "example/slidewright";

function receipt(pathname, contents = pathname) {
  const bytes = Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, "utf8");
  return { path: pathname, byteLength: bytes.length, sha256: sha256(bytes), contents: bytes };
}

function pptxBytes(label) {
  return Buffer.from(`PK\u0003\u0004${label}\n[Content_Types].xml\nppt/presentation.xml\n`, "utf8");
}

function suiteEvidence(suite, contractHash, { sourceContents = "one exact C19 source deck", proofMode = null, unsupportedCharts = false } = {}) {
  const source = receipt("artifacts/source.pptx", pptxBytes(sourceContents));
  const result = receipt("artifacts/result.pptx", pptxBytes(`${suite.id} result deck`));
  const plain = (name) => receipt(`receipts/${name}`, `${suite.id}/${name}`);
  const implementation = plain("runner.mjs");
  const selectedProof = suite.proofMode
    ? { mode: suite.proofMode, automationProtocol: suite.automationProtocol, requiresAuthenticatedSession: suite.requiresAuthenticatedSession, serviceOrigins: suite.serviceOrigins }
    : suite.proofModes.find((item) => item.mode === (proofMode ?? "browser-automation"));
  const sourceInventory = { slides: 2, nativeTextObjects: 4, mixedEmphasisObjects: 1, tables: 1, charts: 1, groups: 1, connectors: 1, attachedConnectors: 1 };
  const resultInventory = { slides: 2, nativeTextObjects: 4, mixedEmphasisObjects: 1, tables: 1, charts: unsupportedCharts ? 0 : 1, groups: 1, connectors: 1, attachedConnectors: 1 };
  const sourceInventoryHash = sha256(JSON.stringify(Object.fromEntries(Object.entries(sourceInventory).sort())));
  const resultInventoryHash = sha256(JSON.stringify(Object.fromEntries(Object.entries(resultInventory).sort())));
  const evidence = {
    schemaVersion: "slidewright-c19-suite-evidence/v2",
    evidenceOrigin: "suite-runner",
    contractHash,
    suiteId: suite.id,
    attribution: {
      repository,
      sourceCommit,
      sourceTreeClean: true,
      hostPlatform: suite.platform === "web" ? "linux" : suite.platform === "any-desktop" ? "windows" : suite.platform,
      hostArchitecture: "x64",
    },
    runner: {
      id: `slidewright-${suite.id}-adapter`,
      version: "1.0.0",
      command: ["node", `run-${suite.id}.mjs`],
      implementation: [implementation],
    },
    application: {
      name: suite.application,
      version: "1.2.3",
      platform: suite.platform === "any-desktop" ? "windows" : suite.platform,
      ...(selectedProof.mode === "desktop-automation"
        ? { executableSha256: sha256(`${suite.id}/executable`) }
        : { serviceOrigins: selectedProof.serviceOrigins }),
    },
    automation: {
      mode: selectedProof.mode,
      protocol: selectedProof.automationProtocol,
      startedAt: "2026-07-18T00:00:00.000Z",
      endedAt: "2026-07-18T00:01:00.000Z",
      applicationLog: plain("application.log"),
      trace: plain("automation-trace.zip"),
      ...(selectedProof.mode === "desktop-automation"
        ? { processId: 4123 }
        : { browser: { name: "Chromium", version: "140.0.0" } }),
    },
    sourceDeck: { artifact: source, slideCount: 2, inventoryHash: sourceInventoryHash },
    resultDeck: { artifact: result, slideCount: 2, inventoryHash: resultInventoryHash },
    operation: { opened: true, imported: true, saved: true, reopened: true, exported: true },
    mutation: {
      kind: "native-text-sentinel",
      targetObjectId: "slide-1/title",
      beforeSha256: sha256("before"),
      afterSha256: sha256("after"),
      reopenedNativeTextMatched: true,
      report: plain("mutation.json"),
    },
    semantic: {
      sourceInventoryHash,
      resultInventoryHash,
      sourceInventory,
      resultInventory,
      coreChecks: ["slide-count", "native-visible-text", "sentinel-edit-roundtrip", "no-full-slide-raster", "reading-order"].map((id) => ({ id, outcome: "preserved", details: `${id} was measured by the suite adapter.` })),
      advancedChecks: ["mixed-emphasis", "native-table", "native-chart", "native-group", "attached-connectors"].map((id) => ({ id, outcome: id === "native-chart" && unsupportedCharts ? "unsupported" : "preserved", details: `${id} outcome was derived from the exported-deck inventory.` })),
      report: plain("semantic.json"),
    },
    render: {
      renderer: { name: suite.application, version: "1.2.3" },
      report: plain("render.json"),
      review: plain("visual-review.json"),
      slides: [1, 2].map((slide) => ({
        slide,
        widthPixels: 1600,
        heightPixels: 900,
        checks: { readable: true, "not-clipped": true, "not-blank": true },
        image: plain(`slide-${slide}.png`),
      })),
    },
  };
  if (selectedProof.mode === "browser-automation" && selectedProof.requiresAuthenticatedSession) {
    evidence.automation.authenticated = true;
    evidence.automation.authentication = { type: "browser-session", principalSha256: sha256("browser-principal") };
  }
  if (selectedProof.mode === "authenticated-service-automation") {
    const resourceIdSha256 = sha256("google-resource");
    const beforeRevisionIdSha256 = sha256("before-revision");
    const afterRevisionIdSha256 = sha256("after-revision");
    const discovery = selectedProof.requiredApis.map((api) => ({ ...api, revision: "20260713", artifact: plain(`${api.id.replace(":", "-")}-discovery.json`) }));
    const serviceTrace = {
      authenticated: true,
      resourceIdSha256,
      beforeRevisionIdSha256,
      afterRevisionIdSha256,
      operations: selectedProof.requiredOperationSequence.map((operation, index) => ({
        ...operation,
        status: 200,
        resourceIdSha256,
        requestSha256: sha256(`${operation.id}/request`),
        responseSha256: sha256(`${operation.id}/response`),
        startedAt: `2026-07-18T00:00:0${index}.000Z`,
        endedAt: `2026-07-18T00:00:0${index}.500Z`,
        ...(operation.id === "native-edit" ? { requiredRevisionIdSha256: beforeRevisionIdSha256 } : {}),
        ...(operation.id === "reopen-after" ? { revisionIdSha256: afterRevisionIdSha256 } : {}),
      })),
    };
    evidence.application.version = discovery.map((item) => `${item.id}@${item.revision}`).join("+");
    evidence.application.versionKind = "api-discovery-revision";
    evidence.application.serviceBuildExposed = false;
    delete evidence.automation.browser;
    evidence.automation.authenticated = true;
    evidence.automation.authentication = {
      type: "oauth2-user",
      principalSha256: sha256("principal"),
      scopes: [selectedProof.acceptedWriteScopes[0]],
      resourceIdSha256,
    };
    evidence.automation.discovery = discovery;
    evidence.automation.serviceTrace = serviceTrace;
    evidence.automation.captureManifest = plain("capture-manifest.json");
    evidence.automation.snapshots = [plain("before.json"), plain("update.json"), plain("after.json")];
    evidence.render.sourceDocument = receipt("exports/result.pdf", "%PDF-1.7\nfixture");
    evidence.render.renderer.version = evidence.application.version;
  }
  const receiptValues = [
    evidence.runner.implementation[0], evidence.automation.applicationLog, evidence.automation.trace,
    evidence.sourceDeck.artifact, evidence.resultDeck.artifact, evidence.mutation.report,
    evidence.semantic.report, evidence.render.report, evidence.render.review, ...evidence.render.slides.map((item) => item.image),
    ...(evidence.render.sourceDocument ? [evidence.render.sourceDocument] : []),
    ...(evidence.automation.captureManifest ? [evidence.automation.captureManifest] : []),
    ...(evidence.automation.discovery ?? []).map((item) => item.artifact),
    ...(evidence.automation.snapshots ?? []),
  ];
  const files = receiptValues.map((item) => ({ ...item, contents: item.contents }));
  for (const item of receiptValues) delete item.contents;
  return { evidence, files };
}

async function materializeBundle(directory, built) {
  for (const original of built.files) {
    await fs.mkdir(path.dirname(path.join(directory, original.path)), { recursive: true });
    await fs.writeFile(path.join(directory, original.path), original.contents);
  }
  await fs.writeFile(path.join(directory, "suite-evidence.json"), `${JSON.stringify(built.evidence, null, 2)}\n`, "utf8");
}

test("C19 contract freezes all six target suites and honest advanced outcomes", async () => {
  const { contract } = await contractWithHash(root);
  assert.deepEqual(contract.requiredSuites.map((item) => item.id), C19_REQUIRED_SUITES);
  assert.deepEqual(contract.allowedAdvancedOutcomes, ["preserved", "changed", "unsupported"]);
  assert.equal(contract.publication.requiresAllSuites, true);
  assert.equal(contract.publication.requiresOneExactSourceDeckAcrossSuites, true);
  const google = contract.requiredSuites.find((item) => item.id === "google-slides");
  assert.ok(google.proofModes.some((item) => item.mode === "authenticated-service-automation"));
  const schema = JSON.parse(await fs.readFile(path.join(root, "schemas", "c19-interop-suite-v2.schema.json"), "utf8"));
  assert.equal(schema.properties.evidenceOrigin.const, "suite-runner");
});

test("C19 validates automation-bound suite evidence and rejects eight destructive controls", async () => {
  const { contract, hash: contractHash } = await contractWithHash(root);
  for (const suite of contract.requiredSuites) {
    const { evidence } = suiteEvidence(suite, contractHash);
    const verified = await validateC19SuiteEvidence(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
    assert.equal(verified.suiteId, suite.id);
    assert.equal(verified.receipts, 11);
    const controls = await runC19DestructiveControls(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
    assert.equal(controls.length, 8);
    assert.ok(controls.every((item) => item.rejected));
  }
});

test("C19 accepts revision-bound authenticated Google service automation and reports Office charts unsupported", async () => {
  const { contract, hash: contractHash } = await contractWithHash(root);
  const suite = contract.requiredSuites.find((item) => item.id === "google-slides");
  const { evidence } = suiteEvidence(suite, contractHash, { proofMode: "authenticated-service-automation", unsupportedCharts: true });
  const verified = await validateC19SuiteEvidence(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
  assert.equal(verified.suiteId, "google-slides");
  assert.equal(evidence.semantic.advancedChecks.find((item) => item.id === "native-chart").outcome, "unsupported");
  const controls = await runC19DestructiveControls(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
  assert.equal(controls.length, 14);
  assert.ok(controls.every((item) => item.rejected));

  const extraScope = structuredClone(evidence);
  extraScope.automation.authentication.scopes.push("https://www.googleapis.com/auth/gmail.readonly");
  await assert.rejects(() => validateC19SuiteEvidence(extraScope, { contract, contractHash }), /scope allowlist/u);

  const overlappingTrace = structuredClone(evidence);
  overlappingTrace.automation.serviceTrace.operations[1].startedAt = overlappingTrace.automation.serviceTrace.operations[0].startedAt;
  await assert.rejects(() => validateC19SuiteEvidence(overlappingTrace, { contract, contractHash }), /overlaps or precedes/u);
});

test("C19 rejects self-reports, unknown versions, partial semantics, and unbound artifact bodies", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c19-suite-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { contract, hash: contractHash } = await contractWithHash(root);
  const built = suiteEvidence(contract.requiredSuites[0], contractHash);
  await materializeBundle(directory, built);
  await validateC19SuiteEvidence(built.evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository, bundleRoot: directory, verifyArtifactBodies: true });

  const selfReport = structuredClone(built.evidence); selfReport.evidenceOrigin = "self-report";
  await assert.rejects(() => validateC19SuiteEvidence(selfReport, { contract, contractHash }), /rejects self-reports/u);
  const unknown = structuredClone(built.evidence); unknown.application.version = "unknown";
  await assert.rejects(() => validateC19SuiteEvidence(unknown, { contract, contractHash }), /version is missing/u);
  const incomplete = structuredClone(built.evidence); incomplete.semantic.coreChecks.pop();
  await assert.rejects(() => validateC19SuiteEvidence(incomplete, { contract, contractHash }), /check count is incomplete/u);
  const inventoryTamper = structuredClone(built.evidence); inventoryTamper.semantic.sourceInventory.nativeTextObjects += 1;
  await assert.rejects(() => validateC19SuiteEvidence(inventoryTamper, { contract, contractHash }), /inventory hash does not match/u);
  await fs.writeFile(path.join(directory, built.evidence.render.slides[0].image.path), "tampered", "utf8");
  await assert.rejects(() => validateC19SuiteEvidence(built.evidence, { contract, contractHash, bundleRoot: directory, verifyArtifactBodies: true }), /artifact bytes drifted/u);
});

test("C19 importer refuses partial GitHub matrices and publishes a fully bound six-suite matrix", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c19-import-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "download");
  const published = path.join(directory, "published");
  const artifactsFile = path.join(directory, "artifacts.json");
  const { contract, hash: contractHash } = await contractWithHash(root);
  for (const suite of contract.requiredSuites) {
    const bundle = path.join(input, `slidewright-c19-${suite.id}-${sourceCommit}`);
    await fs.mkdir(bundle, { recursive: true });
    await materializeBundle(bundle, suiteEvidence(suite, contractHash));
  }
  const artifacts = matrixArtifactNames(sourceCommit).map((name, index) => ({ id: index + 1, name, size_in_bytes: 1000 + index, digest: `sha256:${sha256(name)}` }));
  await fs.writeFile(artifactsFile, JSON.stringify({ artifacts: artifacts.slice(0, -1) }), "utf8");
  await assert.rejects(() => importC19Evidence({ root, input, artifactsFile, runId: "12345", sourceCommit, repository, published, enforceCheckout: false }), /artifact metadata is missing/u);

  await fs.writeFile(artifactsFile, JSON.stringify({ artifacts }), "utf8");
  const result = await importC19Evidence({ root, input, artifactsFile, runId: "12345", sourceCommit, repository, published, enforceCheckout: false });
  assert.equal(result.valid, true);
  assert.equal(result.suites.length, 6);
  assert.equal(result.destructiveControls, 48);
  assert.equal(result.artifactBodiesCommitted, false);
  const reverified = await verifyPublishedC19Evidence({ root, published });
  assert.equal(reverified.scorecardHash, result.scorecardHash);

  const pointer = JSON.parse(await fs.readFile(path.join(published, "current.json"), "utf8"));
  const suiteFile = path.join(published, pointer.run, "suites", "canva.json");
  const tampered = JSON.parse(await fs.readFile(suiteFile, "utf8"));
  tampered.evidenceOrigin = "self-report";
  await fs.writeFile(suiteFile, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  await assert.rejects(() => verifyPublishedC19Evidence({ root, published }), /bytes drifted|self-reports/u);
});

test("C19 importer rejects a mixed source-deck matrix", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c19-mixed-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "download");
  const artifactsFile = path.join(directory, "artifacts.json");
  const { contract, hash: contractHash } = await contractWithHash(root);
  for (const [index, suite] of contract.requiredSuites.entries()) {
    const bundle = path.join(input, `slidewright-c19-${suite.id}-${sourceCommit}`);
    await fs.mkdir(bundle, { recursive: true });
    await materializeBundle(bundle, suiteEvidence(suite, contractHash, { sourceContents: index === 5 ? "a different source deck" : "one exact C19 source deck" }));
  }
  const artifacts = matrixArtifactNames(sourceCommit).map((name, index) => ({ id: index + 1, name, size_in_bytes: 1000 + index, digest: `sha256:${sha256(name)}` }));
  await fs.writeFile(artifactsFile, JSON.stringify(artifacts), "utf8");
  await assert.rejects(() => importC19Evidence({ root, input, artifactsFile, runId: "12345", sourceCommit, repository, published: path.join(directory, "published"), enforceCheckout: false }), /one exact source deck/u);
});

test("C19 PowerPoint Windows adapter owns an isolated application and performs a native edit", async () => {
  const worker = await fs.readFile(path.join(root, "scripts", "c19", "powerpoint_windows_worker.ps1"), "utf8");
  const runner = await fs.readFile(path.join(root, "scripts", "c19", "run_powerpoint_windows_suite.mjs"), "utf8");
  assert.match(worker, /requires PowerPoint to be fully closed/u);
  assert.match(worker, /\/AUTOMATION/u);
  assert.match(worker, /TextFrame2\.TextRange\.Text = \$replacement/u);
  assert.match(worker, /SaveAs\(\$outputPath, 24\)/u);
  assert.match(worker, /native sentinel text did not survive save and reopen/u);
  assert.match(worker, /\.Export\(\$file, 'PNG', 1600, 900\)/u);
  assert.doesNotMatch(worker, /Stop-Process|\.Kill\s*\(/u);
  assert.match(runner, /git\(\["status", "--porcelain"\]\) !== ""/u);
  assert.match(runner, /verifyArtifactBodies: true/u);
  assert.match(runner, /runC19DestructiveControls/u);
});

test("C19 LibreOffice adapter owns an isolated UNO process and performs a native edit", async () => {
  const worker = await fs.readFile(path.join(root, "scripts", "c19", "LibreOfficeUnoWorker.java"), "utf8");
  const runner = await fs.readFile(path.join(root, "scripts", "c19", "run_libreoffice_suite.mjs"), "utf8");
  assert.match(runner, /requires LibreOffice to be fully closed/u);
  assert.match(runner, /--accept=socket,host=127\.0\.0\.1/u);
  assert.match(runner, /ownedProcessExitedNaturally: true/u);
  assert.doesNotMatch(runner, /taskkill|Stop-Process|\.kill\s*\(/iu);
  assert.match(worker, /targetText\.setString\(replacement\)/u);
  assert.match(worker, /Impress MS PowerPoint 2007 XML/u);
  assert.match(worker, /UnoRuntime\.queryInterface\(XCloseable\.class, document\)/u);
  assert.match(worker, /closeable\.close\(true\)/u);
  assert.doesNotMatch(worker, /close\(source\);\s*source = null;\s*reopened = load/u);
  assert.match(worker, /reopenedNativeTextMatched/u);
  assert.match(worker, /impress_pdf_Export/u);
  assert.match(runner, /verifyArtifactBodies: true/u);
  assert.match(runner, /runC19DestructiveControls/u);
});

test("C19 Google Slides importer is credential-free, revision-bound, and fails on collateral text edits", async () => {
  const runner = await fs.readFile(path.join(root, "scripts", "c19", "run_google_slides_suite.mjs"), "utf8");
  const inventory = await fs.readFile(path.join(root, "scripts", "c19", "inventory_interop.py"), "utf8");
  const captureSchema = JSON.parse(await fs.readFile(path.join(root, "schemas", "c19-google-slides-capture.schema.json"), "utf8"));
  assert.equal(captureSchema.properties.captureOrigin.const, "authenticated-google-service-automation");
  assert.match(runner, /C19 Google Slides evidence requires an exact clean Git checkout/u);
  assert.match(runner, /rejectSecretBearingCapture/u);
  assert.match(runner, /identity-bearing fields/u);
  assert.match(runner, /api-discovery-revision/u);
  assert.match(runner, /beforeRevisionIdSha256/u);
  assert.match(runner, /visibleTextOrder/u);
  assert.match(runner, /changed native visible-text reading order or made an undeclared text edit/u);
  assert.match(runner, /advanced\("native-chart", "charts"\)/u);
  assert.match(runner, /sourceDocument: manifest\.files\.resultPdf/u);
  assert.doesNotMatch(runner, /GOOGLE_APPLICATION_CREDENTIALS|Authorization:\s*Bearer|refreshToken/u);
  assert.match(inventory, /def drawingml_text/u);
  assert.match(inventory, /elif local == "br":\s+fragments\.append\("\\n"\)/u);
});
