#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildPowerPointAdapterScorecard, buildPowerPointAdapterStatus } from "../plugins/slidewright/skills/slidewright/scripts/lib/powerpoint-adapter.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "powerpoint-adapter");
const input = path.join(root, "outputs", "fidelity", "slidewright-fidelity-benchmark.pptx");
const edited = path.join(output, "edited.pptx");
const adapterReportPath = path.join(output, "adapter-report.json");
const powerPointPath = process.env.SLIDEWRIGHT_POWERPOINT_PATH || "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* PATH fallback */ }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${result.status}`);
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

async function findTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Could not find ${name} in the Codex presentation runtime.`);
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
if (!await exists(input)) run("npm", ["run", "fidelity"]);
if (!await exists(input)) throw new Error("Generated fidelity deck is missing after the generation step.");

const unavailableOutput = path.join(output, "unavailable-control-generation");
const unavailablePlan = path.join(unavailableOutput, "plan.json");
const unavailableDeck = path.join(unavailableOutput, "generated-without-powerpoint.pptx");
const forcedMissingPowerPointPath = path.join(output, "definitely-missing", "POWERPNT.EXE");
const unavailableEnv = { ...process.env, SLIDEWRIGHT_POWERPOINT_PATH: forcedMissingPowerPointPath };
await fs.mkdir(unavailableOutput, { recursive: true });
run(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs")], { env: unavailableEnv });
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "compile", path.join(root, "examples", "demo", "deck-spec.json"), "--out", unavailablePlan], { env: unavailableEnv });
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "lint", unavailablePlan, "--out", path.join(unavailableOutput, "lint-report.json")], { env: unavailableEnv });
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "render", unavailablePlan, "--out", unavailableDeck, "--preview-dir", path.join(unavailableOutput, "previews")], { env: unavailableEnv });
run(python, [path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py"), unavailableDeck, "--json", path.join(unavailableOutput, "ooxml-audit.json")], { env: unavailableEnv });
run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "verify", unavailableDeck, "--out", path.join(unavailableOutput, "delivery-manifest.json")], { env: unavailableEnv });
const generationAvailableWithoutPowerPoint = await exists(unavailableDeck) && !await exists(forcedMissingPowerPointPath);
const unavailableGenerationProof = {
  valid: generationAvailableWithoutPowerPoint,
  forcedPowerPointPath: forcedMissingPowerPointPath,
  forcedPowerPointAvailable: await exists(forcedMissingPowerPointPath),
  compile: await exists(unavailablePlan),
  render: await exists(unavailableDeck),
  audit: await exists(path.join(unavailableOutput, "ooxml-audit.json")),
  deliveryVerification: await exists(path.join(unavailableOutput, "delivery-manifest.json")),
};
const unavailableControl = buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: unavailableGenerationProof.forcedPowerPointAvailable, generationAvailable: unavailableGenerationProof.valid });
if (!unavailableControl.valid || unavailableControl.adapterEnabled || !unavailableControl.generationEnabled) throw new Error("Unavailable-PowerPoint control disabled generation.");
await fs.writeFile(path.join(output, "unavailable-control.json"), `${JSON.stringify(unavailableControl, null, 2)}\n`, "utf8");

const actualStatus = buildPowerPointAdapterStatus({ platform: process.platform, powerPointAvailable: await exists(powerPointPath), generationAvailable: true });
let adapterReport = null;
if (actualStatus.adapterEnabled) {
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "powerpoint-edit-adapter.ps1"), "-InputPptx", input, "-OutputPptx", edited, "-ReportJson", adapterReportPath]);
  adapterReport = JSON.parse((await fs.readFile(adapterReportPath, "utf8")).replace(/^\uFEFF/u, ""));
  if (!adapterReport.valid || !adapterReport.selectionVerified || adapterReport.selectedObject !== adapterReport.editedObject) throw new Error("PowerPoint selection/edit proof failed.");
  if (adapterReport.beforeText === adapterReport.afterText || adapterReport.beforeBold === adapterReport.afterBold || adapterReport.afterBold !== -1) throw new Error("PowerPoint text/bold edit was not retained.");
  if (adapterReport.childCountBefore !== adapterReport.childCountAfter || adapterReport.groupNameBefore !== adapterReport.groupNameAfter || !adapterReport.exactMemberSetPreserved || JSON.stringify(adapterReport.memberNamesBefore) !== JSON.stringify(adapterReport.memberNamesAfter)) throw new Error("PowerPoint ungroup/regroup identity proof failed.");
  if (adapterReport.inputSha256 === adapterReport.outputSha256) throw new Error("PowerPoint adapter output hash did not change.");
  run(process.execPath, [path.join(root, "packages", "cli", "src", "cli.mjs"), "verify", edited, "--out", path.join(output, "edited-delivery-manifest.json")]);
  const renderTool = await findTool("render_slides.py");
  const slidesTest = await findTool("slides_test.py");
  run(python, [renderTool, edited]);
  run(python, [slidesTest, edited]);
}

const scorecard = buildPowerPointAdapterScorecard({ actualStatus, unavailableControl, unavailableGenerationProof, adapterReport });
await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
process.stdout.write(actualStatus.adapterEnabled ? "PowerPoint adapter benchmark passed.\n" : `${actualStatus.reason}\n`);
