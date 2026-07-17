#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";
import { FIDELITY_SUITE } from "../benchmark/fidelity_suite.mjs";

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

async function writeDeck(fixture, destination) {
  const presentation = Presentation.create({ slideSize: FIDELITY_SUITE.canvas });
  const slide = presentation.slides.add();
  slide.background.fill = fixture.background;
  for (const element of fixture.elements) {
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
  const pptx = await PresentationFile.exportPptx(presentation);
  await pptx.save(destination);
}

export async function generateFidelityFixtures(outputDirectory) {
  await fs.mkdir(outputDirectory, { recursive: true });
  const fixtures = [];
  for (const fixture of FIDELITY_SUITE.slides) {
    const destination = path.join(outputDirectory, `${fixture.id}.pptx`);
    await writeDeck(fixture, destination);
    fixtures.push({ id: fixture.id, path: destination, family: fixture.family, orientation: fixture.orientation });
  }
  return fixtures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const output = path.resolve(process.argv[2] ?? "outputs/repair-free/sources/design");
  generateFidelityFixtures(output).then((fixtures) => {
    process.stdout.write(`Generated ${fixtures.length} standalone fidelity fixtures in ${output}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
