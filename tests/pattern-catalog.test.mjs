import assert from "node:assert/strict";
import { test } from "node:test";
import { compileDeck, validateDeckSpec } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import {
  getPattern,
  instantiatePattern,
  instantiatePatternRequest,
  listPatterns,
  loadPatternCatalog,
  patternSemanticCoverage,
  selectPattern,
  validatePatternCatalog,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/pattern-catalog.mjs";

test("catalog contains exactly 100 immutable stable recipes with the governed portfolio mix", async () => {
  const catalog = await loadPatternCatalog();
  assert.equal(catalog.patterns.length, 100);
  assert.equal(new Set(catalog.patterns.map((pattern) => pattern.id)).size, 100);
  assert.deepEqual(catalog.patterns.map((pattern) => pattern.ordinal), Array.from({ length: 100 }, (_, index) => index + 1));
  assert.deepEqual(
    Object.fromEntries(["classic-analytical", "contemporary-geometric", "bold-narrative"].map((styleClass) => [styleClass, catalog.patterns.filter((pattern) => pattern.styleClass === styleClass).length])),
    { "classic-analytical": 60, "contemporary-geometric": 30, "bold-narrative": 10 },
  );
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.patterns[0].designContract));
  assert.deepEqual(
    Object.fromEntries(["pass", "revise", "veto"].map((status) => [status, catalog.patterns.filter((pattern) => pattern.visualReview.status === status).length])),
    { pass: 5, revise: 16, veto: 79 },
  );
  assert.equal(validatePatternCatalog(structuredClone(catalog)).patterns.length, 100);
});

test("all 100 recipes instantiate through existing archetypes and pass the production compiler and linter", async () => {
  const patterns = await listPatterns();
  const hashes = [];
  for (const pattern of patterns) {
    const spec = await instantiatePattern(pattern.id);
    assert.equal(validateDeckSpec(structuredClone(spec)).slides.length, 1, pattern.id);
    const first = compileDeck(structuredClone(spec));
    const second = compileDeck(structuredClone(spec));
    const third = compileDeck(structuredClone(spec));
    assert.equal(first.build.deterministicHash, second.build.deterministicHash, pattern.id);
    assert.equal(first.build.deterministicHash, third.build.deterministicHash, pattern.id);
    const report = lintPlan(first);
    assert.equal(report.valid, true, `${pattern.id}: ${JSON.stringify(report.diagnostics)}`);
    hashes.push(first.build.deterministicHash);
  }
  assert.equal(hashes.length, 100);
});

test("selector is deterministic, semantic-first, count-aware, and returns a hash receipt", async () => {
  const intent = { purpose: "compare", relationship: "trade-off", itemCount: 2, density: "standard", dataMode: "mixed" };
  const receipts = await Promise.all([selectPattern(intent), selectPattern(intent), selectPattern(structuredClone(intent))]);
  assert.deepEqual(receipts[0], receipts[1]);
  assert.deepEqual(receipts[0], receipts[2]);
  assert.match(receipts[0].catalogSha256, /^[a-f0-9]{64}$/u);
  assert.match(receipts[0].intentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipts[0].selectedId, "c011-pro-con-with-asymmetric-recommendation");
  assert.ok(receipts[0].candidates[0].reasons.includes("purpose:exact"));
  assert.ok(receipts[0].candidates[0].reasons.includes("relationship:exact"));
  assert.ok(receipts[0].candidates[0].reasons.includes("item-count:compatible"));
});

test("catalog generation returns an ordinary v0.2 spec and records explicit or selected pattern identity", async () => {
  const selected = await instantiatePatternRequest({ patternId: "c043-five-capability-pentagon" });
  assert.equal(selected.spec.version, "0.2");
  assert.equal(selected.spec.slides.length, 1);
  assert.equal(selected.spec.slides[0].id, selected.receipt.selectedId);
  const explicit = await instantiatePatternRequest({ patternId: "c039-two-pole-tension-axis", themeProfileId: "midnight" });
  assert.equal(explicit.receipt.explicitPattern, true);
  assert.equal(explicit.spec.slides[0].layout, "opposition");
  assert.equal(explicit.spec.theme.colors.accent, "#0E7490");
});

test("catalog fails closed on unknown IDs, parameters, coordinates, and incompatible counts", async () => {
  await assert.rejects(() => getPattern("missing"), /unknown pattern id/u);
  await assert.rejects(() => instantiatePatternRequest({ patternId: "c001-single-answer-with-three-proofs", mystery: true }), /unsupported key/u);
  await assert.rejects(() => selectPattern({ purpose: "compare", position: { left: 1, top: 2 } }), /coordinate key/u);
  await assert.rejects(() => instantiatePattern("c040-three-discipline-triangle", { itemCount: 12 }), /within 3-3/u);
  await assert.rejects(() => instantiatePattern("c001-single-answer-with-three-proofs", { title: "Valid", width: 400 }), /unsupported key/u);
  await assert.rejects(() => instantiatePatternRequest({ patternId: "c040-three-discipline-triangle" }), /cannot generate a release candidate/u);
});

test("every recipe carries the production specification and provenance required for review", async () => {
  for (const pattern of await listPatterns()) {
    assert.ok(["reviewed-release-candidate", "engine-backed-recipe", "structural-blueprint"].includes(pattern.implementationLevel));
    assert.ok(pattern.designContract.intent);
    assert.ok(pattern.designContract.argumentSchema);
    assert.deepEqual(pattern.designContract.supportedItemCounts, [pattern.selector.itemCountRange.minimum, pattern.selector.itemCountRange.maximum]);
    assert.ok(pattern.designContract.gridAndSafeZones.includes("64px"));
    assert.ok(pattern.designContract.connectorPolicy.includes("behind"));
    assert.ok(pattern.designContract.nativeEditabilityContract.includes("native editable"));
    assert.ok(pattern.designContract.renderTests.includes("no-overlap"));
    assert.ok(pattern.designContract.ooxmlTests.includes("run-level-emphasis"));
    assert.ok(pattern.semanticSignature.requiredMarks.length >= 2);
    assert.equal(pattern.semanticSignature.fallbackForbidden, true);
    assert.equal(pattern.visualReview.reviewedAtFullSize, true);
    if (pattern.visualReview.status === "pass") assert.equal(patternSemanticCoverage(pattern).complete, true, pattern.id);
    assert.equal(pattern.provenance.kind, "original-structural-synthesis");
    assert.equal(pattern.provenance.researchSet.length, 6);
  }
});
