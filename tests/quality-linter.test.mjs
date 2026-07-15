import assert from "node:assert/strict";
import test from "node:test";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { lintRenderedLayouts } from "../plugins/slidewright/skills/slidewright/scripts/lib/rendered-linter.mjs";
import { negativeQualityFixtures, readableChartPlan, validDemoPlan } from "./fixtures/quality-linter-fixtures.mjs";

test("quality linter accepts the positive layout and readable-chart fixtures", () => {
  for (const [name, plan] of [["layout", validDemoPlan()], ["chart", readableChartPlan()]]) {
    const report = lintPlan(plan);
    assert.equal(report.valid, true, `${name}: ${JSON.stringify(report.diagnostics, null, 2)}`);
  }
});

for (const fixture of negativeQualityFixtures) {
  test(`quality linter rejects ${fixture.id}`, () => {
    const report = lintPlan(fixture.build());
    assert.equal(report.valid, false);
    assert.deepEqual(report.diagnostics, [fixture.expectedDiagnostic]);
  });
}

test("quality linter allows only explicitly declared or parent-contained overlap", () => {
  const plan = validDemoPlan();
  const title = plan.slides[0].shapes.find((shape) => shape.role === "title");
  const body = plan.slides[0].shapes.find((shape) => shape.role === "body");
  body.position.top = 170;
  body.constraints = { allowOverlapWith: [title.id] };
  const report = lintPlan(plan);
  assert.equal(report.diagnostics.some((item) => item.ruleId === "SW010"), false, JSON.stringify(report.diagnostics, null, 2));
});

function syntheticLayouts(plan) {
  return plan.slides.map((slide) => ({
    elements: slide.shapes.map((shape) => ({
      name: shape.id,
      bbox: [shape.position.left, shape.position.top, shape.position.width, shape.position.height],
      ...(shape.type === "text" ? {
        textLayout: { lineCount: shape.fit.lines },
        resolvedTextStyle: { insets: shape.style.insets },
        paragraphs: [{
          runs: [{ fontSize: shape.style.fontSizePt * 4 / 3, lineSpacing: shape.style.lineHeight }],
        }],
      } : {}),
    })),
  }));
}

test("rendered-layout lint catches actual wrapping that a permissive plan estimate misses", () => {
  const plan = validDemoPlan();
  const title = plan.slides[0].shapes.find((shape) => shape.role === "title");
  title.fit.maxLines = 1;
  title.fit.lines = 1;
  title.fit.glyphFactor = 0.1;
  assert.equal(lintPlan(plan).valid, true);
  const layouts = syntheticLayouts(plan);
  layouts[0].elements.find((element) => element.name === title.id).textLayout.lineCount = 2;
  const report = lintRenderedLayouts(plan, layouts);
  assert.equal(report.valid, false);
  assert.deepEqual([...new Set(report.diagnostics.map((item) => item.ruleId))], ["SW013"]);
});

test("rendered-layout lint rejects missing named objects", () => {
  const plan = validDemoPlan();
  const layouts = syntheticLayouts(plan);
  layouts[0].elements.shift();
  const report = lintRenderedLayouts(plan, layouts);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW017"));
});
