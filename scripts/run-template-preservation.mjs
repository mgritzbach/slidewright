#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const fixture = path.join(root, "fixtures", "template", "mit-v1");
const source = path.join(fixture, "slidewright-mit-template.pptx");
const plan = path.join(fixture, "edit-plan.json");
const output = path.join(root, "outputs", "template");
const templateScripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "template");
const sourceCopy = path.join(output, "source.pptx");
const edited = path.join(output, "slidewright-mit-template-edited.pptx");
const roundtrip = path.join(output, "powerpoint-roundtrip.pptx");
const sourceRenders = path.join(output, "source");
const editedRenders = path.join(output, "slidewright-mit-template-edited");
const roundtripRenders = path.join(output, "powerpoint-roundtrip");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
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
for (const candidate of [sourceRenders, editedRenders, roundtripRenders]) await fs.rm(candidate, { recursive: true, force: true });
for (const candidate of [sourceCopy, edited, roundtrip]) await fs.rm(candidate, { force: true });
await fs.copyFile(source, sourceCopy);
run(python, [path.join(templateScripts, "edit_template.py"), source, plan, edited, "--json", path.join(output, "edit-report.json")]);
run(python, [path.join(templateScripts, "audit_template_preservation.py"), source, edited, plan, "--json", path.join(output, "audit.json"), "--source-manifest", path.join(output, "source-package-manifest.json"), "--edited-manifest", path.join(output, "edited-package-manifest.json")]);
run(python, [path.join(templateScripts, "template_negative_controls.py"), source, edited, plan, "--json", path.join(output, "negative-controls.json")]);
const renderTool = await findTool("render_slides.py");
const slidesTest = await findTool("slides_test.py");
const montageTool = await findTool("create_montage.py");
for (const deck of [sourceCopy, edited]) {
  run(python, [renderTool, deck]);
  run(python, [slidesTest, deck]);
}
run(python, [path.join(templateScripts, "compare_template_renders.py"), source, plan, sourceRenders, editedRenders, "--json", path.join(output, "visual-audit.json"), "--out-dir", path.join(output, "visual-diff")]);
const powerPoint = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
try { await fs.access(powerPoint); } catch { throw new Error("Microsoft PowerPoint is required for the G10 golden-template round trip."); }
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(templateScripts, "powerpoint_template_roundtrip.ps1"), "-InputPptx", edited, "-OutputPptx", roundtrip, "-ReportJson", path.join(output, "powerpoint-roundtrip.json")]);
run(python, [renderTool, roundtrip]);
run(python, [slidesTest, roundtrip]);
run(python, [path.join(templateScripts, "compare_exact_renders.py"), editedRenders, roundtripRenders, "--slides", "2", "--json", path.join(output, "roundtrip-visual-audit.json"), "--out-dir", path.join(output, "roundtrip-visual-diff")]);
const montage = path.join(output, "montage.png");
run(python, [montageTool, "--input_dir", editedRenders, "--output_file", montage]);
const audit = JSON.parse(await fs.readFile(path.join(output, "audit.json"), "utf8"));
await fs.writeFile(path.join(output, "deviation-log.json"), `${JSON.stringify(audit.deviationLog, null, 2)}\n`, "utf8");
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "verify", edited, "--out", path.join(output, "delivery-manifest.json"), "--preview-dir", editedRenders, "--montage", montage, "--handoff", path.join(output, "DELIVERY.md"), "--require-bundle"]);
process.stdout.write(`Template-preservation benchmark passed: ${edited}\n`);
