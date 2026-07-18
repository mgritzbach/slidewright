import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalHash,
  expectedTemplateMatrixClosurePaths,
  readJson,
  sha256File,
  validateTemplateMatrixManifest,
} from "./template-matrix-evidence.mjs";

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
    && !value.replaceAll("\\", "/").split("/").includes("..");
}

function assertDigest(value, label) {
  requireEvidence(/^[a-f0-9]{64}$/u.test(value ?? ""), `${label} is not a SHA-256 digest.`);
}

export async function verifyPublishedTemplateMatrixEvidence({ root, published }) {
  const pointer = await readJson(path.join(published, "current.json"));
  const pointerBasis = { ...pointer };
  delete pointerBasis.pointerHash;
  requireEvidence(pointer.schemaVersion === "slidewright-c10-public-evidence/v1"
    && pointer.valid === true
    && pointer.run === `runs/${pointer.scorecardHash}`
    && pointer.review === `reviews/${pointer.reviewHash}.json`
    && pointer.pointerHash === canonicalHash(pointerBasis), "C10 public pointer is invalid or unauthenticated.");
  assertDigest(pointer.scorecardHash, "C10 public scorecard hash");
  assertDigest(pointer.reviewHash, "C10 public review hash");
  requireEvidence(pointer.scope?.artifactBodiesCommitted === false
    && pointer.scope?.artifactHashesPublished === true
    && pointer.scope?.regenerationCommand === "npm run template:matrix", "C10 public evidence scope is missing or overstated.");

  const scorecardPath = path.join(published, ...pointer.run.split("/"), "scorecard.json");
  const reviewPath = path.join(published, ...pointer.review.split("/"));
  for (const [label, file, expected] of [
    ["scorecard", scorecardPath, pointer.files?.scorecard],
    ["review", reviewPath, pointer.files?.review],
  ]) {
    requireEvidence(expected && Number.isInteger(expected.byteLength) && expected.byteLength > 0, `C10 public ${label} receipt is missing.`);
    assertDigest(expected.sha256, `C10 public ${label} receipt`);
    const stat = await fs.stat(file);
    requireEvidence(stat.isFile() && stat.size === expected.byteLength && await sha256File(file) === expected.sha256, `C10 public ${label} bytes drifted.`);
  }

  const scorecard = await readJson(scorecardPath);
  const scorecardBasis = { ...scorecard };
  delete scorecardBasis.scorecardHash;
  requireEvidence(scorecard.schemaVersion === "slidewright-template-matrix-scorecard/v1"
    && scorecard.machineValid === true && scorecard.reviewArtifactsReady === true
    && scorecard.scorecardHash === pointer.scorecardHash
    && scorecard.scorecardHash === canonicalHash(scorecardBasis), "C10 public scorecard is invalid or unauthenticated.");
  const manifestPath = path.join(root, "fixtures", "template", "c10-v1", "manifest.json");
  const rawManifest = await readJson(manifestPath);
  const manifest = validateTemplateMatrixManifest(rawManifest);
  requireEvidence(scorecard.fixtureManifestSha256 === await sha256File(manifestPath), "C10 public fixture manifest binding drifted.");
  const fixtureIds = manifest.fixtures.map((item) => item.id).sort();
  requireEvidence(scorecard.fixtures.length === 4
    && JSON.stringify(scorecard.fixtures.map((item) => item.id).sort()) === JSON.stringify(fixtureIds), "C10 public scorecard fixture set drifted.");

  const aggregateControls = new Map();
  const semanticControls = new Map();
  let slideCount = 0;
  let placeholderFixtures = 0;
  let chartCount = 0;
  let tableCount = 0;
  let mediaCount = 0;
  for (const fixture of scorecard.fixtures) {
    requireEvidence(fixture.licensed === true && fixture.sourceHashValid === true && fixture.sanitizerRebuildValid === true
      && fixture.profileDeterministic === true && fixture.editAuditValid === true && fixture.negativeControlsValid === true
      && fixture.visualAuditValid === true && fixture.powerpointRoundtripValid === true && fixture.powerpointRepeatRoundtripValid === true
      && fixture.powerpointSemanticAuditValid === true && fixture.powerpointSemanticRepeatAuditValid === true
      && fixture.powerpointSemanticControlsValid === true && fixture.powerpointVisualAuditValid === true
      && fixture.powerpointRepeatVisualAuditValid === true && fixture.visibleNegativeRejected === true
      && fixture.slidesTestValid === true, `C10 public fixture ${fixture.id} is incomplete.`);
    requireEvidence(Number.isInteger(fixture.expected?.slideCount) && fixture.expected.slideCount > 0, `C10 public fixture ${fixture.id} slide count is invalid.`);
    slideCount += fixture.expected.slideCount;
    if (fixture.inventory.placeholderCount > 0) placeholderFixtures += 1;
    chartCount += fixture.inventory.chartCount;
    tableCount += fixture.inventory.tableCount;
    mediaCount += fixture.inventory.mediaCount;
    for (const control of fixture.negativeControls ?? []) {
      if (!aggregateControls.has(control.name)) aggregateControls.set(control.name, []);
      aggregateControls.get(control.name).push(control);
      if (control.applicable) requireEvidence(control.rejected === true, `C10 public control ${fixture.id}/${control.name} did not reject.`);
    }
    for (const control of fixture.powerpointSemanticControls ?? []) {
      if (!semanticControls.has(control.name)) semanticControls.set(control.name, []);
      semanticControls.get(control.name).push(control);
    }
  }
  requireEvidence(slideCount === 39 && placeholderFixtures >= 2 && chartCount >= 2 && tableCount >= 1 && mediaCount >= 10, "C10 public aggregate template coverage is incomplete.");
  for (const name of [
    "wrong-source-sha", "stale-source-binding", "same-slide-undeclared-drift", "master-part-drift",
    "layout-part-drift", "placeholder-binding-drift", "theme-palette-drift", "inheritance-relationship-drift",
    "text-spacing-drift", "chrome-geometry-drift", "visible-geometry-drift", "unexpected-package-part",
    "direct-formatting", "second-run", "second-paragraph",
  ]) requireEvidence((aggregateControls.get(name) ?? []).some((item) => item.applicable && item.rejected), `C10 public aggregate control ${name} lacks an intended rejection.`);
  for (const name of ["chart-semantic-drift", "embedded-workbook-drift", "table-cell-drift", "hyperlink-target-drift", "media-byte-drift", "native-object-editability-drift"]) {
    requireEvidence((semanticControls.get(name) ?? []).some((item) => item.applicable && item.rejected && item.intendedFailureFound), `C10 public semantic control ${name} lacks an intended rejection.`);
  }

  requireEvidence(Array.isArray(scorecard.artifactInventory) && scorecard.artifactInventory.length === 542, "C10 public artifact inventory must contain exactly 542 receipts.");
  const artifactPaths = new Set();
  for (const artifact of scorecard.artifactInventory) {
    requireEvidence(safeRelativePath(artifact.path) && !artifactPaths.has(artifact.path)
      && Number.isInteger(artifact.byteLength) && artifact.byteLength > 0, `C10 public artifact receipt is invalid or duplicated: ${artifact.path}`);
    assertDigest(artifact.sha256, `C10 public artifact ${artifact.path}`);
    artifactPaths.add(artifact.path);
  }

  const expectedClosurePaths = await expectedTemplateMatrixClosurePaths(root, rawManifest);
  requireEvidence(Array.isArray(scorecard.implementationClosure)
    && JSON.stringify(scorecard.implementationClosure.map((item) => item.path)) === JSON.stringify(expectedClosurePaths), "C10 public implementation closure path set drifted.");
  for (const item of scorecard.implementationClosure) {
    assertDigest(item.sha256, `C10 public implementation closure ${item.path}`);
    requireEvidence(await sha256File(path.join(root, ...item.path.split("/"))) === item.sha256, `C10 public implementation closure drifted: ${item.path}`);
  }
  requireEvidence(canonicalHash(scorecard.implementationClosure) === scorecard.implementationClosureHash, "C10 public implementation closure hash drifted.");

  const expectedReviewArtifacts = scorecard.fixtures.flatMap((fixture) => ["edited", "powerpoint-roundtrip", "powerpoint-roundtrip-repeat", "source", "visible-negative"].flatMap((deck) => (
    Array.from({ length: fixture.expected.slideCount }, (_, index) => ({
      fixtureId: fixture.id,
      deck,
      slide: index + 1,
      path: `fixtures/${fixture.id}/${deck}/slide-${index + 1}.png`,
    }))
  ))).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId) || left.deck.localeCompare(right.deck) || left.slide - right.slide);
  requireEvidence(scorecard.reviewArtifacts.length === 195 && scorecard.reviewArtifacts.length === expectedReviewArtifacts.length
    && scorecard.reviewArtifacts.every((item, index) => item.fixtureId === expectedReviewArtifacts[index].fixtureId
      && item.deck === expectedReviewArtifacts[index].deck && item.slide === expectedReviewArtifacts[index].slide
      && item.path === expectedReviewArtifacts[index].path && /^[a-f0-9]{64}$/u.test(item.sha256)), "C10 public review matrix is incomplete or malformed.");

  const review = await readJson(reviewPath);
  const reviewBasis = { ...review };
  delete reviewBasis.reviewHash;
  requireEvidence(review.schemaVersion === "slidewright-template-matrix-review/v1" && review.valid === true
    && review.scorecardHash === scorecard.scorecardHash && review.reviewHash === pointer.reviewHash
    && review.reviewHash === canonicalHash(reviewBasis) && review.artifacts.length === scorecard.reviewArtifacts.length,
  "C10 public review is invalid or unauthenticated.");
  for (let index = 0; index < scorecard.reviewArtifacts.length; index += 1) {
    const expected = scorecard.reviewArtifacts[index];
    const actual = review.artifacts[index];
    requireEvidence(actual.path === expected.path && actual.sha256 === expected.sha256
      && actual.verdict === "pass" && Array.isArray(actual.findings) && actual.findings.length === 0, `C10 public review binding drifted at artifact ${index}.`);
  }
  return {
    valid: true,
    scorecardHash: scorecard.scorecardHash,
    reviewHash: review.reviewHash,
    fixtures: scorecard.fixtures.length,
    slides: slideCount,
    artifactReceipts: scorecard.artifactInventory.length,
    reviewedArtifacts: review.artifacts.length,
    implementationFiles: scorecard.implementationClosure.length,
  };
}
