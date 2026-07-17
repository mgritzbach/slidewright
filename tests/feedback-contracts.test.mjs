import assert from "node:assert/strict";
import test from "node:test";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { lintRenderedLayouts } from "../plugins/slidewright/skills/slidewright/scripts/lib/rendered-linter.mjs";
import { buildFeedbackSpec } from "../plugins/slidewright/skills/slidewright/scripts/benchmark/feedback_suite.mjs";
import fs from "node:fs";

function topicSpec() {
  return {
    version: "0.1",
    title: "Locate event feedback contract",
    coverage: {
      topics: [
        { id: "arrival", title: "Arrival" },
        { id: "program", title: "Program" },
      ],
    },
    slides: [
      {
        id: "arrival-divider",
        layout: "section",
        topicId: "arrival",
        coverageRole: "divider",
        title: "Arrival, registration, accessibility, and everything guests need before the program begins",
        subtitle: "A deliberately multiline divider proves that its white title region grows with native editable text.",
      },
      {
        id: "arrival-content",
        layout: "hero",
        topicId: "arrival",
        coverageRole: "substantive",
        eyebrow: "Arrival",
        title: "Find the venue without hunting through the deck",
        body: {
          paragraphs: [
            { bullet: true, runs: [{ text: "Enter through the east lobby." }] },
            { bullet: true, runs: [{ text: "   " }] },
            { bullet: true, level: 1, runs: [{ text: "Accessible entrance beside registration." }] },
            { bullet: true, runs: [{ text: "" }] },
            { bullet: true, runs: [{ text: "Staff check-in opens at 17:30." }] },
          ],
        },
        callout: "No empty inherited paragraph may emit a blank bullet or consume fit budget.",
      },
      {
        id: "program-divider",
        layout: "section",
        topicId: "program",
        coverageRole: "divider",
        title: "Program",
        subtitle: "Every declared chapter receives an explicit divider before substantive content.",
      },
      {
        id: "program-content",
        layout: "two-column",
        topicId: "program",
        coverageRole: "substantive",
        title: "The complete evening at a glance",
        left: { heading: "Talks", body: "Opening, keynote, and questions remain visible as native text." },
        right: { heading: "Community", body: "Break, introductions, and closing reception remain separately editable." },
      },
    ],
  };
}

function syntheticLayouts(plan) {
  return plan.slides.map((slide) => ({
    elements: slide.shapes.map((shape) => ({
      name: shape.id,
      bbox: [shape.position.left, shape.position.top, shape.position.width, shape.position.height],
      ...(shape.type === "text" ? {
        textLayout: { lineCount: shape.fit.lines },
        resolvedTextStyle: { insets: shape.style.insets },
        paragraphs: shape.text.paragraphs.map((paragraph) => ({
          spaceBefore: Math.round((paragraph.spaceBeforePt ?? 0) * 100),
          spaceAfter: Math.round((paragraph.spaceAfterPt ?? 0) * 100),
          runs: [{ fontSize: shape.style.fontSizePt * 4 / 3, lineSpacing: shape.style.lineHeight }],
        })),
      } : {}),
    })),
  }));
}

test("feedback contract compiles full-width headlines, growing title regions, coverage, and paragraph hygiene", () => {
  const plan = compileDeck(topicSpec());
  assert.equal(lintPlan(plan).valid, true, JSON.stringify(lintPlan(plan).diagnostics, null, 2));
  assert.equal(plan.hygiene.removedEmptyParagraphs, 2);
  assert.equal(plan.coverage.topics.length, 2);

  for (const slide of plan.slides) {
    const headline = slide.shapes.find((shape) => shape.id === slide.layoutContract.headline.shapeId);
    const container = slide.layoutContract.headline.containerId
      ? slide.shapes.find((shape) => shape.id === slide.layoutContract.headline.containerId)
      : null;
    const expectedLeft = container ? container.position.left + container.padding.left : slide.frame.left;
    const expectedRight = container ? container.position.left + container.position.width - container.padding.right : slide.frame.left + slide.frame.width;
    assert.equal(headline.position.left, expectedLeft);
    assert.equal(headline.position.left + headline.position.width, expectedRight);
  }

  const longDivider = plan.slides[0];
  const title = longDivider.shapes.find((shape) => shape.role === "title");
  const backing = longDivider.shapes.find((shape) => shape.role === "text-backing");
  assert.ok(title.fit.lines >= 2);
  assert.ok(backing.position.height > 128);
  assert.equal(backing.position.height, backing.padding.top + title.position.height + backing.padding.bottom);

  const body = plan.slides[1].shapes.find((shape) => shape.role === "body");
  assert.equal(body.text.paragraphs.length, 3);
  assert.equal(body.text.runs.filter((run) => run.text.includes("\u2022")).length, 3);
  assert.equal(lintRenderedLayouts(plan, syntheticLayouts(plan)).valid, true);
});

test("the full 17-topic feedback corpus respects the universal headline budget", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../fixtures/feedback/locate-event-v1/fixture-manifest.json", import.meta.url), "utf8"));
  const plan = compileDeck(buildFeedbackSpec(manifest));
  const report = lintPlan(plan);
  assert.equal(report.valid, true, JSON.stringify(report.diagnostics, null, 2));
  assert.equal(plan.slides.length, 34);
  for (const slide of plan.slides.filter((item) => item.coverageRole === "substantive")) {
    const title = slide.shapes.find((shape) => shape.role === "title");
    if (!title.headlinePolicy?.constrained) continue;
    assert.ok(title.fit.lines <= title.headlinePolicy.maximumLines);
    assert.ok(title.fit.autoSizeSteps <= title.headlinePolicy.maximumAutoSizeSteps);
  }
});

test("G24 rejects text overlap even when a generic waiver is present", () => {
  const plan = compileDeck(topicSpec());
  const slide = plan.slides[1];
  const title = slide.shapes.find((shape) => shape.role === "title");
  const body = slide.shapes.find((shape) => shape.role === "body");
  body.position.top = title.position.top + title.position.height - 1;
  body.constraints = { allowOverlapWith: [title.id] };
  const report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW018" && item.objectId === [title.id, body.id].join("|")));

  const layouts = syntheticLayouts(compileDeck(topicSpec()));
  const clean = compileDeck(topicSpec());
  const renderedTitle = layouts[1].elements.find((item) => item.name.endsWith("-title"));
  const renderedBody = layouts[1].elements.find((item) => item.name.endsWith("-body"));
  renderedBody.bbox[1] = renderedTitle.bbox[1] + renderedTitle.bbox[3] - 0.25;
  assert.ok(lintRenderedLayouts(clean, layouts).diagnostics.some((item) => item.ruleId === "SW018"));
});

test("G25 rejects shortened headlines and accepts active center and two-thirds boundaries", () => {
  const plan = compileDeck(topicSpec());
  const headline = plan.slides[1].shapes.find((shape) => shape.role === "title");
  headline.position.width -= 1;
  assert.ok(lintPlan(plan).diagnostics.some((item) => item.ruleId === "SW019"));

  for (const [ratio, fraction] of [["center", 0.5], ["two-thirds", 2 / 3]]) {
    const splitPlan = compileDeck(topicSpec());
    const slide = splitPlan.slides[1];
    const title = slide.shapes.find((shape) => shape.role === "title");
    const x = slide.frame.left + slide.frame.width * fraction;
    slide.shapes.push({
      id: `declared-${ratio}-split`, type: "shape", role: "structural-split", geometry: "rect",
      position: { left: x, top: title.position.top, width: 1, height: title.position.height },
      fill: "#CBD5E1", line: { color: "#CBD5E1", width: 0 }, editable: true,
    });
    slide.layoutContract.structuralSplits = [{ shapeId: `declared-${ratio}-split`, ratio, side: "left" }];
    title.position.width = x - title.position.left;
    const report = lintPlan(splitPlan);
    assert.equal(report.diagnostics.some((item) => item.ruleId === "SW019"), false, JSON.stringify(report.diagnostics, null, 2));

    const shifted = structuredClone(splitPlan);
    const shiftedSlide = shifted.slides[1];
    const shiftedTitle = shiftedSlide.shapes.find((shape) => shape.role === "title");
    const shiftedDivider = shiftedSlide.shapes.find((shape) => shape.id === `declared-${ratio}-split`);
    shiftedDivider.position.left += 0.5;
    shiftedTitle.position.width += 0.5;
    assert.ok(lintPlan(shifted).diagnostics.some((item) => item.ruleId === "SW019"));
  }
});

test("G26 rejects a title backing that is one pixel too short", () => {
  const plan = compileDeck(topicSpec());
  const backing = plan.slides[0].shapes.find((shape) => shape.role === "text-backing");
  backing.position.height -= 1;
  assert.ok(lintPlan(plan).diagnostics.some((item) => item.ruleId === "SW020" && item.objectId === backing.id));
});

test("G27 rejects missing, unsequenced, and merged-away topic coverage", () => {
  const missingDivider = compileDeck(topicSpec());
  missingDivider.slides = missingDivider.slides.filter((slide) => slide.id !== "program-divider");
  assert.ok(lintPlan(missingDivider).diagnostics.some((item) => item.ruleId === "SW021"));

  const reversed = compileDeck(topicSpec());
  [reversed.slides[2], reversed.slides[3]] = [reversed.slides[3], reversed.slides[2]];
  assert.ok(lintPlan(reversed).diagnostics.some((item) => item.ruleId === "SW021"));

  const merged = compileDeck(topicSpec());
  merged.slides.find((slide) => slide.id === "program-content").topicId = "arrival";
  assert.ok(lintPlan(merged).diagnostics.some((item) => item.ruleId === "SW021"));
});

test("G28 strips inherited empty paragraphs before fitting and rejects reinsertion", () => {
  const clean = compileDeck(topicSpec());
  const body = clean.slides[1].shapes.find((shape) => shape.role === "body");
  assert.equal(body.hygiene.removedEmptyParagraphs, 2);
  const cleanLines = body.fit.lines;

  const canonical = topicSpec();
  canonical.slides[1].body.paragraphs = canonical.slides[1].body.paragraphs.filter((paragraph) => paragraph.runs.some((run) => run.text.trim()));
  const canonicalBody = compileDeck(canonical).slides[1].shapes.find((shape) => shape.role === "body");
  assert.equal(body.fit.lines, canonicalBody.fit.lines);
  assert.equal(cleanLines, canonicalBody.fit.lines);

  body.text.paragraphs.splice(1, 0, { bullet: true, level: 0, runs: [{ text: "   ", bold: false }] });
  assert.ok(lintPlan(clean).diagnostics.some((item) => item.ruleId === "SW022" && item.objectId === body.id));
});
