import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compileDeck, validateDeckSpec } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { adaptDeckCopyToFit, auditAdaptedDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-adaptation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const fixture = JSON.parse(await readFile(new URL("../examples/consulting-layouts/deck-spec.json", import.meta.url), "utf8"));

test("count-aware consulting layouts compile and lint for every point count from 2 through 9", () => {
  const plan = compileDeck(fixture);
  const grids = plan.slides.filter((slide) => slide.layout === "point-grid");
  assert.deepEqual(grids.map((slide) => slide.layoutContract.peerGroups[0].memberIds.length), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(grids.map((slide) => slide.layoutContract.peerGroups[0].rows), [[2], [3], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [3, 3, 3]]);
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
});

test("point-grid rejects unsupported counts, duplicate ids, and multiple accidental emphases", () => {
  const tooMany = structuredClone(fixture.slides[0]);
  tooMany.items = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, label: `P${index}`, body: "Body" }));
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [tooMany] }), /2-9 points/u);

  const duplicate = structuredClone(fixture.slides[0]);
  duplicate.items[1].id = duplicate.items[0].id;
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [duplicate] }), /ids must be unique/u);

  const overemphasized = structuredClone(fixture.slides[1]);
  overemphasized.items[0].emphasis = true;
  overemphasized.items[1].emphasis = true;
  assert.throws(() => validateDeckSpec({ version: "0.2", title: "x", slides: [overemphasized] }), /at most one point/u);
});

test("SW031 rejects unequal peer widths and off-center incomplete rows", () => {
  const plan = compileDeck(fixture);
  const slide = plan.slides.find((item) => item.id === "five-points");
  const group = slide.layoutContract.peerGroups[0];
  slide.shapes.find((shape) => shape.id === group.memberIds.at(-1)).position.left += 7;
  const report = lintPlan(plan);
  assert.equal(report.valid, false);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW031" && item.slideId === "five-points"));
});

test("opposition preserves a balanced decision boundary and optional synthesis band", () => {
  const plan = compileDeck(fixture);
  const slide = plan.slides.find((item) => item.layout === "opposition");
  const group = slide.layoutContract.peerGroups[0];
  const [left, right] = group.memberIds.map((id) => slide.shapes.find((shape) => shape.id === id));
  assert.equal(left.position.width, right.position.width);
  assert.equal(right.position.left - (left.position.left + left.position.width), group.gap);
  assert.ok(slide.shapes.some((shape) => shape.id.endsWith("-synthesis") && shape.type === "text"));
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
});

test("copy adaptation preserves the new consulting layouts and their rich-text ownership", () => {
  const result = adaptDeckCopyToFit(fixture);
  const audit = auditAdaptedDeckCopy(fixture, result.spec, result.manifest, result.plan);
  assert.equal(audit.valid, true, JSON.stringify(audit.diagnostics, null, 2));
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "point-grid").length, 8);
  assert.equal(result.spec.slides.filter((slide) => slide.layout === "opposition").length, 1);
});
