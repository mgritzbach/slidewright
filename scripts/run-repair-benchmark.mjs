#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { mutateDeckCopy } from "../plugins/slidewright/skills/slidewright/scripts/lib/copy-mutation.mjs";

const root = process.cwd();
const output = path.resolve(root, "outputs", "repair");
const expectedParent = path.resolve(root, "outputs");
if (path.dirname(output) !== expectedParent) throw new Error(`Unsafe repair output path: ${output}`);
const cli = path.join(root, "packages", "cli", "src", "cli.mjs");

async function run(args, expectedStatus = 0) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== expectedStatus) throw new Error(`slidewright ${args.join(" ")} returned ${result.status}; expected ${expectedStatus}`);
  if (expectedStatus === 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  } else {
    process.stdout.write(`Expected rejection (${expectedStatus}): slidewright ${args[0]} ${args[1]}\n`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const source = JSON.parse(await fs.readFile(path.join(root, "examples", "demo", "deck-spec.json"), "utf8"));

const missingFont = structuredClone(source);
missingFont.title += " missing-font negative control";
missingFont.theme.fontFamily = "Definitely Missing Slidewright Sans";
missingFont.theme.fallbackFontFamily = "Arial";
const missingSpec = path.join(output, "missing-font-spec.json");
const missingPlan = path.join(output, "missing-font-plan.json");
const missingReport = path.join(output, "missing-font-report.json");
await fs.writeFile(missingSpec, `${JSON.stringify(missingFont, null, 2)}\n`, "utf8");
await run(["compile", missingSpec, "--out", missingPlan]);
await run(["fonts", missingPlan, "--out", missingReport], 2);
const missingRender = await run(["render", missingPlan, "--out", path.join(output, "missing-font.pptx")], 1);

const dense = mutateDeckCopy(source, 4);
const denseSpec = path.join(output, "dense-content-spec.json");
const densePlan = path.join(output, "dense-content-plan.json");
const denseReport = path.join(output, "dense-content-lint.json");
await fs.writeFile(denseSpec, `${JSON.stringify(dense, null, 2)}\n`, "utf8");
await run(["compile", denseSpec, "--out", densePlan]);
await run(["lint", densePlan, "--out", denseReport], 2);
const denseRender = await run(["render", densePlan, "--out", path.join(output, "dense-content.pptx")], 1);

const fontEvidence = JSON.parse(await fs.readFile(missingReport, "utf8"));
const denseEvidence = JSON.parse(await fs.readFile(denseReport, "utf8"));
const densePlanData = JSON.parse(await fs.readFile(densePlan, "utf8"));
const textShapes = densePlanData.slides.flatMap((slide) => slide.shapes).filter((shape) => shape.type === "text");
const noSubminimumType = textShapes.every((shape) => shape.style.fontSizePt >= shape.fit.minSizePt);
const noInvalidPptx = await Promise.all(["missing-font.pptx", "dense-content.pptx"].map(async (name) => {
  try { await fs.access(path.join(output, name)); return false; } catch { return true; }
})).then((values) => values.every(Boolean));
const scorecard = {
  valid: fontEvidence.valid === false
    && fontEvidence.substitutionApplied === false
    && fontEvidence.diagnostics.some((item) => item.ruleId === "SWF001" && item.remediation)
    && denseEvidence.valid === false
    && denseEvidence.diagnostics.some((item) => item.ruleId === "SW004" && item.suggestion)
    && missingRender.status === 1
    && denseRender.status === 1
    && noSubminimumType
    && noInvalidPptx,
  missingFont: {
    blocked: fontEvidence.valid === false,
    substitutionApplied: fontEvidence.substitutionApplied,
    suggestedThemePatch: fontEvidence.suggestedThemePatch,
    diagnostics: fontEvidence.diagnostics,
    rendererBlocked: missingRender.status === 1,
    rendererMessage: missingRender.stderr.trim().split(/\r?\n/u)[0],
  },
  denseContent: {
    blocked: denseEvidence.valid === false,
    fitErrors: denseEvidence.diagnostics.filter((item) => item.ruleId === "SW004").length,
    noSubminimumType,
    minimumTypePairs: textShapes.map((shape) => ({ id: shape.id, emitted: shape.style.fontSizePt, minimum: shape.fit.minSizePt })),
    rendererBlocked: denseRender.status === 1,
    rendererMessage: denseRender.stderr.trim().split(/\r?\n/u)[0],
  },
  invalidPptxSuppressed: noInvalidPptx,
};
await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
if (!scorecard.valid) throw new Error("Repair benchmark did not prove the required negative controls.");
process.stdout.write(`Repair benchmark passed: missing font blocked, ${scorecard.denseContent.fitErrors} dense-content fit errors, no tiny type or invalid PPTX\n`);
