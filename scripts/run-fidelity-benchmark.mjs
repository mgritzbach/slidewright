#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const benchmark = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark");
const output = path.join(root, "outputs", "fidelity");
const suite = path.join(output, "fidelity-suite.json");
const ungrouped = path.join(output, "slidewright-fidelity-ungrouped.pptx");
const finalDeck = path.join(output, "slidewright-fidelity-benchmark.pptx");
const rendered = path.join(output, "slidewright-fidelity-benchmark");
const montage = path.join(output, "slidewright-fidelity-montage.png");
const handoff = path.join(output, "DELIVERY.md");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try {
  await fs.access(bundledPython);
  python = bundledPython;
} catch { /* use PATH */ }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

async function findTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* continue */ }
  }
  throw new Error(`Could not find ${name} in the Codex presentation runtime.`);
}

await fs.mkdir(output, { recursive: true });
await fs.rm(rendered, { recursive: true, force: true });
run(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs")]);
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "preflight", "--out", path.join(output, "preflight.json")]);
run(process.execPath, [path.join(benchmark, "capture_references.mjs"), path.join(output, "references")]);
run(process.execPath, [path.join(benchmark, "render_fidelity.mjs"), ungrouped, path.join(output, "artifact-previews")]);
run(python, [path.join(benchmark, "group_pptx.py"), ungrouped, finalDeck, "--suite", suite]);
const renderTool = await findTool("render_slides.py");
const slidesTest = await findTool("slides_test.py");
const montageTool = await findTool("create_montage.py");
run(python, [renderTool, finalDeck]);
run(python, [slidesTest, finalDeck]);
run(python, [montageTool, "--input_dir", rendered, "--output_file", montage]);
run(python, [path.join(benchmark, "audit_fidelity.py"), finalDeck, suite, "--json", path.join(output, "fidelity-audit.json")]);
run(python, [path.join(benchmark, "compare_images.py"), path.join(output, "references"), rendered, suite, "--out", path.join(output, "comparison")]);
const powerPoint = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
const roundTripDeck = path.join(output, "powerpoint-group-roundtrip.pptx");
const roundTripReport = path.join(output, "powerpoint-group-roundtrip.json");
await fs.rm(roundTripDeck, { force: true });
await fs.rm(roundTripReport, { force: true });
let hasPowerPoint = true;
try {
  await fs.access(powerPoint);
} catch {
  hasPowerPoint = false;
}
if (hasPowerPoint) {
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(benchmark, "powerpoint_group_roundtrip.ps1"), "-InputPptx", finalDeck, "-OutputPptx", roundTripDeck, "-ReportJson", roundTripReport]);
} else {
  process.stdout.write("PowerPoint not installed; skipped application-level group round trip.\n");
}
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "verify", finalDeck, "--out", path.join(output, "delivery-manifest.json"), "--preview-dir", rendered, "--montage", montage, "--handoff", handoff, "--require-bundle"]);
process.stdout.write(`Fidelity benchmark complete: ${finalDeck}\n`);
