import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inspectPlanFonts } from "../lib/font-audit.mjs";
import { toArtifactPosition, toFontAuditPlan, validateObservedDesign } from "../lib/observed-design.mjs";
import { loadArtifactTool } from "../lib/artifact-runtime.mjs";

function borderRadius(radius) {
  if (!radius) return undefined;
  if (radius <= 8) return "rounded-lg";
  if (radius <= 14) return "rounded-xl";
  return "rounded-2xl";
}

function artifactParagraphs(object) {
  const paragraphs = [[]];
  for (const run of object.text.runs) {
    const parts = run.text.split("\n");
    for (const [index, part] of parts.entries()) {
      if (part) paragraphs.at(-1).push({
        run: part,
        textStyle: {
          bold: Boolean(run.bold ?? object.text.bold),
          italic: Boolean(run.italic ?? object.text.italic),
          fontSize: `${run.fontSizePtGuess ?? object.text.fontSizePtGuess}pt`,
          typeface: run.fontFamilyGuess ?? object.text.fontFamilyGuess,
          color: run.color ?? object.text.color,
        },
      });
      if (index < parts.length - 1) paragraphs.push([]);
    }
  }
  return paragraphs;
}

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

export async function renderObservedDesign({ input, out, preview }) {
  const { Presentation, PresentationFile } = await loadArtifactTool();
  const design = validateObservedDesign(JSON.parse(await fs.readFile(input, "utf8")));
  const fontReport = inspectPlanFonts(toFontAuditPlan(design));
  if (!fontReport.valid) throw new Error(`Font audit blocked reconstruction: ${fontReport.diagnostics.map((item) => item.message).join(" ")}`);
  const presentation = Presentation.create({ slideSize: design.canvas });
  const slide = presentation.slides.add();
  slide.background.fill = design.canvas.background;
  for (const object of [...design.objects].sort((a, b) => a.zIndex - b.zIndex)) {
    const position = toArtifactPosition(object.bbox, design.canvas, object.rotationDeg ?? 0);
    if (object.type === "shape") {
      slide.shapes.add({
        geometry: object.shape.geometry,
        name: object.id,
        position,
        fill: object.shape.fill,
        line: { style: "solid", fill: object.shape.line?.color ?? "none", width: object.shape.line?.width ?? 0 },
        borderRadius: object.shape.geometry === "rect" ? borderRadius(object.shape.radiusPx) : undefined,
      });
      continue;
    }
    const shape = slide.shapes.add({
      geometry: "textbox",
      name: object.id,
      position,
      fill: "none",
      line: { style: "solid", fill: "none", width: 0 },
    });
    shape.text.style = {
      color: object.text.color,
      alignment: object.text.alignment,
      verticalAlignment: object.text.verticalAlignment,
      autoFit: "none",
      wrap: "square",
      insets: object.text.insets ?? { left: 0, top: 0, right: 0, bottom: 0 },
      typeface: object.text.fontFamilyGuess,
      lineSpacing: object.text.lineHeight ?? 1,
    };
    shape.text.set(artifactParagraphs(object));
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  if (preview) await writeBlob(preview, await presentation.export({ slide, format: "png", scale: 1 }));
  await (await PresentationFile.exportPptx(presentation)).save(out);
  return { design, fontReport, out, preview };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = process.argv[2];
  const out = process.argv[3] ?? "outputs/ingestion/reconstruction.pptx";
  const preview = process.argv[4] ?? "outputs/ingestion/artifact-preview.png";
  if (!input) throw new Error("Usage: render_observed_design.mjs <observed-design.json> [out.pptx] [preview.png]");
  renderObservedDesign({ input, out, preview }).then(({ design }) => {
    process.stdout.write(`Reconstructed ${design.objects.length} native objects to ${out}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
