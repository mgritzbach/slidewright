import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const spec = JSON.parse(await fs.readFile(new URL("../examples/demo/deck-spec.json", import.meta.url), "utf8"));

test("compiler output is deterministic", () => {
  const first = compileDeck(spec);
  const second = compileDeck(spec);
  assert.deepEqual(second, first);
  assert.equal(first.build.deterministicHash, second.build.deterministicHash);
});

test("demo plan passes all formatting rules", () => {
  const report = lintPlan(compileDeck(spec));
  assert.equal(report.valid, true, JSON.stringify(report.diagnostics, null, 2));
});

test("linter rejects asymmetric outer margins", () => {
  const plan = compileDeck(spec);
  plan.slides[0].frame.left += 5;
  const report = lintPlan(plan);
  assert.equal(report.valid, false);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW006"));
});

test("linter rejects asymmetric component padding", () => {
  const plan = compileDeck(spec);
  const surface = plan.slides[0].shapes.find((shape) => shape.padding);
  surface.padding.right += 8;
  const report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW007"));
});

test("linter rejects fractional and nonstandard font sizes", () => {
  const plan = compileDeck(spec);
  const title = plan.slides[0].shapes.find((shape) => shape.role === "title");
  title.style.fontSizePt = 37.5;
  let report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW003"));

  title.style.fontSizePt = 37;
  report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW002"));
});
