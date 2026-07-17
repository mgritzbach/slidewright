import fs from "node:fs";
import { compileDeck } from "../../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";

const demoSpec = JSON.parse(fs.readFileSync(new URL("../../examples/demo/deck-spec.json", import.meta.url), "utf8"));

export function validDemoPlan() {
  return compileDeck(demoSpec);
}

function chartText(id, parentId, position, value) {
  return {
    id,
    type: "text",
    role: "chart-label",
    typographyRole: "chart-label",
    parentId,
    position,
    text: { runs: [{ text: value, bold: false }] },
    style: {
      typeface: "Arial",
      color: "#0F172A",
      fontSizePt: 12,
      lineHeight: 1,
      alignment: "center",
      verticalAlignment: "middle",
      insets: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    fit: { fits: true, lines: 1, minSizePt: 12, preferredSizePt: 12, maxLines: 1, glyphFactor: 0.52, autoSized: false },
    editable: true,
  };
}

function chartMark(id, parentId, position) {
  return {
    id,
    type: "shape",
    role: "chart-mark",
    parentId,
    chartSeriesId: "series-1",
    geometry: "roundRect",
    position,
    fill: "#4F46E5",
    line: { color: "#4F46E5", width: 0 },
    editable: true,
  };
}

function readableChartSlide(orientation, template) {
  const chartId = `${orientation}-chart-component`;
  const root = {
    id: chartId,
    type: "shape",
    semanticType: "chart-component",
    role: "chart",
    geometry: "roundRect",
    position: { left: 600, top: 330, width: 560, height: 190 },
    fill: "#FFFFFF",
    line: { color: "#CBD5E1", width: 1 },
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
    chart: { orientation },
    editable: true,
  };
  const labels = ["North", "South", "East", "West"];
  const slide = structuredClone(template);
  slide.id = `readable-${orientation}-chart`;
  slide.shapes.find((shape) => shape.role === "body").position.width = 480;
  const shapes = [root];
  if (orientation === "horizontal") {
    const widths = [90, 150, 220, 300];
    labels.forEach((label, index) => {
      const top = 354 + index * 36;
      shapes.push(chartText(`${chartId}-label-${index + 1}`, chartId, { left: 624, top, width: 88, height: 20 }, label));
      shapes.push(chartMark(`${chartId}-mark-${index + 1}`, chartId, { left: 730, top: top + 2, width: widths[index], height: 16 }));
    });
  } else {
    const heights = [40, 70, 90, 110];
    labels.forEach((label, index) => {
      const left = 680 + index * 110;
      shapes.push(chartMark(`${chartId}-mark-${index + 1}`, chartId, { left, top: 470 - heights[index], width: 28, height: heights[index] }));
      shapes.push(chartText(`${chartId}-label-${index + 1}`, chartId, { left: left - 26, top: 474, width: 80, height: 20 }, label));
    });
  }
  slide.shapes.push(...shapes);
  return slide;
}

export function readableChartPlan() {
  const spec = structuredClone(demoSpec);
  spec.slides = [{
    id: "chart-template",
    layout: "hero",
    eyebrow: "DATA",
    title: "Readable native chart",
    body: "Labels and marks remain editable.",
    callout: "Both horizontal and vertical directions are tested.",
  }];
  const plan = compileDeck(spec);
  const template = plan.slides[0];
  plan.slides = [readableChartSlide("horizontal", template), readableChartSlide("vertical", template)];
  return plan;
}

export const negativeQualityFixtures = [
  {
    id: "clipping",
    ruleId: "SW001",
    expectedDiagnostic: { ruleId: "SW001", severity: "error", slideId: "promise", objectId: "canvas-clipping-fixture", message: "Object extends outside the slide canvas.", suggestion: "Move or resize the object inside the canvas." },
    build() {
      const plan = validDemoPlan();
      plan.slides[0].shapes.push({
        id: "canvas-clipping-fixture",
        type: "shape",
        geometry: "roundRect",
        position: { left: -2, top: 400, width: 1, height: 1 },
        fill: "#4F46E5",
        line: { color: "#4F46E5", width: 0 },
        editable: true,
      });
      return plan;
    },
  },
  {
    id: "parent-inner-clipping",
    ruleId: "SW016",
    expectedDiagnostic: { ruleId: "SW016", severity: "error", slideId: "promise", objectId: "s1-callout", message: "Child object is clipped by or escapes parent 's1-callout-surface'.", suggestion: "Keep the child inside the parent's padded inner bounds or correct the parent relationship." },
    expectedDiagnostics: [
      { ruleId: "SW024", severity: "error", slideId: "promise", objectId: "s1-callout", message: "Text content 's1-callout' is not fully contained by backing 's1-callout-surface' and its padding.", suggestion: "Grow the backing, shorten the text, or select another archetype; visible text may never spill beyond its covering block." },
      { ruleId: "SW016", severity: "error", slideId: "promise", objectId: "s1-callout", message: "Child object is clipped by or escapes parent 's1-callout-surface'.", suggestion: "Keep the child inside the parent's padded inner bounds or correct the parent relationship." },
    ],
    build() {
      const plan = validDemoPlan();
      plan.slides[0].shapes.find((shape) => shape.role === "callout").position.width += 16;
      return plan;
    },
  },
  {
    id: "overflow",
    ruleId: "SW004",
    expectedDiagnostic: { ruleId: "SW004", severity: "error", slideId: "promise", objectId: "s1-body", message: "Text does not fit at the configured size (recomputed 2 lines, 64px high).", suggestion: "Shorten the copy, enlarge the frame, or select a less dense layout." },
    build() {
      const plan = validDemoPlan();
      plan.slides[0].shapes.find((shape) => shape.role === "body").position.height = 20;
      return plan;
    },
  },
  {
    id: "overlap",
    ruleId: "SW018",
    expectedDiagnostic: { ruleId: "SW018", severity: "error", slideId: "promise", objectId: "s1-title|s1-body", message: "Text boxes 's1-title' and 's1-body' intersect.", suggestion: "Relayout the slide; text-to-text and text-to-reserved-region intersections can never be waived." },
    build() {
      const plan = validDemoPlan();
      plan.slides[0].shapes.find((shape) => shape.role === "body").position.top = 170;
      return plan;
    },
  },
  {
    id: "contrast",
    ruleId: "SW011",
    expectedDiagnostic: { ruleId: "SW011", severity: "error", slideId: "promise", objectId: "s1-title", message: "Text contrast 1.00:1 for #F8FAFC on #F8FAFC; minimum is 3:1.", suggestion: "Use a foreground/background pair that meets the large- or normal-text contrast threshold." },
    build() {
      const plan = validDemoPlan();
      plan.slides[0].shapes.find((shape) => shape.role === "title").style.color = "#F8FAFC";
      return plan;
    },
  },
  {
    id: "alignment",
    ruleId: "SW012",
    expectedDiagnostic: { ruleId: "SW012", severity: "error", slideId: "promise", objectId: "s1-body", message: "Alignment constraint failed for left against 's1-title'.", suggestion: "Align the declared edges/centers or update the explicit alignment constraint." },
    build() {
      const plan = validDemoPlan();
      const body = plan.slides[0].shapes.find((shape) => shape.role === "body");
      body.position.left += 12;
      return plan;
    },
  },
  {
    id: "opaque-occlusion",
    ruleId: "SW010",
    expectedDiagnostic: { ruleId: "SW010", severity: "error", slideId: "promise", objectId: "s1-title|opaque-title-occluder", message: "Undeclared overlap between 's1-title' and 'opaque-title-occluder'.", suggestion: "Move the objects apart or declare the intentional overlap explicitly on one object." },
    build() {
      const plan = validDemoPlan();
      const title = plan.slides[0].shapes.find((shape) => shape.role === "title");
      plan.slides[0].shapes.push({
        id: "opaque-title-occluder",
        type: "shape",
        geometry: "roundRect",
        position: { ...title.position },
        fill: "#F8FAFC",
        line: { color: "#F8FAFC", width: 0 },
        editable: true,
      });
      return plan;
    },
  },
  {
    id: "wrapping",
    ruleId: "SW013",
    expectedDiagnostic: { ruleId: "SW013", severity: "error", slideId: "promise", objectId: "s1-title", message: "Text wraps to 2 lines but the contract allows 1.", suggestion: "Shorten the copy, widen the text frame, or choose a layout that explicitly permits more lines." },
    build() {
      const plan = validDemoPlan();
      const title = plan.slides[0].shapes.find((shape) => shape.role === "title");
      title.fit.maxLines = 1;
      title.fit.lines = 2;
      title.fit.glyphFactor = 0.1;
      return plan;
    },
  },
  {
    id: "crowding",
    ruleId: "SW014",
    expectedDiagnostic: { ruleId: "SW014", severity: "error", slideId: "promise", objectId: null, message: "Crowded layout: 100.0% occupancy exceeds 94.0%.", suggestion: "Remove, split, or relayout content to restore the declared whitespace, object-count, and peer-gap budgets." },
    build() {
      const plan = validDemoPlan();
      const slide = plan.slides[0];
      slide.shapes.unshift({
        id: "crowded-surface",
        type: "shape",
        position: { left: slide.frame.left, top: slide.frame.top, width: slide.frame.width, height: slide.frame.height * 0.96 },
        fill: slide.background,
        line: { color: slide.background, width: 0 },
        constraints: { allowOverlapWith: slide.shapes.map((shape) => shape.id) },
        editable: true,
      });
      return plan;
    },
  },
  {
    id: "chart-small-label",
    ruleId: "SW015",
    expectedDiagnostic: { ruleId: "SW015", severity: "error", slideId: "readable-horizontal-chart", objectId: "horizontal-chart-component", message: "Chart readability failed: labels must use an integer size of at least 12pt.", suggestion: "Increase plot/label size, reduce series or categories, thicken marks, and restore label contrast." },
    expectedDiagnostics: [
      { ruleId: "SW015", severity: "error", slideId: "readable-horizontal-chart", objectId: "horizontal-chart-component", message: "Chart readability failed: labels must use an integer size of at least 12pt.", suggestion: "Increase plot/label size, reduce series or categories, thicken marks, and restore label contrast." },
      { ruleId: "SW009", severity: "error", slideId: "readable-horizontal-chart", objectId: "horizontal-chart-component-label-1", message: "Font size 10pt is below the configured 12pt minimum.", suggestion: "Shorten the copy or choose a less dense layout; never bypass the minimum type size." },
    ],
    build() {
      const plan = readableChartPlan();
      plan.layout.approvedFontSizesPt.push(10);
      const label = plan.slides[0].shapes.find((shape) => shape.role === "chart-label");
      label.style.fontSizePt = 10;
      return plan;
    },
  },
  {
    id: "chart-label-collision",
    ruleId: "SW015",
    expectedDiagnostic: { ruleId: "SW015", severity: "error", slideId: "readable-horizontal-chart", objectId: "horizontal-chart-component", message: "Chart readability failed: derived label geometry collides.", suggestion: "Increase plot/label size, reduce series or categories, thicken marks, and restore label contrast." },
    build() {
      const plan = readableChartPlan();
      const labels = plan.slides[0].shapes.filter((shape) => shape.role === "chart-label");
      labels[1].position = { ...labels[0].position };
      labels[0].constraints = { allowOverlapWith: [labels[1].id] };
      return plan;
    },
  },
  {
    id: "chart-invisible-marks",
    ruleId: "SW015",
    expectedDiagnostic: { ruleId: "SW015", severity: "error", slideId: "readable-horizontal-chart", objectId: "horizontal-chart-component", message: "Chart readability failed: derived mark contrast must be at least 3:1.", suggestion: "Increase plot/label size, reduce series or categories, thicken marks, and restore label contrast." },
    build() {
      const plan = readableChartPlan();
      for (const mark of plan.slides[0].shapes.filter((shape) => shape.role === "chart-mark")) {
        mark.fill = "#FFFFFF";
        mark.line.color = "#FFFFFF";
      }
      return plan;
    },
  },
];
