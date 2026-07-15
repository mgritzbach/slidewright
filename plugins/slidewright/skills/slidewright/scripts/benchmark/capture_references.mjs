import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { FIDELITY_SUITE } from "./fidelity_suite.mjs";

function cssColor(value) {
  return value === "none" ? "transparent" : value;
}

function esc(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function elementHtml(element) {
  const p = element.position;
  const common = `left:${p.left}px;top:${p.top}px;width:${p.width}px;height:${p.height}px;transform:rotate(${p.rotation ?? 0}deg);`;
  if (element.type === "shape") {
    const radius = element.geometry === "ellipse" ? "50%" : `${element.radius ?? 0}px`;
    return `<div data-id="${element.id}" style="${common}background:${cssColor(element.fill)};border:${element.line.width}px solid ${cssColor(element.line.color)};border-radius:${radius};"></div>`;
  }
  const style = element.style;
  const alignItems = style.verticalAlignment === "middle" ? "center" : style.verticalAlignment === "bottom" ? "flex-end" : "flex-start";
  const spans = element.text.runs.map((run) => `<span style="font-family:${run.typeface};font-size:${run.fontSizePt}pt;font-weight:${run.bold ? 700 : 400};font-style:${run.italic ? "italic" : "normal"};color:${run.color};">${esc(run.text)}</span>`).join("");
  return `<div data-id="${element.id}" style="${common}display:flex;align-items:${alignItems};box-sizing:border-box;padding:${style.insets.top}px ${style.insets.right}px ${style.insets.bottom}px ${style.insets.left}px;font-family:${style.typeface};font-size:${style.fontSizePt}pt;font-weight:${style.bold ? 700 : 400};font-style:${style.italic ? "italic" : "normal"};color:${style.color};line-height:${style.lineHeight};text-align:${style.alignment};white-space:pre-wrap;overflow:hidden;"><div style="width:100%;">${spans}</div></div>`;
}

function htmlFor(slide) {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>*{box-sizing:border-box}html,body{margin:0;width:1280px;height:720px;overflow:hidden}body{position:relative;background:${slide.background};font-synthesis:none;text-rendering:geometricPrecision}body>div{position:absolute}</style></head><body>${slide.elements.map(elementHtml).join("")}</body></html>`;
}

function cli(args, cwd) {
  const windowsNpx = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
  const executable = process.platform === "win32" ? process.execPath : "npx";
  const prefix = process.platform === "win32" ? [windowsNpx] : [];
  const result = spawnSync(executable, [...prefix, "--yes", "--package", "@playwright/cli", "playwright-cli", "-s=slidewright-fidelity", ...args], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`playwright-cli ${args.join(" ")} failed with ${result.status}`);
}

export async function captureReferences(outputDir) {
  outputDir = path.resolve(outputDir);
  await fs.mkdir(outputDir, { recursive: true });
  for (const slide of FIDELITY_SUITE.slides) {
    const htmlPath = path.resolve(outputDir, `${slide.id}.html`);
    await fs.writeFile(htmlPath, htmlFor(slide), "utf8");
  }
  const port = 41729;
  const server = spawn("python", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", outputDir], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 700));
  cli(["open", "about:blank"], outputDir);
  try {
    cli(["resize", String(FIDELITY_SUITE.canvas.width), String(FIDELITY_SUITE.canvas.height)], outputDir);
    for (const slide of FIDELITY_SUITE.slides) {
      cli(["goto", `http://127.0.0.1:${port}/${slide.id}.html`], outputDir);
      cli(["screenshot", `--filename=${slide.id}.png`], outputDir);
    }
  } finally {
    cli(["close"], outputDir);
    server.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outputDir = process.argv[2] ?? "outputs/fidelity/references";
  captureReferences(outputDir).then(() => {
    process.stdout.write(`Captured ${FIDELITY_SUITE.slides.length} owned reference images in ${outputDir}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
