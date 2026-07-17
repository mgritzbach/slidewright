import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { adaptDeckCopyToFit, auditAdaptedDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { mutateDeckCopy, mutateFlexibleDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-mutation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const source = JSON.parse(await fs.readFile(new URL("../examples/demo/deck-spec.json", import.meta.url), "utf8"));
const translation = JSON.parse(await fs.readFile(new URL("../fixtures/copy-resilience/v1/translation-de-spec.json", import.meta.url), "utf8"));
const fixtureManifest = JSON.parse(await fs.readFile(new URL("../fixtures/copy-resilience/v1/fixture-manifest.json", import.meta.url), "utf8"));

test("continuation layout remains native, full-width, integer-sized, and above role minima", () => {
  const spec = structuredClone(source);
  spec.slides = [{ id: "continued", layout: "continuation", eyebrow: "Continued · body", title: "A continuation title", body: "Editable continuation copy with native text." }];
  const plan = compileDeck(spec);
  const report = lintPlan(plan);
  assert.equal(report.valid, true, JSON.stringify(report.diagnostics, null, 2));
  assert.equal(plan.slides[0].shapes.some((shape) => shape.type === "text" && shape.editable), true);
  for (const shape of plan.slides[0].shapes.filter((item) => item.type === "text")) {
    assert.equal(shape.fit.fits, true, shape.id);
    assert.equal(Number.isInteger(shape.style.fontSizePt), true, shape.id);
    assert.ok(shape.style.fontSizePt >= shape.fit.minSizePt, shape.id);
  }
});

test("pinned German translation closes without font shrinking below the quality floor", () => {
  const result = adaptDeckCopyToFit(translation);
  assert.equal(result.manifest.continuationSlideCount, 0);
  assert.equal(lintPlan(result.plan).valid, true);
  assert.equal(auditAdaptedDeckCopy(translation, result.spec, result.manifest, result.plan).valid, true);
});

for (const factor of [2, 4]) {
  test(`${factor}x flexible copy fails fixed topology and succeeds through deterministic continuation relayout`, () => {
    const dense = mutateFlexibleDeckCopy(source, factor);
    assert.equal(lintPlan(compileDeck(dense)).valid, false);
    const first = adaptDeckCopyToFit(dense);
    const second = adaptDeckCopyToFit(dense);
    assert.ok(first.manifest.continuationSlideCount > 0);
    assert.ok(first.spec.slides.length > dense.slides.length);
    assert.deepEqual(first.spec, second.spec);
    assert.deepEqual(first.manifest, second.manifest);
    assert.deepEqual(first.plan, second.plan);
    assert.equal(auditAdaptedDeckCopy(dense, first.spec, first.manifest, first.plan).valid, true);
    for (const shape of first.plan.slides.flatMap((slide) => slide.shapes).filter((item) => item.type === "text")) {
      assert.equal(shape.fit.fits, true, shape.id);
      assert.equal(Number.isInteger(shape.style.fontSizePt), true, shape.id);
      assert.ok(shape.style.fontSizePt >= shape.fit.minSizePt, shape.id);
    }
  });
}

test("dense mixed-emphasis copy retains normalized word order and per-word formatting across splits", () => {
  const rich = structuredClone(source);
  rich.slides[0].body = { runs: [{ text: "Evidence remains editable ", bold: true }, { text: "while dense copy moves across continuation slides", bold: false, italic: true }] };
  const dense = mutateFlexibleDeckCopy(rich, 8);
  const result = adaptDeckCopyToFit(dense);
  const field = result.manifest.fields.find((item) => item.sourceSlideId === "promise" && item.sourceField === "body");
  assert.ok(field.chunkCount > 1);
  assert.equal(auditAdaptedDeckCopy(dense, result.spec, result.manifest, result.plan).valid, true);
  const runs = result.plan.slides.flatMap((slide) => slide.shapes).filter((shape) => shape.id.endsWith("-body")).flatMap((shape) => shape.text.runs);
  assert.equal(runs.some((run) => run.bold === true), true);
  assert.equal(runs.some((run) => run.italic === true), true);
});

test("adaptation explicitly normalizes whitespace and compatible run boundaries without losing word formatting", () => {
  const rich = structuredClone(source);
  rich.slides[0].body = { runs: [
    { text: "Evidence   remains\n", bold: true },
    { text: " editable", bold: true },
    { text: " while formatting survives", italic: true },
  ] };
  const dense = mutateFlexibleDeckCopy(rich, 8);
  const result = adaptDeckCopyToFit(dense);
  const audit = auditAdaptedDeckCopy(dense, result.spec, result.manifest, result.plan);
  assert.equal(audit.valid, true, JSON.stringify(audit.diagnostics, null, 2));
  assert.ok(result.manifest.fields.find((item) => item.sourceSlideId === "promise" && item.sourceField === "body").chunkCount > 1);
});

test("adaptation audit rejects dropped, duplicated, reordered, and forged continuation evidence", () => {
  const dense = mutateFlexibleDeckCopy(source, 4);
  const result = adaptDeckCopyToFit(dense);
  const continuations = result.spec.slides.filter((slide) => slide.layout === "continuation");
  assert.ok(continuations.length > 1);

  const dropped = structuredClone(result.spec);
  dropped.slides = dropped.slides.filter((slide) => slide.id !== continuations[0].id);
  assert.equal(auditAdaptedDeckCopy(dense, dropped, result.manifest, result.plan).valid, false);

  const duplicated = structuredClone(result.spec);
  duplicated.slides.push(structuredClone(continuations[0]));
  assert.equal(auditAdaptedDeckCopy(dense, duplicated, result.manifest, result.plan).valid, false);

  const reordered = structuredClone(result.spec);
  const first = reordered.slides.findIndex((slide) => slide.id === continuations[0].id);
  const second = reordered.slides.findIndex((slide) => slide.id === continuations[1].id);
  [reordered.slides[first], reordered.slides[second]] = [reordered.slides[second], reordered.slides[first]];
  assert.equal(auditAdaptedDeckCopy(dense, reordered, result.manifest, result.plan).valid, false);

  const forged = structuredClone(result.manifest);
  forged.fields[0].sha256 = "0".repeat(64);
  assert.equal(auditAdaptedDeckCopy(dense, result.spec, forged, result.plan).valid, false);
});

test("adaptation controls bind failures to stable diagnostic codes", () => {
  const dense = mutateFlexibleDeckCopy(source, 4);
  const result = adaptDeckCopyToFit(dense);
  const continuationIndex = result.spec.slides.findIndex((slide) => slide.layout === "continuation");
  const dropped = structuredClone(result.spec);
  dropped.slides.splice(continuationIndex, 1);
  assert.deepEqual(
    auditAdaptedDeckCopy(dense, dropped, result.manifest, result.plan).diagnostics.map((item) => item.code),
    ["CA001", "CA004"],
  );
  const forgedPlan = structuredClone(result.plan);
  const body = forgedPlan.slides[0].shapes.find((shape) => shape.role === "body");
  body.position.height = 1;
  body.fit.fits = true;
  const forgedAudit = auditAdaptedDeckCopy(dense, result.spec, result.manifest, forgedPlan);
  assert.deepEqual(forgedAudit.diagnostics.map((item) => item.code), ["CA003", "CA005"]);
  assert.deepEqual(forgedAudit.lintRuleIds, ["SW004"]);
});

test("adaptation refuses unsplittable headlines and a caller-bounded slide ceiling", () => {
  assert.throws(() => adaptDeckCopyToFit(mutateDeckCopy(source, 4)), /non-splittable text/u);
  assert.throws(() => adaptDeckCopyToFit(mutateFlexibleDeckCopy(source, 4), { maxSlides: 3 }), /slide safety ceiling/u);
});

test("C15 evidence contract freezes translation, dense positives, and intended destructive controls", () => {
  assert.deepEqual(fixtureManifest.cases.map((item) => item.id), ["minus-25", "plus-25", "translation-de", "dense-200", "dense-400"]);
  assert.equal(fixtureManifest.cases.find((item) => item.id === "translation-de").kind, "human-authored-translation");
  assert.equal(fixtureManifest.cases.find((item) => item.id === "dense-200").expectFixedLayoutFailure, true);
  assert.equal(fixtureManifest.cases.find((item) => item.id === "dense-400").expectAdaptation, true);
  assert.deepEqual(fixtureManifest.destructiveControls, [
    "drop-continuation", "duplicate-continuation", "reorder-continuations", "tamper-source-hash", "tamper-chunk-ownership",
    "forged-fit", "subminimum-type", "fractional-type", "text-overlap", "rasterized-text",
  ]);
});

test("guarded request builds and review finalization bind adaptive evidence", async () => {
  const requestBuild = await fs.readFile(new URL("../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs", import.meta.url), "utf8");
  const finalizer = await fs.readFile(new URL("../scripts/finalize-copy-resilience-review.mjs", import.meta.url), "utf8");
  assert.match(requestBuild, /adaptDeckCopyToFit\(request\.spec\)/u);
  assert.match(requestBuild, /adapted-spec\.json/u);
  assert.match(requestBuild, /adaptation\.json/u);
  assert.match(finalizer, /individual-original-resolution/u);
  assert.match(finalizer, /montageAcceptedAsEvidence:\s*false/u);
  assert.match(finalizer, /actualHash !== want\.sha256/u);
});
