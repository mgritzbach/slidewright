import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { mutateDeckCopy, mutateString } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-mutation.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const spec = JSON.parse(await fs.readFile(new URL("../examples/demo/deck-spec.json", import.meta.url), "utf8"));

test("copy mutator produces whole-word 75% and 125% fixtures", () => {
  const value = "A deterministic editable formatting sentence with enough words";
  const count = value.split(/\s+/u).length;
  assert.equal(mutateString(value, 0.75).split(/\s+/u).length, Math.round(count * 0.75));
  assert.equal(mutateString(value, 1.25).split(/\s+/u).length, Math.round(count * 1.25));
});

for (const factor of [0.75, 1.25]) {
  test(`${Math.round(factor * 100)}% copy fixture compiles without clipping or sub-minimum type`, () => {
    const plan = compileDeck(mutateDeckCopy(spec, factor));
    const report = lintPlan(plan);
    assert.equal(report.valid, true, JSON.stringify(report.diagnostics, null, 2));
    for (const shape of plan.slides.flatMap((slide) => slide.shapes).filter((shape) => shape.type === "text")) {
      assert.equal(shape.fit.fits, true, shape.id);
      assert.equal(Number.isInteger(shape.style.fontSizePt), true, shape.id);
      assert.ok(shape.style.fontSizePt >= 16 || shape.role === "eyebrow", shape.id);
    }
  });
}
