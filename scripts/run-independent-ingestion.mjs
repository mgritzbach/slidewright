#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const fixture = path.join(root, "fixtures", "independent");
const design = path.join(fixture, "observed-design.json");
const sourceHash = "7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8";
const source = path.join(fixture, `${sourceHash}.png`);
const output = path.join(root, "outputs", "ingestion");
const benchmark = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark");
const pptx = path.join(output, "reconstruction.pptx");
const renderedDir = path.join(output, "reconstruction");
const render = path.join(output, "render.png");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* use PATH */ }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

function runExpectedFailure(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status === 0) throw new Error(`${command} ${args.join(" ")} unexpectedly passed.`);
  if (result.status !== 1) throw new Error(`${command} ${args.join(" ")} failed with unexpected status ${result.status}.`);
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
await fs.rm(renderedDir, { recursive: true, force: true });
await fs.rm(pptx, { force: true });
await fs.copyFile(path.join(fixture, "parser-access-log.json"), path.join(output, "parser-access-log.json"));
run(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs")]);
run(process.execPath, [path.join(benchmark, "render_observed_design.mjs"), design, pptx, path.join(output, "artifact-preview.png")]);
run(python, [path.join(benchmark, "unlock_pptx.py"), pptx]);
const renderTool = await findTool("render_slides.py");
const slidesTest = await findTool("slides_test.py");
const montageTool = await findTool("create_montage.py");
run(python, [renderTool, pptx]);
run(python, [slidesTest, pptx]);
await fs.copyFile(path.join(renderedDir, "slide-1.png"), render);
run(python, [path.join(benchmark, "audit_observed_design.py"), pptx, design, source, "--json", path.join(output, "ooxml-audit.json")]);
run(python, [path.join(benchmark, "compare_ingestion.py"), source, render, "--json", path.join(output, "ingestion-score.json"), "--diff", path.join(output, "diff.png"), "--overlay", path.join(output, "overlay.png")]);
const erasedControl = path.join(output, "erased-text-control.png");
run(python, [path.join(benchmark, "create_erased_text_control.py"), source, design, erasedControl]);
runExpectedFailure(python, [path.join(benchmark, "compare_ingestion.py"), source, erasedControl, "--json", path.join(output, "erased-text-control-score.json"), "--diff", path.join(output, "erased-text-control-diff.png"), "--overlay", path.join(output, "erased-text-control-overlay.png")]);
run(python, [montageTool, "--input_dir", renderedDir, "--output_file", path.join(output, "montage.png")]);
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "verify", pptx, "--out", path.join(output, "delivery-manifest.json"), "--preview-dir", renderedDir, "--montage", path.join(output, "montage.png"), "--handoff", path.join(output, "DELIVERY.md"), "--require-bundle"]);
run(process.execPath, [path.join(benchmark, "verify_ingestion_provenance.mjs"), root, fixture, design, path.join(output, "parser-access-log.json"), pptx, render, path.join(output, "input-provenance.json")]);
process.stdout.write(`Independent image ingestion passed: ${pptx}\n`);
