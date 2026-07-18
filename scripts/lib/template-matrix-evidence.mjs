import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const TEMPLATE_MATRIX_IMPLEMENTATION_PATHS = [
  "package.json",
  "package-lock.json",
  "requirements-ci.txt",
  "scripts/run-template-matrix-benchmark.mjs",
  "scripts/finalize-template-matrix-review.mjs",
  "scripts/verify-template-matrix-evidence.mjs",
  "scripts/lib/template-matrix-evidence.mjs",
  "scripts/publish-template-matrix-evidence.mjs",
  "scripts/verify-template-matrix-public-evidence.mjs",
  "scripts/lib/template-matrix-public-evidence.mjs",
  "plugins/slidewright/skills/slidewright/scripts/design_profile/design_profile_core.py",
  "plugins/slidewright/skills/slidewright/scripts/design_profile/extract_design_profile.py",
  "plugins/slidewright/skills/slidewright/scripts/design_profile/audit_design_profile.py",
  "plugins/slidewright/skills/slidewright/scripts/design_profile/template_matrix_negative_controls.py",
  "plugins/slidewright/skills/slidewright/scripts/template/edit_template.py",
  "plugins/slidewright/skills/slidewright/scripts/template/compare_template_renders.py",
  "plugins/slidewright/skills/slidewright/scripts/template/compare_exact_renders.py",
  "plugins/slidewright/skills/slidewright/scripts/template/audit_powerpoint_roundtrip_semantics.py",
  "plugins/slidewright/skills/slidewright/scripts/template/powerpoint_roundtrip_semantic_controls.py",
  "plugins/slidewright/skills/slidewright/scripts/template/powerpoint_template_matrix_roundtrip.ps1",
  "plugins/slidewright/skills/slidewright/scripts/lib/design-profile.mjs",
  "plugins/slidewright/skills/slidewright/scripts/lib/compile_profile_derivation.mjs",
  "fixtures/template/c10-v1/automizer-charts/SANITIZATION.md",
  "fixtures/template/c10-v1/automizer-charts/sanitize.py",
  "fixtures/template/c10-v1/automizer-charts/upstream-template.pptx",
  "fixtures/template/c10-v1/cats/SANITIZATION.md",
  "fixtures/template/c10-v1/cats/sanitize.py",
  "fixtures/template/c10-v1/manifest.json",
  "tests/template-matrix.test.mjs",
].sort();

function confinedFixturePath(fixtureRoot, relative) {
  if (typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)) throw new Error(`Invalid C10 fixture path: ${relative}`);
  const normalized = relative.replaceAll("\\", "/");
  const absolute = path.resolve(fixtureRoot, ...normalized.split("/"));
  if (absolute !== fixtureRoot && !absolute.startsWith(`${fixtureRoot}${path.sep}`)) throw new Error(`C10 fixture path escapes its root: ${relative}`);
  return { normalized, absolute };
}

export async function expectedTemplateMatrixClosurePaths(root, rawManifest) {
  const fixtureRoot = path.resolve(root, "fixtures", "template", "c10-v1");
  const manifest = validateTemplateMatrixManifest(rawManifest);
  const paths = new Set(TEMPLATE_MATRIX_IMPLEMENTATION_PATHS);
  const add = (relative) => {
    const item = confinedFixturePath(fixtureRoot, relative);
    paths.add(`fixtures/template/c10-v1/${item.normalized}`);
    return item.absolute;
  };
  for (const fixture of manifest.fixtures) {
    for (const relative of [fixture.sourceFile, fixture.editPlan, fixture.provenance, fixture.license.file]) add(relative);
    for (const field of [fixture.source?.sanitizer, fixture.source?.sanitizationContract, fixture.source?.upstreamFile]) if (field) add(field);
  }
  for (const relative of manifest.rejectedSources) {
    const record = await readJson(add(relative));
    if (record.binaryVendored === true) {
      for (const field of [record.file, record.editPlan, record.licenseFile, ...(record.evidenceReceipts ?? [])]) add(field);
    }
  }
  return [...paths].sort();
}

export async function loadValidatedRejectedSources(root, manifest) {
  const fixtureRoot = path.resolve(root, "fixtures", "template", "c10-v1");
  const records = [];
  const ids = new Set();
  for (const relative of manifest.rejectedSources) {
    const location = confinedFixturePath(fixtureRoot, relative);
    const record = await readJson(location.absolute);
    if (record.schemaVersion !== "slidewright-c10-rejected-source/v1" || record.status !== "rejected"
      || typeof record.id !== "string" || ids.has(record.id) || typeof record.rejectionReason !== "string" || record.rejectionReason.length < 20
      || !Array.isArray(record.diagnostics) || record.diagnostics.length === 0) throw new Error(`Invalid C10 rejected-source record: ${relative}`);
    ids.add(record.id);
    if (record.binaryVendored === true) {
      if (![record.file, record.editPlan, record.licenseFile].every((item) => typeof item === "string") || !/^[a-f0-9]{64}$/u.test(record.sourceSha256 ?? "")) {
        throw new Error(`Rejected binary ${record.id} lacks bound local evidence.`);
      }
      const binary = confinedFixturePath(fixtureRoot, record.file).absolute;
      if (await sha256File(binary) !== record.sourceSha256) throw new Error(`Rejected binary ${record.id} hash drifted.`);
      await readJson(confinedFixturePath(fixtureRoot, record.editPlan).absolute);
      if ((await fs.stat(confinedFixturePath(fixtureRoot, record.licenseFile).absolute)).size === 0) throw new Error(`Rejected binary ${record.id} license is empty.`);
    } else if (!/^[a-f0-9]{64}$/u.test(record.source?.sha256 ?? "") || !Number.isInteger(record.source?.bytes) || record.source.bytes < 1) {
      throw new Error(`Rejected remote source ${record.id} lacks a hash and byte count.`);
    }
    records.push(record);
  }
  return records;
}

export function canonicalHash(value) {
  const normalize = (item) => Array.isArray(item)
    ? item.map(normalize)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
      : item;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export async function sha256File(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export async function sha256ImplementationFile(file) {
  const bytes = await fs.readFile(file);
  if (path.extname(file).toLowerCase() === ".pptx") return crypto.createHash("sha256").update(bytes).digest("hex");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/gu, "\n");
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

export function validateTemplateMatrixManifest(manifest) {
  if (manifest?.schemaVersion !== "slidewright-c10-template-fixtures/v1" || !Array.isArray(manifest.fixtures) || manifest.fixtures.length !== 4) {
    throw new Error("C10 manifest must declare exactly four fixtures.");
  }
  const ids = new Set();
  const safeRelative = (value) => typeof value === "string" && value.length > 0 && !path.isAbsolute(value)
    && !value.replaceAll("\\", "/").split("/").includes("..");
  for (const fixture of manifest.fixtures) {
    if (!/^[a-z0-9][a-z0-9-]+$/u.test(fixture?.id ?? "") || ids.has(fixture.id)) throw new Error("C10 fixture IDs must be unique stable IDs.");
    ids.add(fixture.id);
    if (fixture.status !== "accepted" || !/^[a-f0-9]{64}$/u.test(fixture.source?.curatedSha256 ?? "")
      || !safeRelative(fixture.file) || !safeRelative(fixture.editPlan)
      || !safeRelative(fixture.source?.license?.localNotice) || typeof fixture.source?.license?.spdx !== "string") {
      throw new Error(`C10 fixture ${fixture.id} lacks a hash-pinned source, plan, provenance, or license.`);
    }
    if (!["unmodified-upstream-binary", "deterministically-curated-derivative", "deterministically-sanitized-derivative"].includes(fixture.distribution)) {
      throw new Error(`C10 fixture ${fixture.id} has an unsupported distribution.`);
    }
    if (fixture.distribution !== "unmodified-upstream-binary"
      && !(safeRelative(fixture.source?.sanitizer) && safeRelative(fixture.source?.sanitizationContract)
        && safeRelative(fixture.source?.upstreamFile) && /^[a-f0-9]{64}$/u.test(fixture.source?.upstreamSha256 ?? "")
        && Array.isArray(fixture.source?.sanitizerArguments) && fixture.source.sanitizerArguments.filter((item) => item === "{input}").length === 1
        && fixture.source.sanitizerArguments.filter((item) => item === "{output}").length === 1)) {
      throw new Error(`C10 derivative fixture ${fixture.id} lacks a reproducible sanitizer contract and vendored upstream.`);
    }
    for (const field of ["slides", "masters", "layouts", "themes"]) {
      if (!Number.isInteger(fixture.inventory?.[field]) || fixture.inventory[field] < 1) throw new Error(`C10 fixture ${fixture.id} inventory.${field} is invalid.`);
    }
  }
  if (!Array.isArray(manifest.rejected) || manifest.rejected.length !== 2
    || !manifest.rejected.includes("rejected/triple.json") || !manifest.rejected.includes("rejected/keith-powerpoint.json")) {
    throw new Error("C10 manifest must record the exact two reviewed rejected sources.");
  }
  if (!manifest.rejected.every(safeRelative)) throw new Error("C10 rejected-source paths must be confined relative paths.");
  return {
    ...manifest,
    fixtures: manifest.fixtures.map((fixture) => ({
      ...fixture,
      sourceFile: fixture.file,
      sourceSha256: fixture.source.curatedSha256,
      provenance: "README.md",
      license: {
        file: fixture.source.license.localNotice,
        spdx: fixture.source.license.spdx,
        sourceUrl: fixture.source.license.legalCodeUrl
          ?? fixture.source.license.repositoryLicenseUrl
          ?? fixture.source.license.sourceLicenseStatementUrl,
      },
      expected: {
        slideCount: fixture.inventory.slides,
        masterCount: fixture.inventory.masters,
        layoutCount: fixture.inventory.layouts,
        themeCount: fixture.inventory.themes,
      },
    })),
    rejectedSources: manifest.rejected,
  };
}

async function walkFiles(directory, prefix = "") {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walkFiles(absolute, relative));
    else if (entry.isFile()) result.push({ relative, absolute });
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function inventoryTree(directory, excluded = new Set()) {
  const records = [];
  for (const item of await walkFiles(directory)) {
    if (excluded.has(item.relative.replaceAll("\\", "/"))) continue;
    const stat = await fs.stat(item.absolute);
    records.push({ path: item.relative.replaceAll("\\", "/"), byteLength: stat.size, sha256: await sha256File(item.absolute) });
  }
  return records;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyTemplateMatrixEvidence({ root, runDirectory, requireCurrentSource = true }) {
  const scorecardPath = path.join(runDirectory, "scorecard.json");
  const scorecard = await readJson(scorecardPath);
  const hashBasis = { ...scorecard };
  delete hashBasis.scorecardHash;
  requireEvidence(scorecard.schemaVersion === "slidewright-template-matrix-scorecard/v1"
    && scorecard.machineValid === true && scorecard.reviewArtifactsReady === true
    && scorecard.scorecardHash === canonicalHash(hashBasis), "C10 scorecard is not hash-authenticated or machine-valid.");
  requireEvidence(Array.isArray(scorecard.fixtures) && scorecard.fixtures.length === 4, "C10 scorecard does not contain exactly four fixtures.");
  const manifestPath = path.join(root, "fixtures", "template", "c10-v1", "manifest.json");
  const rawManifest = await readJson(manifestPath);
  const manifest = validateTemplateMatrixManifest(rawManifest);
  requireEvidence(scorecard.fixtureManifestSha256 === await sha256File(manifestPath), "C10 fixture manifest binding drifted.");
  const rejectedSources = await loadValidatedRejectedSources(root, manifest);
  requireEvidence(JSON.stringify(scorecard.rejectedSources) === JSON.stringify(rejectedSources), "C10 rejected-source evidence was not re-derived from the manifest.");
  const fixtureIds = new Set(scorecard.fixtures.map((item) => item.id));
  requireEvidence(fixtureIds.size === 4, "C10 scorecard fixture IDs are not unique.");
  let placeholderFixtures = 0;
  let chartCount = 0;
  let tableCount = 0;
  let mediaCount = 0;
  const aggregateControls = new Map();
  for (const fixture of scorecard.fixtures) {
    requireEvidence(fixture.licensed === true && fixture.sourceHashValid === true && fixture.sanitizerRebuildValid === true && fixture.profileDeterministic === true
      && fixture.editAuditValid === true && fixture.negativeControlsValid === true
      && fixture.visualAuditValid === true && fixture.powerpointRoundtripValid === true
      && fixture.powerpointRepeatRoundtripValid === true && fixture.powerpointSemanticAuditValid === true
      && fixture.powerpointSemanticRepeatAuditValid === true && fixture.powerpointSemanticControlsValid === true
      && fixture.powerpointVisualAuditValid === true && fixture.powerpointRepeatVisualAuditValid === true && fixture.visibleNegativeRejected === true
      && fixture.slidesTestValid === true, `C10 fixture ${fixture.id} is incomplete.`);
    requireEvidence(fixture.inventory.slideCount === fixture.expected.slideCount
      && fixture.inventory.masterCount === fixture.expected.masterCount
      && fixture.inventory.layoutCount === fixture.expected.layoutCount
      && fixture.inventory.themeCount === fixture.expected.themeCount, `C10 fixture ${fixture.id} inventory drifted.`);
    if (fixture.inventory.placeholderCount > 0) placeholderFixtures += 1;
    chartCount += fixture.inventory.chartCount;
    tableCount += fixture.inventory.tableCount;
    mediaCount += fixture.inventory.mediaCount;
    const rawNegative = await readJson(path.join(runDirectory, "fixtures", fixture.id, "negative-controls.json"));
    requireEvidence(rawNegative.schemaVersion === "slidewright-template-matrix-negative-controls/v1" && rawNegative.valid === true, `C10 fixture ${fixture.id} raw negative controls are invalid.`);
    const rawSummary = rawNegative.controls.map(({ name, applicable, rejected, exitCode, failureFields, rejectionMode, reason }) => ({
      name, applicable, rejected,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(failureFields ? { failureFields } : {}),
      ...(rejectionMode ? { rejectionMode } : {}),
      ...(reason ? { reason } : {}),
    }));
    requireEvidence(JSON.stringify(fixture.negativeControls) === JSON.stringify(rawSummary), `C10 fixture ${fixture.id} negative-control summary is not derived from its raw report.`);
    const rawSemantic = await readJson(path.join(runDirectory, "fixtures", fixture.id, "powerpoint-semantic-audit.json"));
    requireEvidence(rawSemantic.schemaVersion === "slidewright-powerpoint-roundtrip-semantic-audit/v1" && rawSemantic.valid === true
      && rawSemantic.semanticAuditSha256 === fixture.powerpointSemanticAuditSha256, `C10 fixture ${fixture.id} semantic audit is invalid or unbound.`);
    const rawSemanticRepeat = await readJson(path.join(runDirectory, "fixtures", fixture.id, "powerpoint-semantic-audit-repeat.json"));
    requireEvidence(rawSemanticRepeat.schemaVersion === "slidewright-powerpoint-roundtrip-semantic-audit/v1" && rawSemanticRepeat.valid === true
      && rawSemanticRepeat.semanticAuditSha256 === fixture.powerpointSemanticRepeatAuditSha256, `C10 fixture ${fixture.id} repeated semantic audit is invalid or unbound.`);
    const rawSemanticControls = await readJson(path.join(runDirectory, "fixtures", fixture.id, "powerpoint-semantic-controls.json"));
    requireEvidence(rawSemanticControls.schemaVersion === "slidewright-powerpoint-roundtrip-semantic-controls/v1" && rawSemanticControls.valid === true
      && JSON.stringify(rawSemanticControls.controls) === JSON.stringify(fixture.powerpointSemanticControls), `C10 fixture ${fixture.id} semantic controls are invalid or unbound.`);
    for (const control of fixture.negativeControls) {
      if (!aggregateControls.has(control.name)) aggregateControls.set(control.name, []);
      aggregateControls.get(control.name).push(control);
      if (control.applicable) requireEvidence(control.rejected === true, `C10 applicable control ${fixture.id}/${control.name} did not reject.`);
    }
  }
  requireEvidence(placeholderFixtures >= 2 && chartCount >= 2 && tableCount >= 1 && mediaCount >= 10, "C10 aggregate semantic/template coverage is too narrow.");
  const requiredControls = [
    "wrong-source-sha", "stale-source-binding", "same-slide-undeclared-drift", "master-part-drift",
    "layout-part-drift", "placeholder-binding-drift", "theme-palette-drift", "inheritance-relationship-drift",
    "text-spacing-drift", "chrome-geometry-drift", "visible-geometry-drift", "unexpected-package-part", "direct-formatting", "second-run", "second-paragraph",
  ];
  for (const name of requiredControls) {
    const controls = aggregateControls.get(name) ?? [];
    requireEvidence(controls.some((item) => item.applicable && item.rejected), `C10 aggregate control ${name} lacks a rejecting applicable fixture.`);
  }
  const semanticControls = new Map();
  for (const fixture of scorecard.fixtures) for (const control of fixture.powerpointSemanticControls) {
    if (!semanticControls.has(control.name)) semanticControls.set(control.name, []);
    semanticControls.get(control.name).push(control);
  }
  for (const name of ["chart-semantic-drift", "embedded-workbook-drift", "table-cell-drift", "hyperlink-target-drift", "media-byte-drift", "native-object-editability-drift"]) {
    requireEvidence((semanticControls.get(name) ?? []).some((item) => item.applicable && item.rejected && item.intendedFailureFound), `C10 semantic control ${name} lacks an intended rejecting fixture.`);
  }
  requireEvidence(Array.isArray(scorecard.artifactInventory) && scorecard.artifactInventory.length > 0, "C10 artifact inventory is empty.");
  const actualInventory = await inventoryTree(runDirectory, new Set(["scorecard.json"]));
  requireEvidence(JSON.stringify(actualInventory) === JSON.stringify(scorecard.artifactInventory), "C10 artifact inventory is not exhaustive or was altered.");
  for (const artifact of scorecard.artifactInventory) {
    const absolute = path.resolve(runDirectory, ...artifact.path.split("/"));
    requireEvidence(absolute.startsWith(path.resolve(runDirectory) + path.sep), `C10 artifact path escaped the run directory: ${artifact.path}`);
    const stat = await fs.stat(absolute);
    requireEvidence(stat.size === artifact.byteLength && await sha256File(absolute) === artifact.sha256, `C10 artifact drifted: ${artifact.path}`);
  }
  if (requireCurrentSource) {
    const expectedClosurePaths = await expectedTemplateMatrixClosurePaths(root, rawManifest);
    requireEvidence(JSON.stringify(scorecard.implementationClosure.map((item) => item.path)) === JSON.stringify(expectedClosurePaths), "C10 implementation closure path set is incomplete or excessive.");
    for (const item of scorecard.implementationClosure) {
      const absolute = path.join(root, ...item.path.split("/"));
      requireEvidence(await sha256ImplementationFile(absolute) === item.sha256, `C10 implementation closure drifted: ${item.path}`);
    }
    requireEvidence(canonicalHash(scorecard.implementationClosure) === scorecard.implementationClosureHash, "C10 implementation closure hash drifted.");
  }
  return { valid: true, scorecardHash: scorecard.scorecardHash, artifactCount: scorecard.artifactInventory.length };
}

export async function verifyTemplateMatrixReview({ root, published, requireCurrentSource = true }) {
  const pointer = await readJson(path.join(published, "current.json"));
  requireEvidence(pointer.schemaVersion === "slidewright-template-matrix-current/v1" && pointer.run === `runs/${pointer.scorecardHash}`, "C10 current pointer is invalid.");
  const runDirectory = path.join(published, "runs", pointer.scorecardHash);
  const machine = await verifyTemplateMatrixEvidence({ root, runDirectory, requireCurrentSource });
  const reviewPointer = await readJson(path.join(published, "current-review.json"));
  requireEvidence(reviewPointer.schemaVersion === "slidewright-template-matrix-current-review/v1"
    && reviewPointer.scorecardHash === pointer.scorecardHash, "C10 current review pointer is stale.");
  const review = await readJson(path.join(published, ...reviewPointer.review.split("/")));
  const reviewBasis = { ...review };
  delete reviewBasis.reviewHash;
  requireEvidence(review.schemaVersion === "slidewright-template-matrix-review/v1" && review.valid === true
    && review.scorecardHash === pointer.scorecardHash && review.reviewHash === canonicalHash(reviewBasis)
    && review.artifacts.every((item) => item.verdict === "pass" && item.findings.length === 0), "C10 review is not hash-authenticated and fully GO.");
  const scorecard = await readJson(path.join(runDirectory, "scorecard.json"));
  const expectedReviewArtifacts = scorecard.fixtures.flatMap((fixture) => ["edited", "powerpoint-roundtrip", "powerpoint-roundtrip-repeat", "source", "visible-negative"].flatMap((deck) => (
    Array.from({ length: fixture.expected.slideCount }, (_, index) => ({
      fixtureId: fixture.id,
      deck,
      slide: index + 1,
      path: `fixtures/${fixture.id}/${deck}/slide-${index + 1}.png`,
    }))
  ))).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId) || left.deck.localeCompare(right.deck) || left.slide - right.slide);
  requireEvidence(scorecard.reviewArtifacts.length === expectedReviewArtifacts.length
    && scorecard.reviewArtifacts.every((item, index) => item.fixtureId === expectedReviewArtifacts[index].fixtureId
      && item.deck === expectedReviewArtifacts[index].deck && item.slide === expectedReviewArtifacts[index].slide
      && item.path === expectedReviewArtifacts[index].path), "C10 review artifact matrix was not re-derived from fixture slide counts.");
  requireEvidence(review.artifacts.length === scorecard.reviewArtifacts.length, "C10 review artifact inventory is incomplete.");
  for (let index = 0; index < scorecard.reviewArtifacts.length; index += 1) {
    const expected = scorecard.reviewArtifacts[index];
    const actual = review.artifacts[index];
    requireEvidence(actual.path === expected.path && actual.sha256 === expected.sha256, `C10 review binding drifted at artifact ${index}.`);
  }
  return { ...machine, reviewHash: review.reviewHash, reviewedArtifacts: review.artifacts.length };
}
