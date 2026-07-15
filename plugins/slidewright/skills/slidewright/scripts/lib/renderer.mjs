import fs from "node:fs/promises";
import path from "node:path";
import { lintPlan } from "./linter.mjs";
import { inspectPlanFonts } from "./font-audit.mjs";
import { loadArtifactTool } from "./artifact-runtime.mjs";
import { lintRenderedLayouts } from "./rendered-linter.mjs";

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

function toArtifactTextRuns(shape) {
  return shape.text.runs.map((run) => ({
    run: run.text,
    textStyle: {
      bold: Boolean(run.bold),
      italic: Boolean(run.italic),
      fontSize: `${shape.style.fontSizePt}pt`,
      typeface: shape.style.typeface,
      color: run.color ?? shape.style.color,
    },
  }));
}

export async function renderPlan(plan, { out, previewDir }) {
  const report = lintPlan(plan);
  if (!report.valid) {
    throw new Error(`Refusing to render an invalid plan with ${report.counts.error} error(s).`);
  }
  const fontReport = inspectPlanFonts(plan);
  if (!fontReport.valid) {
    const details = fontReport.diagnostics.map((item) => `${item.message} ${item.remediation}`).join(" ");
    throw new Error(`Refusing to render a plan with unresolved font requirements. ${details}`);
  }

  const artifact = await loadArtifactTool();
  const { Presentation, PresentationFile } = artifact;
  const presentation = Presentation.create({ slideSize: plan.canvas });

  for (const slidePlan of plan.slides) {
    const slide = presentation.slides.add();
    slide.background.fill = slidePlan.background;
    for (const shape of slidePlan.shapes) {
      if (shape.type === "shape") {
        slide.shapes.add({
          geometry: shape.geometry,
          name: shape.id,
          position: shape.position,
          fill: shape.fill,
          line: { style: "solid", fill: shape.line.color, width: shape.line.width },
          borderRadius: "rounded-2xl",
        });
        continue;
      }
      const textbox = slide.shapes.add({
        geometry: "textbox",
        name: shape.id,
        position: shape.position,
        fill: "none",
        line: { style: "solid", fill: "none", width: 0 },
      });
      textbox.text.set([[...toArtifactTextRuns(shape)]]);
      textbox.text.style = {
        color: shape.style.color,
        alignment: shape.style.alignment,
        verticalAlignment: shape.style.verticalAlignment,
        autoFit: "none",
        wrap: "square",
        insets: shape.style.insets,
        typeface: shape.style.typeface,
        lineSpacing: shape.style.lineHeight,
      };
    }
  }

  await fs.mkdir(path.dirname(out), { recursive: true });
  if (previewDir) await fs.mkdir(previewDir, { recursive: true });

  const renderedLayouts = [];
  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = `slide-${String(index + 1).padStart(2, "0")}`;
    if (previewDir) await writeBlob(path.join(previewDir, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
    const layout = await slide.export({ format: "layout" });
    const layoutText = await layout.text();
    if (previewDir) await fs.writeFile(path.join(previewDir, `${stem}.layout.json`), layoutText, "utf8");
    renderedLayouts.push(JSON.parse(layoutText));
  }
  if (previewDir) {
    await writeBlob(
      path.join(previewDir, "deck-montage.webp"),
      await presentation.export({ format: "webp", montage: true, scale: 1 }),
    );
  }

  const renderedReport = lintRenderedLayouts(plan, renderedLayouts);
  if (previewDir) await fs.writeFile(path.join(previewDir, "rendered-lint-report.json"), `${JSON.stringify(renderedReport, null, 2)}\n`, "utf8");
  if (!renderedReport.valid) {
    await fs.rm(out, { force: true });
    throw new Error(`Refusing to save a rendered layout with ${renderedReport.counts.error} error(s).`);
  }

  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(out);
  return { out, slideCount: plan.slides.length, previewDir: previewDir ?? null, renderedLint: renderedReport };
}
