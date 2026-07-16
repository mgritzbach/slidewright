import fs from "node:fs";
import { compileDeck } from "../lib/compiler.mjs";
import { planContentHash } from "../lib/named-edits.mjs";

const demoSpec = JSON.parse(fs.readFileSync(new URL("../../../../../../examples/demo/deck-spec.json", import.meta.url), "utf8"));

function chartText(id, parentId, position, value) {
  return {
    id,
    type: "text",
    role: "chart-label",
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

function chartMark(id, parentId, category, value) {
  return {
    id,
    type: "shape",
    role: "chart-mark",
    parentId,
    chartSeriesId: "series-1",
    chartCategory: category,
    chartValue: value,
    geometry: "roundRect",
    position: { left: 244, top: 138 + ["North", "South", "East", "West"].indexOf(category) * 68, width: value * 4, height: 20 },
    fill: "#4F46E5",
    line: { color: "#4F46E5", width: 0 },
    editable: true,
  };
}

function chartSlide() {
  const categories = ["North", "South", "East", "West"];
  const values = [35, 52, 65, 80];
  const chartId = "horizontal-chart-component";
  const shapes = [{
    id: chartId,
    type: "shape",
    semanticType: "chart-component",
    role: "chart",
    geometry: "roundRect",
    position: { left: 96, top: 96, width: 640, height: 360 },
    fill: "#FFFFFF",
    line: { color: "#CBD5E1", width: 1 },
    padding: { top: 24, right: 24, bottom: 24, left: 24 },
    chart: {
      orientation: "horizontal",
      categories,
      maximum: 100,
      plotExtentPx: 400,
      series: [{ id: "series-1", values: [...values] }],
    },
    editable: true,
  }];
  categories.forEach((category, index) => {
    const top = 136 + index * 68;
    shapes.push(chartText(`${chartId}-label-${index + 1}`, chartId, { left: 120, top, width: 100, height: 24 }, category));
    shapes.push(chartMark(`${chartId}-mark-${index + 1}`, chartId, category, values[index]));
  });
  return {
    id: "iteration-chart",
    layout: "quality-fixture",
    background: "#F8FAFC",
    frame: { left: 64, top: 64, width: 1152, height: 592 },
    shapes,
  };
}

export function buildIterationPlan() {
  const plan = compileDeck(demoSpec);
  plan.slides[0].shapes.push({
    id: "s1-mutation-accent",
    type: "shape",
    role: "iteration-marker",
    geometry: "roundRect",
    position: { left: 1128, top: 112, width: 48, height: 48 },
    fill: "#F97316",
    line: { color: "#F97316", width: 0 },
    editable: true,
  });
  plan.slides = [plan.slides[0], plan.slides[1], chartSlide(), plan.slides[2]];
  plan.source.title = "Slidewright C16 isolated named-iteration benchmark";
  plan.build = { deterministicHash: planContentHash(plan).slice(0, 16) };
  return plan;
}

export function buildIterationManifests(plan) {
  const baselinePlanHash = planContentHash(plan);
  return [
    { id: "text", version: "c16-v1", baselinePlanHash, edit: { type: "text", targetId: "s1-body", value: "Slidewright turns content into native editable slides and verifies formatting before delivery." } },
    { id: "bold", version: "c16-v1", baselinePlanHash, edit: { type: "bold", targetId: "s1-title", runIndex: 0, value: true } },
    { id: "color", version: "c16-v1", baselinePlanHash, edit: { type: "color", targetId: "s1-callout-surface", value: "#C7D2FE" } },
    { id: "position", version: "c16-v1", baselinePlanHash, edit: { type: "position", targetId: "s1-mutation-accent", position: { left: 1096 } } },
    { id: "chart", version: "c16-v1", baselinePlanHash, edit: { type: "chart", targetId: "horizontal-chart-component", seriesId: "series-1", category: "South", value: 72 } },
    { id: "layout", version: "c16-v1", baselinePlanHash, edit: { type: "layout", slideId: "difference", columnGap: 48 } },
  ];
}
