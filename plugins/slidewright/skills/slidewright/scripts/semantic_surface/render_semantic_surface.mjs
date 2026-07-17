#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const CANVAS = { width: 1280, height: 720 };
const C = {
  navy: "#10233F",
  ink: "#172033",
  muted: "#5E6A7D",
  blue: "#2F6BFF",
  cyan: "#40C4D8",
  chartTeal: "#168DA1",
  green: "#22A06B",
  orange: "#F58A3D",
  pale: "#F3F6FA",
  white: "#FFFFFF",
  line: "#D9E1EC",
};

function addShape(slide, name, position, fill, options = {}) {
  return slide.shapes.add({
    geometry: options.geometry ?? "roundRect",
    name,
    position,
    fill,
    line: {
      style: "solid",
      fill: options.lineColor ?? fill,
      width: options.lineWidth ?? 0,
    },
    ...(options.radius ? { borderRadius: options.radius } : {}),
  });
}

function addText(slide, name, position, runs, options = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    name,
    position,
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  const normalized = (Array.isArray(runs) ? runs : [{ text: runs }]).map((run) => ({
    run: run.text,
    textStyle: {
      bold: run.bold ?? options.bold ?? false,
      italic: run.italic ?? false,
      fontSize: `${run.fontSize ?? options.fontSize ?? 18}pt`,
      typeface: run.typeface ?? options.typeface ?? "Arial",
      color: run.color ?? options.color ?? C.ink,
    },
  }));
  box.text.set([[...normalized]]);
  box.text.style = {
    typeface: options.typeface ?? "Arial",
    color: options.color ?? C.ink,
    alignment: options.alignment ?? "left",
    verticalAlignment: options.verticalAlignment ?? "top",
    autoFit: "none",
    wrap: "square",
    insets: options.insets ?? { left: 0, right: 0, top: 0, bottom: 0 },
    lineSpacing: options.lineSpacing ?? 1.08,
  };
  return box;
}

function addHeader(slide, number, title, body) {
  addText(slide, `surface-${number}-kicker`, { left: 64, top: 44, width: 1152, height: 24 }, `SEMANTIC SURFACE  /  ${Number(number)}`, { fontSize: 14, bold: true, color: C.blue });
  addText(slide, `surface-${number}-title`, { left: 64, top: 84, width: 1152, height: 56 }, title, { fontSize: 36, bold: true, color: C.navy });
  addText(slide, `surface-${number}-body`, { left: 64, top: 146, width: 1152, height: 44 }, body, { fontSize: 18, color: C.muted });
}

function addStructureSlide(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "01", "Structure stays editable at every level", "Native text and shapes survive inside a two-level PowerPoint group—without becoming pixels.");
  addShape(slide, "surface-01-card-bg", { left: 256, top: 238, width: 768, height: 360 }, C.navy, { radius: "rounded-3xl" });
  addText(slide, "surface-01-metric-value", { left: 320, top: 302, width: 340, height: 96 }, "100%", { fontSize: 64, bold: true, color: C.white });
  addText(slide, "surface-01-metric-label", { left: 324, top: 404, width: 350, height: 34 }, "NATIVE + EDITABLE", { fontSize: 16, bold: true, color: C.cyan });
  addShape(slide, "surface-01-status-pill", { left: 726, top: 316, width: 220, height: 64 }, C.green, { radius: "rounded-2xl" });
  addText(slide, "surface-01-status-text", { left: 726, top: 332, width: 220, height: 30 }, "GROUP SAFE", { fontSize: 16, bold: true, color: C.white, alignment: "center", verticalAlignment: "middle" });
  slide.speakerNotes.textFrame.setText("Explain that the card is a real nested PowerPoint group. The value and label can be ungrouped, edited independently, and regrouped without flattening any text.");
  slide.speakerNotes.setVisible(true);
}

function addChartSlide(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "02", "Native charts carry the data—not a screenshot", "Horizontal comparison and vertical change remain native through PowerPoint save and reopen.");
  addText(slide, "surface-02-bar-label", { left: 64, top: 214, width: 544, height: 28 }, "HORIZONTAL  /  WORK ALLOCATION", { fontSize: 14, bold: true, color: C.navy });
  addText(slide, "surface-02-column-label", { left: 672, top: 214, width: 544, height: 28 }, "VERTICAL  /  APPROVAL VELOCITY", { fontSize: 14, bold: true, color: C.navy });
  slide.charts.add("bar", {
    position: { left: 64, top: 254, width: 544, height: 378 },
    categories: ["Plan", "Draft", "Review", "Ship"],
    series: [{ name: "Minutes", values: [42, 31, 19, 8], fill: C.blue }],
    barOptions: { direction: "bar", grouping: "clustered", gapWidth: 48 },
    hasLegend: false,
    chartFill: C.pale,
    chartLine: { style: "solid", fill: C.line, width: 1 },
    plotAreaFill: C.white,
    xAxis: { min: 0, max: 50, majorUnit: 10, textStyle: { fill: C.muted, fontSize: 16 }, majorGridlines: { style: "solid", fill: C.line, width: 1 } },
    yAxis: { textStyle: { fill: C.ink, fontSize: 16 }, line: { style: "solid", fill: C.line, width: 1 } },
    dataLabels: { showValue: true, position: "outEnd", textStyle: { fill: C.ink, fontSize: 16, bold: true } },
  });
  slide.charts.add("bar", {
    position: { left: 672, top: 254, width: 544, height: 378 },
    categories: ["Mon", "Tue", "Wed", "Thu"],
    series: [{ name: "Approved", values: [12, 18, 24, 33], fill: C.chartTeal }],
    barOptions: { direction: "column", grouping: "clustered", gapWidth: 52 },
    hasLegend: false,
    chartFill: C.pale,
    chartLine: { style: "solid", fill: C.line, width: 1 },
    plotAreaFill: C.white,
    xAxis: { textStyle: { fill: C.ink, fontSize: 16 }, line: { style: "solid", fill: C.line, width: 1 } },
    yAxis: { min: 0, max: 40, majorUnit: 10, textStyle: { fill: C.muted, fontSize: 16 }, majorGridlines: { style: "solid", fill: C.line, width: 1 } },
    dataLabels: { showValue: true, position: "outEnd", textStyle: { fill: C.ink, fontSize: 16, bold: true } },
  });
  slide.speakerNotes.textFrame.setText("Use the horizontal chart to compare stages and the vertical chart to show change over time. Both remain native Office chart parts with exact cached categories and values; data editing is outside this bounded proof.");
  slide.speakerNotes.setVisible(true);
}

function addTableSlide(presentation) {
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "03", "Tables remain cell-addressable", "Every value, border, fill, and emphasis choice stays attached to a real table cell.");
  const table = slide.tables.add({
    rows: 5,
    columns: 4,
    left: 64,
    top: 236,
    width: 808,
    height: 374,
    columnWidths: [244, 160, 192, 212],
    values: [
      ["Object", "Native", "Round-trip", "Owner"],
      ["Text", "Yes", "Exact", "Writer"],
      ["Chart", "Yes", "Exact", "Analyst"],
      ["Table", "Yes", "Exact", "Operator"],
      ["Diagram", "Yes", "Exact", "Designer"],
    ],
  });
  table.styleOptions = { headerRow: true, bandedRows: true, firstColumn: true };
  table.borders.assign({ style: "solid", fill: C.line, width: 1 });
  table.cells.block({ row: 0, column: 0, rowCount: 1, columnCount: 4 }).assign({
    fill: C.navy,
    // PowerPoint normalizes artifact-tool table type at 75% of the requested
    // size. Request 20pt so saved/reopened native cells remain 15pt and clear
    // C18's conventional 14pt readability floor.
    textStyle: { color: C.white, fontSize: 20, bold: true },
    margins: { left: 16, right: 16, top: 10, bottom: 10 },
  });
  table.cells.block({ row: 1, column: 0, rowCount: 4, columnCount: 4 }).assign({
    textStyle: { color: C.ink, fontSize: 20 },
    margins: { left: 16, right: 16, top: 10, bottom: 10 },
  });
  addShape(slide, "surface-03-insight-bg", { left: 912, top: 236, width: 304, height: 374 }, C.pale, { radius: "rounded-3xl", lineColor: C.line, lineWidth: 1 });
  addText(slide, "surface-03-insight-label", { left: 944, top: 276, width: 240, height: 28 }, "STRUCTURAL RESULT", { fontSize: 14, bold: true, color: C.blue });
  addText(slide, "surface-03-insight-value", { left: 944, top: 328, width: 240, height: 70 }, "20 / 20", { fontSize: 44, bold: true, color: C.navy });
  addText(slide, "surface-03-insight-body", { left: 944, top: 420, width: 240, height: 108 }, "cells structurally preserved after export and PowerPoint reopen", { fontSize: 18, color: C.muted, lineSpacing: 1.16 });
  slide.speakerNotes.textFrame.setText("Call out that each value is stored in a native table cell. The right-hand evidence card is separate native text, so the table can be resized without affecting the conclusion.");
  slide.speakerNotes.setVisible(true);
}

async function addRelationshipSlide(presentation, assetPath) {
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "04", "Relationships, media, and notes survive together", "Attached connectors route between native nodes while declared visual assets remain explicit and auditable.");
  const source = addShape(slide, "surface-04-source", { left: 64, top: 286, width: 216, height: 116 }, C.navy, { radius: "rounded-2xl" });
  addText(slide, "surface-04-source-text", { left: 84, top: 318, width: 176, height: 52 }, "SOURCE\nIDEA", { fontSize: 18, bold: true, color: C.white, alignment: "center" });
  const structure = addShape(slide, "surface-04-structure", { left: 352, top: 286, width: 216, height: 116 }, C.blue, { radius: "rounded-2xl" });
  addText(slide, "surface-04-structure-text", { left: 372, top: 318, width: 176, height: 52 }, "SEMANTIC\nSTRUCTURE", { fontSize: 18, bold: true, color: C.white, alignment: "center" });
  const delivery = addShape(slide, "surface-04-delivery", { left: 640, top: 286, width: 216, height: 116 }, C.green, { radius: "rounded-2xl" });
  addText(slide, "surface-04-delivery-text", { left: 660, top: 318, width: 176, height: 52 }, "EDITABLE\nDELIVERY", { fontSize: 18, bold: true, color: C.white, alignment: "center" });
  slide.shapes.connect(source, structure, { kind: "straight", fromSide: "right", toSide: "left", line: { style: "solid", fill: C.blue, width: 3 }, tail: { type: "arrow", width: "med", length: "med" } });
  slide.shapes.connect(structure, delivery, { kind: "straight", fromSide: "right", toSide: "left", line: { style: "solid", fill: C.green, width: 3 }, tail: { type: "arrow", width: "med", length: "med" } });
  addShape(slide, "surface-04-image-frame", { left: 928, top: 236, width: 288, height: 324 }, C.pale, { radius: "rounded-3xl", lineColor: C.line, lineWidth: 1 });
  const asset = await fs.readFile(assetPath);
  slide.images.add({
    blob: new Uint8Array(asset),
    contentType: "image/png",
    alt: "Declared design-reference thumbnail used as a legitimate raster visual asset",
    fit: "contain",
    position: { left: 952, top: 260, width: 240, height: 220 },
  });
  addText(slide, "surface-04-image-caption", { left: 952, top: 500, width: 240, height: 34 }, "DECLARED VISUAL ASSET", { fontSize: 13, bold: true, color: C.navy, alignment: "center" });
  addText(slide, "surface-04-footer", { left: 64, top: 610, width: 792, height: 34 }, "Connector endpoints, media hash, alt text, and notes are verified recursively.", { fontSize: 16, color: C.muted });
  slide.speakerNotes.textFrame.setText("Trace the attached connectors from source to structure to delivery. The thumbnail is an explicitly declared visual reference asset; all explanatory copy and diagram labels remain editable native text.");
  slide.speakerNotes.setVisible(true);
}

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

export async function renderSemanticSurface({ out, previewDir, assetPath }) {
  const presentation = Presentation.create({ slideSize: CANVAS });
  addStructureSlide(presentation);
  addChartSlide(presentation);
  addTableSlide(presentation);
  await addRelationshipSlide(presentation, assetPath);
  if (previewDir) {
    await fs.mkdir(previewDir, { recursive: true });
    for (const [index, slide] of presentation.slides.items.entries()) {
      await writeBlob(path.join(previewDir, `slide-${String(index + 1).padStart(2, "0")}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
    }
    await writeBlob(path.join(previewDir, "montage.webp"), await presentation.export({ format: "webp", montage: true, scale: 1 }));
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = path.resolve(process.argv[2] ?? "outputs/semantic-surface/semantic-surface-base.pptx");
  const previewDir = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const assetPath = path.resolve(process.argv[4] ?? "fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png");
  renderSemanticSurface({ out, previewDir, assetPath }).then(() => {
    process.stdout.write(`Rendered semantic surface to ${out}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
