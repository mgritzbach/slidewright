#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mutateDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-mutation.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "mutation");
const cli = path.join(root, "packages", "cli", "src", "cli.mjs");
const audit = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* use PATH */ }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

async function findTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new Error(`Could not find ${name} in the Codex presentation runtime.`);
}

await fs.mkdir(output, { recursive: true });
run(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs")]);
const source = JSON.parse(await fs.readFile(path.join(root, "examples", "demo", "deck-spec.json"), "utf8"));
const slidesTest = await findTool("slides_test.py");
const montageTool = await findTool("create_montage.py");
const results = [];

for (const factor of [0.75, 1.25]) {
  const label = factor < 1 ? "minus-25" : "plus-25";
  const specPath = path.join(output, `${label}-spec.json`);
  const planPath = path.join(output, `${label}-plan.json`);
  const lintPath = path.join(output, `${label}-lint.json`);
  const deckPath = path.join(output, `${label}.pptx`);
  const previewDir = path.join(output, label);
  const montage = path.join(output, `${label}-montage.png`);
  const manifest = path.join(output, `${label}-delivery.json`);
  const handoff = path.join(output, `${label}-DELIVERY.md`);
  await fs.writeFile(specPath, `${JSON.stringify(mutateDeckCopy(source, factor), null, 2)}\n`, "utf8");
  run(process.execPath, [cli, "compile", specPath, "--out", planPath]);
  run(process.execPath, [cli, "lint", planPath, "--out", lintPath]);
  run(process.execPath, [cli, "render", planPath, "--out", deckPath, "--preview-dir", previewDir]);
  run(python, [slidesTest, deckPath]);
  run(python, [audit, deckPath, "--json", path.join(output, `${label}-ooxml.json`)]);
  run(python, [montageTool, "--input_dir", previewDir, "--output_file", montage]);
  run(process.execPath, [cli, "verify", deckPath, "--out", manifest, "--preview-dir", previewDir, "--montage", montage, "--handoff", handoff, "--require-bundle"]);
  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  const sizes = plan.slides.flatMap((slide) => slide.shapes).filter((shape) => shape.type === "text").map((shape) => shape.style.fontSizePt);
  results.push({ label, factor, slides: plan.slides.length, minimumFontSizePt: Math.min(...sizes), allWholePoint: sizes.every(Number.isInteger), valid: true });
}

await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify({ valid: results.every((result) => result.valid), results }, null, 2)}\n`, "utf8");
process.stdout.write(`Copy mutation benchmark passed: ${results.map((result) => result.label).join(", ")}\n`);
