import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";
import { FIDELITY_SUITE } from "./fidelity_suite.mjs";

function borderRadius(radius) {
  if (!radius) return undefined;
  if (radius <= 8) return "rounded-lg";
  if (radius <= 14) return "rounded-xl";
  return "rounded-2xl";
}

function artifactRuns(element) {
  return element.text.runs.map((run) => ({
    run: run.text,
    textStyle: {
      bold: Boolean(run.bold),
      italic: Boolean(run.italic),
      fontSize: `${run.fontSizePt ?? element.style.fontSizePt}pt`,
      typeface: run.typeface ?? element.style.typeface,
      color: run.color ?? element.style.color,
    },
  }));
}

async function writeBlob(filePath, blob) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

export async function renderFidelitySuite({ out, previewDir }) {
  const presentation = Presentation.create({ slideSize: FIDELITY_SUITE.canvas });
  for (const benchmark of FIDELITY_SUITE.slides) {
    const slide = presentation.slides.add();
    slide.background.fill = benchmark.background;
    for (const element of benchmark.elements) {
      if (element.type === "shape") {
        slide.shapes.add({
          geometry: element.geometry,
          name: element.id,
          position: element.position,
          fill: element.fill,
          line: { style: "solid", fill: element.line.color, width: element.line.width },
          borderRadius: borderRadius(element.radius),
        });
        continue;
      }
      const shape = slide.shapes.add({
        geometry: "textbox",
        name: element.id,
        position: element.position,
        fill: "none",
        line: { style: "solid", fill: "none", width: 0 },
      });
      shape.text.set([[...artifactRuns(element)]]);
      shape.text.style = {
        color: element.style.color,
        alignment: element.style.alignment,
        verticalAlignment: element.style.verticalAlignment,
        autoFit: "none",
        wrap: "square",
        insets: element.style.insets,
        typeface: element.style.typeface,
        lineSpacing: element.style.lineHeight,
      };
    }
  }

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  for (const [index, slide] of presentation.slides.items.entries()) {
    const stem = FIDELITY_SUITE.slides[index].id;
    await writeBlob(path.join(previewDir, `${stem}.png`), await presentation.export({ slide, format: "png", scale: 1 }));
    const layout = await slide.export({ format: "layout" });
    await fs.writeFile(path.join(previewDir, `${stem}.layout.json`), await layout.text(), "utf8");
  }
  await writeBlob(path.join(previewDir, "montage.webp"), await presentation.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(out);
  await fs.writeFile(path.join(path.dirname(out), "fidelity-suite.json"), `${JSON.stringify(FIDELITY_SUITE, null, 2)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2] ?? "outputs/fidelity/slidewright-fidelity-benchmark.pptx";
  const previewDir = process.argv[3] ?? "outputs/fidelity/artifact-previews";
  renderFidelitySuite({ out, previewDir }).then(() => {
    process.stdout.write(`Rendered ${FIDELITY_SUITE.slides.length} fidelity slides to ${out}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
