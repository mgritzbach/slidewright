import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const C19_REQUIRED_SUITES = Object.freeze([
  "powerpoint-windows",
  "powerpoint-macos",
  "google-slides",
  "keynote-macos",
  "libreoffice",
  "canva",
]);

export const C19_IMPLEMENTATION_CLOSURE = Object.freeze([
  "docs/C19_INTEROPERABILITY.md",
  "docs/C19_MACOS_RUNNERS.md",
  "fixtures/interoperability/c19-v2/contract.json",
  "schemas/c19-browser-operation-evidence.schema.json",
  "schemas/c19-browser-trace.schema.json",
  "schemas/c19-canva-browser-capture.schema.json",
  "schemas/c19-google-slides-capture.schema.json",
  "schemas/c19-interop-suite-v2.schema.json",
  "scripts/c19/LibreOfficeUnoWorker.java",
  "scripts/c19/inventory_interop.py",
  "scripts/c19/keynote_macos_worker.applescript",
  "scripts/c19/macos_desktop_suite_lib.mjs",
  "scripts/c19/powerpoint_macos_worker.applescript",
  "scripts/c19/run_canva_suite.mjs",
  "scripts/c19/run_google_slides_suite.mjs",
  "scripts/c19/run_keynote_macos_suite.mjs",
  "scripts/c19/run_libreoffice_suite.mjs",
  "scripts/c19/run_powerpoint_macos_suite.mjs",
  "scripts/c19/powerpoint_windows_worker.ps1",
  "scripts/c19/run_powerpoint_windows_suite.mjs",
  "scripts/import-c19-evidence.mjs",
  "scripts/lib/c19-interop-evidence.mjs",
  "scripts/run-c19-interoperability-benchmark.mjs",
  "scripts/verify-c19-interop-evidence.mjs",
  "tests/c19-interoperability.test.mjs",
]);

const DIGEST = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto.createHash("sha256").update(Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8")).digest("hex");
}

export function containsBrowserCredentialMaterial(value) {
  const text = String(value);
  const prohibitedField = /"(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|authorization|cookie|cookies|password|email|user[_-]?email|principal[_-]?email|accountId|userId|designId|resourceId|localStorage|sessionStorage)"\s*:/iu;
  const credentialValue = /Bearer\s+[A-Za-z0-9._~-]{16,}|\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|https:\/\/www\.canva\.com\/design\//iu;
  return prohibitedField.test(text) || credentialValue.test(text);
}

export function canonicalHash(value, field) {
  const copy = structuredClone(value);
  if (field) delete copy[field];
  return sha256(stable(copy));
}

export async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

export function safeRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || path.isAbsolute(value)) return false;
  const parts = value.replaceAll("\\", "/").split("/");
  return !parts.includes("") && !parts.includes(".") && !parts.includes("..");
}

export function validateFileReceipt(receipt, label) {
  invariant(receipt && typeof receipt === "object", `${label}: receipt is missing.`);
  invariant(safeRelativePath(receipt.path), `${label}: receipt path must be confined and relative.`);
  invariant(Number.isInteger(receipt.byteLength) && receipt.byteLength > 0, `${label}: byte length is invalid.`);
  invariant(DIGEST.test(receipt.sha256 ?? ""), `${label}: SHA-256 is invalid.`);
  return receipt;
}

export async function verifyFileReceipt(bundleRoot, receipt, label) {
  validateFileReceipt(receipt, label);
  const file = path.resolve(bundleRoot, ...receipt.path.replaceAll("\\", "/").split("/"));
  const relative = path.relative(path.resolve(bundleRoot), file);
  invariant(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `${label}: receipt escaped its bundle.`);
  const bytes = await fs.readFile(file);
  invariant(bytes.length === receipt.byteLength && sha256(bytes) === receipt.sha256, `${label}: artifact bytes drifted.`);
  return true;
}

async function verifyPptxReceipt(bundleRoot, receipt, label) {
  invariant(/\.pptx$/iu.test(receipt.path ?? ""), `${label}: deck artifact must be a PPTX file.`);
  const bytes = await fs.readFile(path.join(bundleRoot, ...receipt.path.replaceAll("\\", "/").split("/")));
  invariant(bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && bytes.includes(Buffer.from("[Content_Types].xml", "utf8"))
    && bytes.includes(Buffer.from("ppt/presentation.xml", "utf8")), `${label}: artifact is not an identifiable PowerPoint package.`);
}

function suiteContract(contract, suiteId) {
  const suite = contract.requiredSuites?.find((item) => item.id === suiteId);
  invariant(suite, `C19 suite ${suiteId} is not in the frozen contract.`);
  return suite;
}

function proofContract(suite, mode) {
  if (typeof suite.proofMode === "string") {
    invariant(mode === suite.proofMode, `${suite.id}: automation mode mismatch.`);
    return {
      ...suite,
      mode: suite.proofMode,
      serviceOrigins: suite.serviceOrigins ?? (suite.serviceOrigin ? [suite.serviceOrigin] : []),
    };
  }
  const proof = suite.proofModes?.find((item) => item.mode === mode);
  invariant(proof, `${suite.id}: automation mode is not allowed by the frozen contract.`);
  return proof;
}

function validateInventory(inventory, minimum, label) {
  invariant(inventory && typeof inventory === "object", `${label}: inventory is missing.`);
  for (const [key, floor] of Object.entries(minimum)) {
    invariant(Number.isInteger(inventory[key]) && inventory[key] >= floor, `${label}: ${key} is below the fixture minimum.`);
  }
}

function validateChecks(actual, expectedIds, label, outcomes) {
  invariant(Array.isArray(actual) && actual.length === expectedIds.length, `${label}: check count is incomplete.`);
  const ids = actual.map((item) => item.id);
  invariant(new Set(ids).size === ids.length && expectedIds.every((id) => ids.includes(id)), `${label}: check identity set drifted.`);
  for (const item of actual) {
    invariant(outcomes.includes(item.outcome), `${label}/${item.id}: invalid outcome.`);
    invariant(typeof item.details === "string" && item.details.trim().length > 0, `${label}/${item.id}: observable details are required.`);
  }
}

function expectedAdvancedOutcome(before, after) {
  if (before > 0 && after === before) return "preserved";
  if (after > 0) return "changed";
  return "unsupported";
}

function validateAdvancedInventoryBindings(evidence, contract) {
  for (const check of evidence.semantic.advancedChecks) {
    const key = contract.advancedInventoryBindings?.[check.id];
    invariant(typeof key === "string" && key.length > 0, `${evidence.suiteId} advanced/${check.id}: inventory binding is missing.`);
    const before = evidence.semantic.sourceInventory[key];
    const after = evidence.semantic.resultInventory[key];
    invariant(Number.isInteger(before) && Number.isInteger(after), `${evidence.suiteId} advanced/${check.id}: bound inventory is missing.`);
    invariant(check.outcome === expectedAdvancedOutcome(before, after), `${evidence.suiteId} advanced/${check.id}: outcome contradicts the independent inventories.`);
  }
}

function collectReceipts(evidence) {
  const receipts = [
    ...evidence.runner.implementation.map((item, index) => [`runner implementation ${index + 1}`, item]),
    ["automation application log", evidence.automation.applicationLog],
    ["automation trace", evidence.automation.trace],
    ["source deck", evidence.sourceDeck.artifact],
    ["result deck", evidence.resultDeck.artifact],
    ["mutation report", evidence.mutation.report],
    ["semantic report", evidence.semantic.report],
    ["render report", evidence.render.report],
    ["visual review", evidence.render.review],
    ...evidence.render.slides.map((item) => [`render slide ${item.slide}`, item.image]),
  ];
  if (evidence.render.sourceDocument) receipts.push(["render source document", evidence.render.sourceDocument]);
  if (evidence.automation.captureManifest) receipts.push(["capture manifest", evidence.automation.captureManifest]);
  for (const [index, item] of (evidence.automation.browserEvidence ?? []).entries()) receipts.push([`browser operation evidence ${index + 1}`, item]);
  for (const [index, item] of (evidence.automation.discovery ?? []).entries()) receipts.push([`service discovery ${index + 1}`, item.artifact]);
  for (const [index, item] of (evidence.automation.snapshots ?? []).entries()) receipts.push([`service snapshot ${index + 1}`, item]);
  return receipts;
}

function validateBrowserLifecycle(evidence, proof) {
  invariant(JSON.stringify(proof.requiresExportFormats) === JSON.stringify(["pptx", "pdf"]), `${evidence.suiteId}: browser export-format contract drifted.`);
  invariant(evidence.application.versionKind === proof.versionKind && proof.versionKind === "web-client-fingerprint"
    && evidence.application.serviceBuildExposed === false, `${evidence.suiteId}: browser application version attribution is misleading or incomplete.`);
  invariant(DIGEST.test(evidence.application.clientBuildSha256 ?? "")
    && evidence.application.version === `web-client@${evidence.application.clientBuildSha256.slice(0, 16)}`, `${evidence.suiteId}: browser application version is not derived from the captured client fingerprint.`);
  invariant(evidence.render.sourceDocument && /\.pdf$/iu.test(evidence.render.sourceDocument.path ?? ""), `${evidence.suiteId}: browser-produced PDF render source is missing.`);
  invariant(evidence.automation.captureManifest, `${evidence.suiteId}: browser capture manifest is missing.`);

  const trace = evidence.automation.browserTrace;
  invariant(trace?.schemaVersion === "slidewright-c19-browser-trace/v1" && trace.authenticated === true, `${evidence.suiteId}: authenticated browser trace is invalid.`);
  invariant(trace.authentication?.type === "browser-session"
    && trace.authentication.principalSha256 === evidence.automation.authentication.principalSha256
    && DIGEST.test(trace.authentication.principalSha256 ?? ""), `${evidence.suiteId}: browser trace authentication binding is invalid.`);
  invariant(trace.browser?.name === evidence.automation.browser.name && trace.browser?.version === evidence.automation.browser.version, `${evidence.suiteId}: browser trace identity drifted.`);
  invariant(JSON.stringify(trace.serviceOrigins) === JSON.stringify(proof.serviceOrigins), `${evidence.suiteId}: browser trace service origin set drifted.`);
  invariant(trace.clientBuildSha256 === evidence.application.clientBuildSha256 && DIGEST.test(trace.clientBuildSha256 ?? ""), `${evidence.suiteId}: browser client-build fingerprint drifted.`);
  invariant(DIGEST.test(trace.resourceIdSha256 ?? "") && DIGEST.test(trace.beforeStateSha256 ?? "") && DIGEST.test(trace.afterStateSha256 ?? "")
    && trace.beforeStateSha256 !== trace.afterStateSha256, `${evidence.suiteId}: browser resource or before/after state binding is missing.`);
  invariant(trace.startedAt === evidence.automation.startedAt && trace.endedAt === evidence.automation.endedAt, `${evidence.suiteId}: browser trace timing is not bound to the evidence envelope.`);
  invariant(Array.isArray(trace.operations) && trace.operations.length === proof.requiredOperationSequence.length, `${evidence.suiteId}: browser operation sequence is incomplete.`);
  invariant(Array.isArray(evidence.automation.browserEvidence) && evidence.automation.browserEvidence.length === trace.operations.length, `${evidence.suiteId}: browser operation receipts are incomplete.`);

  let previousEndedAt = null;
  for (const [index, requiredId] of proof.requiredOperationSequence.entries()) {
    const operation = trace.operations[index];
    invariant(operation?.id === requiredId && operation.status === "succeeded", `${evidence.suiteId}: browser operation sequence drifted at ${requiredId}.`);
    invariant(operation.origin === proof.serviceOrigins[0] && operation.resourceIdSha256 === trace.resourceIdSha256, `${evidence.suiteId}: browser operation ${requiredId} is not origin/resource bound.`);
    invariant(Number.isFinite(Date.parse(operation.startedAt)) && Number.isFinite(Date.parse(operation.endedAt))
      && Date.parse(operation.endedAt) >= Date.parse(operation.startedAt), `${evidence.suiteId}: browser operation ${requiredId} timestamps are invalid.`);
    invariant(previousEndedAt === null || Date.parse(operation.startedAt) >= previousEndedAt, `${evidence.suiteId}: browser operation ${requiredId} overlaps or precedes the prior operation.`);
    previousEndedAt = Date.parse(operation.endedAt);
    validateFileReceipt(operation.evidence, `${evidence.suiteId} ${requiredId} evidence`);
    invariant(JSON.stringify(operation.evidence) === JSON.stringify(evidence.automation.browserEvidence[index]), `${evidence.suiteId}: browser operation ${requiredId} receipt is not bound to the capture.`);
  }

  const byId = new Map(trace.operations.map((item) => [item.id, item]));
  invariant(byId.get("open-before")?.stateSha256 === trace.beforeStateSha256, `${evidence.suiteId}: browser before-state receipt is missing.`);
  invariant(byId.get("native-edit")?.beforeStateSha256 === trace.beforeStateSha256
    && byId.get("native-edit")?.afterStateSha256 === trace.afterStateSha256, `${evidence.suiteId}: browser native edit is not state-bound.`);
  invariant(byId.get("reopen-after")?.stateSha256 === trace.afterStateSha256, `${evidence.suiteId}: browser reopened state does not bind the edit.`);
  invariant(byId.get("export-pptx")?.artifactSha256 === evidence.resultDeck.artifact.sha256, `${evidence.suiteId}: browser PPTX export receipt is unbound.`);
  invariant(byId.get("export-pdf")?.artifactSha256 === evidence.render.sourceDocument.sha256, `${evidence.suiteId}: browser PDF export receipt is unbound.`);
  invariant(byId.get("cleanup-delete")?.resourceDeleted === true, `${evidence.suiteId}: browser-created resource cleanup is unproven.`);
}

export async function contractWithHash(root) {
  const file = path.join(root, "fixtures", "interoperability", "c19-v2", "contract.json");
  const bytes = await fs.readFile(file);
  const contract = JSON.parse(bytes.toString("utf8"));
  invariant(contract.schemaVersion === "slidewright-c19-contract/v2", "C19 contract schema is invalid.");
  invariant(JSON.stringify(contract.requiredSuites.map((item) => item.id)) === JSON.stringify(C19_REQUIRED_SUITES), "C19 required suite order drifted.");
  return { contract, file, hash: sha256(bytes) };
}

export async function validateC19SuiteEvidence(evidence, {
  contract,
  contractHash,
  expectedSourceCommit = null,
  expectedRepository = null,
  bundleRoot = null,
  verifyArtifactBodies = false,
} = {}) {
  invariant(evidence?.schemaVersion === "slidewright-c19-suite-evidence/v2", "C19 suite evidence schema is invalid.");
  invariant(evidence.evidenceOrigin === "suite-runner", "C19 rejects self-reports; evidenceOrigin must be suite-runner.");
  invariant(evidence.contractHash === contractHash && DIGEST.test(evidence.contractHash ?? ""), "C19 suite evidence is bound to a stale or invalid contract.");
  const frozen = suiteContract(contract, evidence.suiteId);
  invariant(evidence.attribution?.sourceTreeClean === true, `${evidence.suiteId}: source tree was not clean.`);
  invariant(COMMIT.test(evidence.attribution?.sourceCommit ?? ""), `${evidence.suiteId}: exact source commit is missing.`);
  invariant(REPOSITORY.test(evidence.attribution?.repository ?? ""), `${evidence.suiteId}: repository attribution is invalid.`);
  if (expectedSourceCommit) invariant(evidence.attribution.sourceCommit === expectedSourceCommit, `${evidence.suiteId}: source commit mismatch.`);
  if (expectedRepository) invariant(evidence.attribution.repository === expectedRepository, `${evidence.suiteId}: repository mismatch.`);
  invariant(typeof evidence.attribution.hostArchitecture === "string" && evidence.attribution.hostArchitecture.length > 0, `${evidence.suiteId}: host architecture is missing.`);
  if (frozen.platform !== "web" && frozen.platform !== "any-desktop") {
    invariant(evidence.attribution.hostPlatform === frozen.platform, `${evidence.suiteId}: host platform mismatch.`);
  }

  invariant(evidence.runner && typeof evidence.runner.id === "string" && evidence.runner.id.length > 0, `${evidence.suiteId}: runner identity is missing.`);
  invariant(typeof evidence.runner.version === "string" && evidence.runner.version.length > 0 && !/^unknown$/iu.test(evidence.runner.version), `${evidence.suiteId}: exact runner version is missing.`);
  invariant(Array.isArray(evidence.runner.command) && evidence.runner.command.length > 0 && evidence.runner.command.every((item) => typeof item === "string" && item.length > 0), `${evidence.suiteId}: runner command is missing.`);
  invariant(Array.isArray(evidence.runner.implementation) && evidence.runner.implementation.length > 0, `${evidence.suiteId}: runner implementation closure is missing.`);

  invariant(evidence.application?.name === frozen.application, `${evidence.suiteId}: application identity mismatch.`);
  invariant(typeof evidence.application.version === "string" && evidence.application.version.length > 0 && !/^unknown$/iu.test(evidence.application.version), `${evidence.suiteId}: application version is missing.`);
  const proof = proofContract(frozen, evidence.automation?.mode);
  invariant(typeof evidence.automation.startedAt === "string" && Number.isFinite(Date.parse(evidence.automation.startedAt)), `${evidence.suiteId}: automation start time is invalid.`);
  invariant(typeof evidence.automation.endedAt === "string" && Number.isFinite(Date.parse(evidence.automation.endedAt)) && Date.parse(evidence.automation.endedAt) >= Date.parse(evidence.automation.startedAt), `${evidence.suiteId}: automation end time is invalid.`);
  if (proof.mode === "desktop-automation") {
    invariant(evidence.application.platform === evidence.attribution.hostPlatform, `${evidence.suiteId}: desktop application platform drifted.`);
    invariant(DIGEST.test(evidence.application.executableSha256 ?? ""), `${evidence.suiteId}: executable SHA-256 is missing.`);
    invariant(evidence.automation.protocol === proof.automationProtocol, `${evidence.suiteId}: desktop automation protocol mismatch.`);
    invariant(Number.isInteger(evidence.automation.processId) && evidence.automation.processId > 0, `${evidence.suiteId}: owned application process receipt is missing.`);
  } else if (proof.mode === "browser-automation") {
    invariant(evidence.automation.protocol === proof.automationProtocol, `${evidence.suiteId}: browser automation protocol mismatch.`);
    invariant(JSON.stringify(evidence.application.serviceOrigins) === JSON.stringify(proof.serviceOrigins), `${evidence.suiteId}: service origin mismatch.`);
    if (proof.requiresAuthenticatedSession) {
      invariant(evidence.automation.authenticated === true && evidence.automation.authentication?.type === "browser-session"
        && DIGEST.test(evidence.automation.authentication?.principalSha256 ?? ""), `${evidence.suiteId}: authenticated browser session proof is missing.`);
    }
    invariant(typeof evidence.automation.browser?.name === "string" && evidence.automation.browser.name.length > 0, `${evidence.suiteId}: browser identity is missing.`);
    invariant(typeof evidence.automation.browser?.version === "string" && evidence.automation.browser.version.length > 0 && !/^unknown$/iu.test(evidence.automation.browser.version), `${evidence.suiteId}: browser version is missing.`);
    if (proof.requiresResourceLifecycle) validateBrowserLifecycle(evidence, proof);
  } else if (proof.mode === "authenticated-service-automation") {
    invariant(evidence.automation.protocol === proof.automationProtocol, `${evidence.suiteId}: service automation protocol mismatch.`);
    invariant(evidence.application.versionKind === "api-discovery-revision" && evidence.application.serviceBuildExposed === false, `${evidence.suiteId}: service version attribution is misleading or incomplete.`);
    invariant(JSON.stringify(evidence.application.serviceOrigins) === JSON.stringify(proof.serviceOrigins), `${evidence.suiteId}: service origin set mismatch.`);
    invariant(evidence.automation.authenticated === true && ["oauth2-user", "oauth2-service-account"].includes(evidence.automation.authentication?.type), `${evidence.suiteId}: authenticated service identity is missing.`);
    invariant(DIGEST.test(evidence.automation.authentication?.principalSha256 ?? ""), `${evidence.suiteId}: authenticated principal digest is missing.`);
    invariant(Array.isArray(evidence.automation.authentication?.scopes)
      && evidence.automation.authentication.scopes.length > 0
      && evidence.automation.authentication.scopes.every((scope) => proof.acceptedWriteScopes.includes(scope))
      && proof.acceptedWriteScopes.some((scope) => evidence.automation.authentication.scopes.includes(scope)), `${evidence.suiteId}: Google OAuth scopes are missing or exceed the frozen write-scope allowlist.`);
    invariant(Array.isArray(evidence.automation.discovery) && evidence.automation.discovery.length === proof.requiredApis.length, `${evidence.suiteId}: API discovery attribution is incomplete.`);
    for (const [index, required] of proof.requiredApis.entries()) {
      const actual = evidence.automation.discovery[index];
      invariant(actual?.id === required.id && actual.version === required.version && actual.rootUrl === required.rootUrl
        && /^\d{8}$/u.test(actual.revision ?? ""), `${evidence.suiteId}: API discovery identity drifted for ${required.id}.`);
      validateFileReceipt(actual.artifact, `${evidence.suiteId} ${required.id} discovery`);
    }
    const version = evidence.automation.discovery.map((item) => `${item.id}@${item.revision}`).join("+");
    invariant(evidence.application.version === version, `${evidence.suiteId}: application version is not derived from the captured API discovery revisions.`);
    const serviceTrace = evidence.automation.serviceTrace;
    invariant(serviceTrace?.authenticated === true && serviceTrace.resourceIdSha256 === evidence.automation.authentication.resourceIdSha256
      && DIGEST.test(serviceTrace.resourceIdSha256 ?? ""), `${evidence.suiteId}: authenticated resource binding is missing.`);
    invariant(DIGEST.test(serviceTrace.beforeRevisionIdSha256 ?? "") && DIGEST.test(serviceTrace.afterRevisionIdSha256 ?? "")
      && serviceTrace.beforeRevisionIdSha256 !== serviceTrace.afterRevisionIdSha256, `${evidence.suiteId}: revision-bound service edit is missing.`);
    invariant(Array.isArray(serviceTrace.operations) && serviceTrace.operations.length === proof.requiredOperationSequence.length, `${evidence.suiteId}: service operation sequence is incomplete.`);
    let previousEndedAt = null;
    for (const [index, required] of proof.requiredOperationSequence.entries()) {
      const actual = serviceTrace.operations[index];
      invariant(actual?.id === required.id && actual.apiId === required.apiId && actual.method === required.method, `${evidence.suiteId}: service operation sequence drifted at ${required.id}.`);
      invariant(Number.isInteger(actual.status) && actual.status >= 200 && actual.status < 300, `${evidence.suiteId}: service operation ${required.id} did not succeed.`);
      invariant(actual.resourceIdSha256 === serviceTrace.resourceIdSha256 && DIGEST.test(actual.requestSha256 ?? "") && DIGEST.test(actual.responseSha256 ?? ""), `${evidence.suiteId}: service operation ${required.id} is not resource/request/response bound.`);
      invariant(Number.isFinite(Date.parse(actual.startedAt)) && Number.isFinite(Date.parse(actual.endedAt))
        && Date.parse(actual.endedAt) >= Date.parse(actual.startedAt), `${evidence.suiteId}: service operation ${required.id} timestamps are invalid.`);
      invariant(previousEndedAt === null || Date.parse(actual.startedAt) >= previousEndedAt, `${evidence.suiteId}: service operation ${required.id} overlaps or precedes the prior operation.`);
      previousEndedAt = Date.parse(actual.endedAt);
    }
    invariant(serviceTrace.operations[2].requiredRevisionIdSha256 === serviceTrace.beforeRevisionIdSha256
      && serviceTrace.operations[3].revisionIdSha256 === serviceTrace.afterRevisionIdSha256, `${evidence.suiteId}: batchUpdate/readback revision binding drifted.`);
    invariant(evidence.automation.captureManifest && Array.isArray(evidence.automation.snapshots) && evidence.automation.snapshots.length >= 3, `${evidence.suiteId}: service capture receipts are incomplete.`);
  }

  invariant(evidence.operation && ["opened", "imported", "saved", "reopened", "exported"].every((key) => evidence.operation[key] === true), `${evidence.suiteId}: application operation chain is incomplete.`);
  for (const deck of [evidence.sourceDeck, evidence.resultDeck]) {
    invariant(Number.isInteger(deck?.slideCount) && deck.slideCount >= contract.minimumFixtureInventory.slides, `${evidence.suiteId}: deck slide count is invalid.`);
    invariant(DIGEST.test(deck.inventoryHash ?? ""), `${evidence.suiteId}: deck inventory hash is invalid.`);
  }
  invariant(evidence.sourceDeck.slideCount === evidence.resultDeck.slideCount, `${evidence.suiteId}: slide count changed.`);
  invariant(/\.pptx$/iu.test(evidence.sourceDeck.artifact?.path ?? "") && /\.pptx$/iu.test(evidence.resultDeck.artifact?.path ?? ""), `${evidence.suiteId}: source and result artifacts must be PPTX files.`);
  invariant(evidence.sourceDeck.artifact.sha256 !== evidence.resultDeck.artifact.sha256, `${evidence.suiteId}: result deck is not a distinct saved package.`);

  invariant(evidence.mutation?.kind === "native-text-sentinel" && typeof evidence.mutation.targetObjectId === "string" && evidence.mutation.targetObjectId.length > 0, `${evidence.suiteId}: native mutation identity is missing.`);
  invariant(DIGEST.test(evidence.mutation.beforeSha256 ?? "") && DIGEST.test(evidence.mutation.afterSha256 ?? "") && evidence.mutation.beforeSha256 !== evidence.mutation.afterSha256, `${evidence.suiteId}: native mutation hashes are invalid.`);
  invariant(evidence.mutation.reopenedNativeTextMatched === true, `${evidence.suiteId}: native mutation did not survive reopen.`);

  invariant(evidence.semantic?.sourceInventoryHash === evidence.sourceDeck.inventoryHash, `${evidence.suiteId}: source semantic inventory is unbound.`);
  invariant(evidence.semantic?.resultInventoryHash === evidence.resultDeck.inventoryHash, `${evidence.suiteId}: result semantic inventory is unbound.`);
  invariant(evidence.semantic.sourceInventoryHash === canonicalHash(evidence.semantic.sourceInventory), `${evidence.suiteId}: source semantic inventory hash does not match its contents.`);
  invariant(evidence.semantic.resultInventoryHash === canonicalHash(evidence.semantic.resultInventory), `${evidence.suiteId}: result semantic inventory hash does not match its contents.`);
  validateInventory(evidence.semantic.sourceInventory, contract.minimumFixtureInventory, `${evidence.suiteId} source`);
  validateInventory(evidence.semantic.resultInventory, {
    slides: contract.minimumFixtureInventory.slides,
    nativeTextObjects: 1,
  }, `${evidence.suiteId} result`);
  validateChecks(evidence.semantic.coreChecks, contract.coreSemanticChecks, `${evidence.suiteId} core`, ["preserved"]);
  validateChecks(evidence.semantic.advancedChecks, contract.advancedSemanticChecks, `${evidence.suiteId} advanced`, contract.allowedAdvancedOutcomes);
  validateAdvancedInventoryBindings(evidence, contract);

  invariant(evidence.render?.renderer && typeof evidence.render.renderer.name === "string" && evidence.render.renderer.name.length > 0, `${evidence.suiteId}: renderer identity is missing.`);
  invariant(typeof evidence.render.renderer.version === "string" && evidence.render.renderer.version.length > 0 && !/^unknown$/iu.test(evidence.render.renderer.version), `${evidence.suiteId}: renderer version is missing.`);
  invariant(evidence.render.review, `${evidence.suiteId}: hash-bound visual review is missing.`);
  if (proof.mode === "authenticated-service-automation") invariant(evidence.render.sourceDocument && /\.pdf$/iu.test(evidence.render.sourceDocument.path ?? ""), `${evidence.suiteId}: service-produced PDF render source is missing.`);
  invariant(Array.isArray(evidence.render.slides) && evidence.render.slides.length === evidence.resultDeck.slideCount, `${evidence.suiteId}: per-slide render set is incomplete.`);
  const slideNumbers = evidence.render.slides.map((item) => item.slide);
  invariant(new Set(slideNumbers).size === slideNumbers.length && slideNumbers.every((item, index) => item === index + 1), `${evidence.suiteId}: render slide identities are not complete and ordered.`);
  for (const slide of evidence.render.slides) {
    invariant(Number.isInteger(slide.widthPixels) && slide.widthPixels >= contract.renderContract.minimumWidthPixels, `${evidence.suiteId}/slide-${slide.slide}: render width is too small.`);
    invariant(Number.isInteger(slide.heightPixels) && slide.heightPixels >= contract.renderContract.minimumHeightPixels, `${evidence.suiteId}/slide-${slide.slide}: render height is too small.`);
    invariant(contract.renderContract.requiredPerSlideChecks.every((key) => slide.checks?.[key] === true), `${evidence.suiteId}/slide-${slide.slide}: readability checks are incomplete.`);
  }
  if (proof.requiresExternalManualReview) {
    const review = evidence.render.reviewAttestation;
    invariant(review?.reviewMethod === "full-size-human" && review.allSlidesPassed === true, `${evidence.suiteId}: external full-size human review is missing.`);
    invariant(DIGEST.test(review.reviewerIdSha256 ?? "") && DIGEST.test(review.reviewSha256 ?? "")
      && review.reviewSha256 === evidence.render.review?.sha256, `${evidence.suiteId}: external review identity or artifact binding is invalid.`);
    invariant(Number.isFinite(Date.parse(review.reviewedAt)) && Date.parse(review.reviewedAt) >= Date.parse(evidence.automation.endedAt), `${evidence.suiteId}: external review timestamp is invalid.`);
    invariant(review.slideCount === evidence.render.slides.length, `${evidence.suiteId}: external review slide count is incomplete.`);
  }

  const receipts = collectReceipts(evidence);
  const paths = new Set();
  for (const [label, receipt] of receipts) {
    validateFileReceipt(receipt, `${evidence.suiteId} ${label}`);
    invariant(!paths.has(receipt.path), `${evidence.suiteId}: duplicated artifact receipt ${receipt.path}.`);
    paths.add(receipt.path);
    if (verifyArtifactBodies) {
      invariant(bundleRoot, `${evidence.suiteId}: bundle root is required to verify artifact bodies.`);
      await verifyFileReceipt(bundleRoot, receipt, `${evidence.suiteId} ${label}`);
    }
  }
  if (verifyArtifactBodies) {
    await verifyPptxReceipt(bundleRoot, evidence.sourceDeck.artifact, `${evidence.suiteId} source deck`);
    await verifyPptxReceipt(bundleRoot, evidence.resultDeck.artifact, `${evidence.suiteId} result deck`);
  }
  return { suiteId: evidence.suiteId, sourceCommit: evidence.attribution.sourceCommit, sourceDeckSha256: evidence.sourceDeck.artifact.sha256, receipts: receipts.length };
}

export async function runC19DestructiveControls(validEvidence, options) {
  const controls = [
    ["self-report-origin", (item) => { item.evidenceOrigin = "self-report"; }],
    ["stale-contract", (item) => { item.contractHash = "0".repeat(64); }],
    ["wrong-source-commit", (item) => { item.attribution.sourceCommit = "0".repeat(40); }],
    ["unknown-tool-version", (item) => { item.application.version = "unknown"; }],
    ["invalid-source-deck-digest", (item) => { item.sourceDeck.artifact.sha256 = "not-a-digest"; }],
    ["missing-automation-trace", (item) => { delete item.automation.trace; }],
    ["missing-semantic-core-check", (item) => { item.semantic.coreChecks.pop(); }],
    ["missing-render-slide", (item) => { item.render.slides.pop(); }],
  ];
  if (validEvidence.automation?.mode === "authenticated-service-automation") {
    controls.push(
      ["missing-authenticated-service-proof", (item) => { item.automation.authenticated = false; }],
      ["service-api-origin-drift", (item) => { item.application.serviceOrigins[0] = "https://example.invalid"; }],
      ["service-discovery-revision-missing", (item) => { item.automation.discovery[0].revision = "unknown"; }],
      ["service-operation-sequence-drift", (item) => { [item.automation.serviceTrace.operations[1], item.automation.serviceTrace.operations[2]] = [item.automation.serviceTrace.operations[2], item.automation.serviceTrace.operations[1]]; }],
      ["false-preserved-advanced-outcome", (item) => {
        const chart = item.semantic.advancedChecks.find((check) => check.id === "native-chart");
        chart.outcome = chart.outcome === "preserved" ? "unsupported" : "preserved";
      }],
      ["missing-service-pdf", (item) => { delete item.render.sourceDocument; }],
    );
  }
  if (validEvidence.automation?.mode === "browser-automation" && validEvidence.automation?.browserTrace) {
    controls.push(
      ["missing-authenticated-browser-proof", (item) => { item.automation.authenticated = false; }],
      ["browser-origin-drift", (item) => { item.automation.browserTrace.operations[0].origin = "https://example.invalid"; }],
      ["browser-operation-sequence-drift", (item) => { [item.automation.browserTrace.operations[1], item.automation.browserTrace.operations[2]] = [item.automation.browserTrace.operations[2], item.automation.browserTrace.operations[1]]; }],
      ["browser-resource-not-deleted", (item) => { item.automation.browserTrace.operations.at(-1).resourceDeleted = false; }],
      ["false-browser-advanced-outcome", (item) => {
        const chart = item.semantic.advancedChecks.find((check) => check.id === "native-chart");
        chart.outcome = chart.outcome === "preserved" ? "unsupported" : "preserved";
      }],
      ["missing-browser-pdf", (item) => { delete item.render.sourceDocument; }],
    );
  }
  if (validEvidence.render?.reviewAttestation) {
    controls.push(["automated-review-masquerade", (item) => { item.render.reviewAttestation.reviewMethod = "pass-precheck"; }]);
  }
  const results = [];
  for (const [id, mutate] of controls) {
    const mutant = structuredClone(validEvidence);
    mutate(mutant);
    let rejected = false;
    let message = "";
    try { await validateC19SuiteEvidence(mutant, { ...options, verifyArtifactBodies: false, bundleRoot: null }); }
    catch (error) { rejected = true; message = error.message; }
    invariant(rejected, `${validEvidence.suiteId}: destructive control ${id} was accepted.`);
    results.push({ id, rejected, diagnosticSha256: sha256(message) });
  }
  return results;
}

export async function implementationClosure(root) {
  const items = [];
  for (const relative of C19_IMPLEMENTATION_CLOSURE) {
    const bytes = await fs.readFile(path.join(root, ...relative.split("/")));
    const normalized = /\.(?:mjs|md|json)$/u.test(relative) ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : bytes;
    items.push({ path: relative, byteLength: normalized.length, sha256: sha256(normalized) });
  }
  return items;
}

export function matrixArtifactNames(sourceCommit) {
  return [...C19_REQUIRED_SUITES.map((suite) => `slidewright-c19-${suite}-${sourceCommit}`), `slidewright-c19-matrix-${sourceCommit}`].sort();
}

function receiptForBytes(relative, bytes) {
  return { path: relative, byteLength: bytes.length, sha256: sha256(bytes) };
}

export async function verifyPublishedC19Evidence({ root, published = path.join(root, "evidence", "c19", "v2") }) {
  const pointerPath = path.join(published, "current.json");
  let pointer;
  try { pointer = await readJson(pointerPath); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("C19 public evidence is pending: no replicated six-suite matrix has been imported.");
    throw error;
  }
  invariant(pointer.schemaVersion === "slidewright-c19-current/v2" && pointer.valid === true && pointer.state === "replicated", "C19 public pointer is absent, incomplete, or not replicated.");
  invariant(pointer.pointerHash === canonicalHash(pointer, "pointerHash"), "C19 public pointer hash mismatch.");
  invariant(DIGEST.test(pointer.scorecardHash ?? "") && pointer.run === `runs/${pointer.scorecardHash}`, "C19 public run pointer is invalid.");
  invariant(COMMIT.test(pointer.sourceCommit ?? "") && REPOSITORY.test(pointer.repository ?? "") && /^\d+$/u.test(`${pointer.runId ?? ""}`), "C19 public attribution is invalid.");
  invariant(pointer.runUrl === `https://github.com/${pointer.repository}/actions/runs/${pointer.runId}`, "C19 public run URL is not source-bound.");

  const { contract, hash: contractHash } = await contractWithHash(root);
  invariant(pointer.contractHash === contractHash, "C19 public contract binding drifted.");
  const run = path.join(published, ...pointer.run.split("/"));
  const scorecardPath = path.join(run, "scorecard.json");
  const scorecardBytes = await fs.readFile(scorecardPath);
  validateFileReceipt(pointer.files?.scorecard, "C19 public scorecard");
  invariant(pointer.files.scorecard.path === `${pointer.run}/scorecard.json`
    && pointer.files.scorecard.byteLength === scorecardBytes.length
    && pointer.files.scorecard.sha256 === sha256(scorecardBytes), "C19 public scorecard bytes drifted.");
  const scorecard = JSON.parse(scorecardBytes.toString("utf8"));
  invariant(scorecard.schemaVersion === "slidewright-c19-matrix-scorecard/v2" && scorecard.valid === true && scorecard.allRequiredSuitesVerified === true, "C19 public scorecard is incomplete.");
  invariant(scorecard.scorecardHash === pointer.scorecardHash && scorecard.scorecardHash === canonicalHash(scorecard, "scorecardHash"), "C19 public scorecard hash mismatch.");
  invariant(scorecard.contractHash === contractHash && scorecard.sourceCommit === pointer.sourceCommit && scorecard.repository === pointer.repository
    && `${scorecard.runId}` === `${pointer.runId}` && scorecard.runUrl === pointer.runUrl, "C19 public scorecard attribution drifted.");
  invariant(scorecard.sourceTreeClean === true && scorecard.artifactBodiesVerifiedAtImport === true && scorecard.artifactBodiesCommitted === false, "C19 public artifact scope is missing or overstated.");
  invariant(Array.isArray(pointer.files?.suites) && pointer.files.suites.length === C19_REQUIRED_SUITES.length, "C19 public suite receipt set is incomplete.");

  const expectedArtifacts = matrixArtifactNames(pointer.sourceCommit);
  invariant(Array.isArray(scorecard.artifacts) && scorecard.artifacts.length === expectedArtifacts.length
    && JSON.stringify(scorecard.artifacts.map((item) => item.name).sort()) === JSON.stringify(expectedArtifacts), "C19 GitHub artifact set is incomplete.");
  for (const artifact of scorecard.artifacts) {
    invariant(Number.isInteger(artifact.id) && artifact.id > 0 && Number.isInteger(artifact.sizeInBytes) && artifact.sizeInBytes > 0
      && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? ""), `C19 artifact metadata is invalid: ${artifact.name ?? "<missing>"}.`);
  }

  const currentClosure = await implementationClosure(root);
  invariant(JSON.stringify(scorecard.implementationClosure) === JSON.stringify(currentClosure)
    && scorecard.implementationClosureHash === canonicalHash(currentClosure), "C19 implementation closure drifted.");
  invariant(Array.isArray(scorecard.suites) && scorecard.suites.length === C19_REQUIRED_SUITES.length
    && JSON.stringify(scorecard.suites.map((item) => item.id)) === JSON.stringify(C19_REQUIRED_SUITES), "C19 public suite set is incomplete or reordered.");

  const deckHashes = new Set();
  const sourceInventoryHashes = new Set();
  let artifactReceiptCount = 0;
  for (const summary of scorecard.suites) {
    const evidencePath = path.join(run, "suites", `${summary.id}.json`);
    const bytes = await fs.readFile(evidencePath);
    const expectedReceipt = pointer.files?.suites?.find((item) => item.path === `${pointer.run}/suites/${summary.id}.json`);
    invariant(expectedReceipt && expectedReceipt.byteLength === bytes.length && expectedReceipt.sha256 === sha256(bytes), `C19 public suite evidence bytes drifted: ${summary.id}.`);
    const evidence = JSON.parse(bytes.toString("utf8"));
    const verified = await validateC19SuiteEvidence(evidence, {
      contract,
      contractHash,
      expectedSourceCommit: pointer.sourceCommit,
      expectedRepository: pointer.repository,
      verifyArtifactBodies: false,
    });
    const controls = await runC19DestructiveControls(evidence, {
      contract,
      contractHash,
      expectedSourceCommit: pointer.sourceCommit,
      expectedRepository: pointer.repository,
    });
    const expectedAdvanced = Object.fromEntries(evidence.semantic.advancedChecks.map((check) => [check.id, check.outcome]));
    invariant(summary.evidenceSha256 === sha256(bytes) && summary.sourceDeckSha256 === evidence.sourceDeck.artifact.sha256
      && summary.application === evidence.application.name
      && summary.applicationVersion === evidence.application.version && summary.automationMode === evidence.automation.mode
      && summary.receipts === verified.receipts && JSON.stringify(summary.advancedOutcomes) === JSON.stringify(expectedAdvanced)
      && JSON.stringify(summary.destructiveControls) === JSON.stringify(controls), `C19 suite summary drifted: ${summary.id}.`);
    deckHashes.add(verified.sourceDeckSha256);
    sourceInventoryHashes.add(evidence.semantic.sourceInventoryHash);
    artifactReceiptCount += verified.receipts;
  }
  invariant(deckHashes.size === 1 && [...deckHashes][0] === scorecard.sourceDeckSha256, "C19 suites did not exercise one exact source deck.");
  invariant(sourceInventoryHashes.size === 1 && [...sourceInventoryHashes][0] === scorecard.sourceInventoryHash, "C19 suites did not use one exact source semantic inventory.");
  invariant(scorecard.artifactReceiptCount === artifactReceiptCount, "C19 artifact receipt aggregate drifted.");
  return {
    valid: true,
    scorecardHash: scorecard.scorecardHash,
    sourceCommit: scorecard.sourceCommit,
    sourceDeckSha256: scorecard.sourceDeckSha256,
    suites: scorecard.suites.map((item) => ({ id: item.id, application: item.application, version: item.applicationVersion })),
    artifactReceiptCount,
    destructiveControls: scorecard.suites.reduce((sum, item) => sum + item.destructiveControls.length, 0),
    artifactBodiesCommitted: false,
  };
}

export { receiptForBytes };
