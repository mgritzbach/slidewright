import test from "node:test";
import assert from "node:assert/strict";
import { FIDELITY_SUITE } from "../plugins/slidewright/skills/slidewright/scripts/benchmark/fidelity_suite.mjs";

const APPROVED = new Set([12, 14, 16, 18, 20, 24, 28, 32, 44]);

test("fidelity suite covers three families in horizontal and vertical forms", () => {
  assert.equal(FIDELITY_SUITE.slides.length, 6);
  for (const family of ["invite", "brochure", "website"]) {
    assert.deepEqual(new Set(FIDELITY_SUITE.slides.filter((slide) => slide.family === family).map((slide) => slide.orientation)), new Set(["horizontal", "vertical"]));
  }
});

test("fidelity suite uses stable unique native object names and approved integer typography", () => {
  for (const slide of FIDELITY_SUITE.slides) {
    assert.ok(slide.groupName.endsWith("editable"));
    const ids = slide.elements.map((element) => element.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const element of slide.elements.filter((item) => item.type === "text")) {
      assert.equal(Number.isInteger(element.style.fontSizePt), true);
      assert.equal(APPROVED.has(element.style.fontSizePt), true, `${element.id} uses ${element.style.fontSizePt}pt`);
      for (const run of element.text.runs) {
        assert.equal(APPROVED.has(run.fontSizePt), true, `${element.id} run uses ${run.fontSizePt}pt`);
      }
    }
  }
});

test("suite includes mixed emphasis, rotation, horizontal bars, and vertical bars", () => {
  const elements = FIDELITY_SUITE.slides.flatMap((slide) => slide.elements);
  assert.ok(elements.some((element) => element.type === "text" && new Set(element.text.runs.map((run) => run.bold)).size > 1));
  assert.ok(elements.some((element) => element.position.rotation === -90));
  assert.ok(elements.some((element) => element.id.includes("brochure-h-bar")));
  assert.ok(elements.some((element) => element.id.includes("web-v-bar")));
});
