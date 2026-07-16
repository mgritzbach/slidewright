#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { renderPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/renderer.mjs";
import { buildFeedbackPlanMutants, buildFeedbackSpec } from "../plugins/slidewright/skills/slidewright/scripts/benchmark/feedback_suite.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "feedback-contract");
const preview = path.join(output, "native-previews");
const positivePptx = path.join(output, "slidewright-locate-event-feedback.pptx");
const roundtripPptx = path.join(output, "slidewright-locate-event-feedback-powerpoint.pptx");
const planPath = path.join(output, "plan.json");
const manifest = JSON.parse(await fs.readFile(path.join(root, "fixtures", "feedback", "locate-event-v1", "fixture-manifest.json"), "utf8"));
const inheritedFixture = path.join(root, "fixtures", "feedback", "inherited-bullets-v1");
const inheritedSource = path.join(inheritedFixture, "slidewright-inherited-empty-bullets.pptx");
const inheritedPlan = path.join(inheritedFixture, "hygiene-plan.json");
const python = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");

function run(command, args, { expectFailure = false, capture = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: capture ? "utf8" : undefined, stdio: capture ? "pipe" : "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (expectFailure ? result.status === 0 : result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} ${expectFailure ? "unexpectedly passed" : `failed with ${result.status}`}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function findTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not find ${name}.`);
}

function stable(value) { return JSON.stringify(value); }

if (manifest.topicCount !== 17 || manifest.topics.length !== 17) throw new Error("The feedback benchmark must use the exact seventeen-topic source structure.");
if (manifest.deterministicRepetitions < 3) throw new Error("At least three deterministic repetitions are required.");

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
const spec = buildFeedbackSpec(manifest);
const compiled = Array.from({ length: manifest.deterministicRepetitions }, () => compileDeck(spec));
if (!compiled.every((plan) => stable(plan) === stable(compiled[0]))) throw new Error("Feedback compilation is nondeterministic.");
const plan = compiled[0];
const positiveLint = lintPlan(plan);
if (!positiveLint.valid) throw new Error(`Positive feedback plan failed lint: ${JSON.stringify(positiveLint.diagnostics, null, 2)}`);
if (plan.slides.length !== 34 || plan.coverage.topics.length !== 17) throw new Error("The positive fixture must contain exactly 34 slides and 17 topics.");
if (plan.hygiene.removedEmptyParagraphs !== 2) throw new Error("The inherited paragraph fixture must remove exactly two empty paragraphs.");
const splitCounts = plan.slides.flatMap((slide) => slide.layoutContract.structuralSplits ?? []).reduce((counts, split) => ({ ...counts, [split.ratio]: (counts[split.ratio] ?? 0) + 1 }), { center: 0, "two-thirds": 0 });
if (splitCounts.center !== 1 || splitCounts["two-thirds"] !== 1) throw new Error("The positive fixture must render one center split and one two-thirds split.");
await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

const expectedPlanControls = manifest.negativeControls.filter((item) => item.ruleId.startsWith("SW"));
const mutants = buildFeedbackPlanMutants(manifest);
if (stable(mutants.map(({ id, expectedRuleId }) => ({ id, ruleId: expectedRuleId }))) !== stable(expectedPlanControls)) throw new Error("Implemented plan controls do not match the frozen manifest.");
const planNegativeReports = [];
for (const mutant of mutants) {
  const reports = Array.from({ length: manifest.deterministicRepetitions }, () => lintPlan(structuredClone(mutant.plan)));
  if (!reports.every((report) => stable(report.diagnostics) === stable(reports[0].diagnostics))) throw new Error(`${mutant.id} diagnostics are nondeterministic.`);
  if (reports[0].valid || !reports[0].diagnostics.some((item) => item.ruleId === mutant.expectedRuleId)) throw new Error(`${mutant.id} did not fail ${mutant.expectedRuleId}.`);
  planNegativeReports.push({ id: mutant.id, ruleId: mutant.expectedRuleId, diagnostics: reports[0].diagnostics });
}
await fs.writeFile(path.join(output, "plan-negative-reports.json"), `${JSON.stringify(planNegativeReports, null, 2)}\n`, "utf8");

await renderPlan(plan, { out: positivePptx, previewDir: preview });
const renderedLint = JSON.parse(await fs.readFile(path.join(preview, "rendered-lint-report.json"), "utf8"));
if (!renderedLint.valid || renderedLint.renderedSlides !== 34) throw new Error("The 34-slide positive fixture failed realized-layout lint.");

const slidesTest = await findTool("slides_test.py");
const renderSlides = await findTool("render_slides.py");
run(python, [slidesTest, positivePptx]);
const auditScript = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark", "audit_feedback_contract.py");
const auditPath = path.join(output, "ooxml-audit.json");
run(python, [auditScript, positivePptx, planPath, "--json", auditPath]);
const ooxmlAudit = JSON.parse(await fs.readFile(auditPath, "utf8"));
if (!ooxmlAudit.valid || ooxmlAudit.slides !== 34 || ooxmlAudit.topics !== 17) throw new Error("Positive OOXML feedback audit failed.");

const mutantDir = path.join(output, "ooxml-mutants");
run(python, [path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark", "feedback_ooxml_negative_controls.py"), positivePptx, planPath, mutantDir]);
const ooxmlMutants = JSON.parse(await fs.readFile(path.join(mutantDir, "manifest.json"), "utf8"));
const expectedOoxmlControls = manifest.negativeControls.filter((item) => item.ruleId.startsWith("OOXML"));
if (stable(ooxmlMutants.map(({ id, ruleId }) => ({ id, ruleId }))) !== stable(expectedOoxmlControls.map(({ id, ruleId }) => ({ id, ruleId })))) throw new Error("Implemented OOXML controls do not match the frozen manifest.");
const ooxmlNegativeReports = [];
for (const mutant of ooxmlMutants) {
  const reportPath = path.join(mutantDir, `${mutant.id}-audit.json`);
  run(python, [auditScript, mutant.path, planPath, "--json", reportPath], { expectFailure: true });
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (report.valid || !report.diagnostics.some((item) => item.ruleId === mutant.ruleId)) throw new Error(`${mutant.id} did not fail ${mutant.ruleId}.`);
  ooxmlNegativeReports.push({ id: mutant.id, ruleId: mutant.ruleId, diagnostics: report.diagnostics });
}

const shortPowerPointDir = path.join("C:\\tmp", "slidewright-feedback");
const shortPowerPointInput = path.join(shortPowerPointDir, "input.pptx");
const shortPowerPointOutput = path.join(shortPowerPointDir, "output.pptx");
await fs.rm(shortPowerPointDir, { recursive: true, force: true });
await fs.mkdir(shortPowerPointDir, { recursive: true });
await fs.copyFile(positivePptx, shortPowerPointInput);
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark", "powerpoint_feedback_roundtrip.ps1"), "-InputPptx", shortPowerPointInput, "-OutputPptx", shortPowerPointOutput, "-PlanJson", planPath, "-ReportJson", path.join(output, "powerpoint-roundtrip.json")]);
await fs.copyFile(shortPowerPointOutput, roundtripPptx);
run(python, [auditScript, roundtripPptx, planPath, "--json", path.join(output, "powerpoint-ooxml-audit.json")]);
run(python, [slidesTest, roundtripPptx]);

const beforeRender = path.join(output, "powerpoint-render-before");
const afterRender = path.join(output, "powerpoint-render-after");
run(python, [renderSlides, positivePptx, "--output_dir", beforeRender]);
run(python, [renderSlides, roundtripPptx, "--output_dir", afterRender]);
run(python, [path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "template", "compare_exact_renders.py"), beforeRender, afterRender, "--slides", "34", "--json", path.join(output, "powerpoint-render-comparison.json"), "--out-dir", path.join(output, "powerpoint-render-diffs"), "--minimum", "1"]);

for (const mutant of ooxmlMutants) {
  run(python, [renderSlides, mutant.path, "--output_dir", path.join(output, "negative-renders", mutant.id)]);
}

const templateScripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "template");
const inheritedSanitized = path.join(output, "inherited-bullets-sanitized.pptx");
const inheritedRoundtrip = path.join(output, "inherited-bullets-powerpoint-roundtrip.pptx");
run(python, [path.join(templateScripts, "inherited_bullet_hygiene.py"), inheritedSource, inheritedPlan, inheritedSanitized, "--json", path.join(output, "inherited-bullet-edit.json")]);
run(python, [path.join(templateScripts, "audit_inherited_bullet_hygiene.py"), inheritedSource, inheritedSanitized, inheritedPlan, "--json", path.join(output, "inherited-bullet-audit.json")]);
run(python, [path.join(templateScripts, "inherited_bullet_negative_controls.py"), inheritedSource, inheritedSanitized, inheritedPlan, "--out-dir", path.join(output, "inherited-negative-controls"), "--json", path.join(output, "inherited-bullet-negative-controls.json")]);
run(python, [slidesTest, inheritedSanitized]);
const inheritedStage = path.join("C:\\tmp", "slidewright-g28");
await fs.rm(inheritedStage, { recursive: true, force: true });
await fs.mkdir(inheritedStage, { recursive: true });
const inheritedStageInput = path.join(inheritedStage, "sanitized.pptx");
const inheritedStageOutput = path.join(inheritedStage, "roundtrip.pptx");
await fs.copyFile(inheritedSanitized, inheritedStageInput);
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(templateScripts, "powerpoint_inherited_bullet_roundtrip.ps1"), "-InputPptx", inheritedStageInput, "-OutputPptx", inheritedStageOutput, "-ReportJson", path.join(output, "inherited-bullet-powerpoint-roundtrip.json")]);
await fs.copyFile(inheritedStageOutput, inheritedRoundtrip);
run(python, [slidesTest, inheritedRoundtrip]);
const inheritedSourceRender = path.join(output, "inherited-source-render");
const inheritedSanitizedRender = path.join(output, "inherited-sanitized-render");
const inheritedRoundtripRender = path.join(output, "inherited-roundtrip-render");
run(python, [renderSlides, inheritedSource, "--output_dir", inheritedSourceRender]);
run(python, [renderSlides, inheritedSanitized, "--output_dir", inheritedSanitizedRender]);
run(python, [renderSlides, inheritedRoundtrip, "--output_dir", inheritedRoundtripRender]);
run(python, [path.join(templateScripts, "compare_exact_renders.py"), inheritedSanitizedRender, inheritedRoundtripRender, "--slides", "2", "--json", path.join(output, "inherited-roundtrip-render-comparison.json"), "--out-dir", path.join(output, "inherited-roundtrip-render-diffs"), "--minimum", "1"]);

const powerPoint = JSON.parse((await fs.readFile(path.join(output, "powerpoint-roundtrip.json"), "utf8")).replace(/^\uFEFF/u, ""));
const powerPointAudit = JSON.parse(await fs.readFile(path.join(output, "powerpoint-ooxml-audit.json"), "utf8"));
const renderComparison = JSON.parse(await fs.readFile(path.join(output, "powerpoint-render-comparison.json"), "utf8"));
const inheritedAudit = JSON.parse(await fs.readFile(path.join(output, "inherited-bullet-audit.json"), "utf8"));
const inheritedNegatives = JSON.parse(await fs.readFile(path.join(output, "inherited-bullet-negative-controls.json"), "utf8"));
const inheritedPowerPoint = JSON.parse((await fs.readFile(path.join(output, "inherited-bullet-powerpoint-roundtrip.json"), "utf8")).replace(/^\uFEFF/u, ""));
const inheritedRenderComparison = JSON.parse(await fs.readFile(path.join(output, "inherited-roundtrip-render-comparison.json"), "utf8"));
if (!powerPoint.valid || !powerPointAudit.valid || !renderComparison.valid) throw new Error("PowerPoint round-trip proof failed.");
if (!inheritedAudit.valid || !inheritedNegatives.valid || !inheritedPowerPoint.valid || !inheritedRenderComparison.valid) throw new Error("Source-template inherited-bullet proof failed.");

const scorecardCore = {
  valid: true,
  fixtureVersion: manifest.version,
  topics: 17,
  slides: 34,
  deterministicRepetitions: manifest.deterministicRepetitions,
  planLint: { valid: positiveLint.valid, negativeControls: planNegativeReports.map(({ id, ruleId }) => ({ id, ruleId })) },
  renderedLint: { valid: renderedLint.valid, slides: renderedLint.renderedSlides },
  headlineSafeWidths: { noSplit: 32, centerSplit: splitCounts.center, twoThirdsSplit: splitCounts["two-thirds"] },
  paragraphHygiene: {
    removedGeneratedEmptyParagraphs: plan.hygiene.removedEmptyParagraphs,
    sourceTemplate: {
      bulletSource: "master-body-style",
      removedEmptyParagraphs: inheritedAudit.summary.removedInheritedEmptyParagraphs,
      preservedNativeParagraphs: inheritedAudit.summary.preservedNativeParagraphs,
      negativeControlsRejected: inheritedNegatives.summary.rejected,
      powerPointStatePreserved: inheritedPowerPoint.exactStatePreserved,
      powerPointRenderExact: inheritedRenderComparison.valid,
    },
  },
  ooxml: { valid: ooxmlAudit.valid, nativeTextShapes: ooxmlAudit.nativeTextShapes, negativeControls: ooxmlNegativeReports.map(({ id, ruleId }) => ({ id, ruleId })) },
  powerPoint: { valid: powerPoint.valid, serializedBySaveAs: powerPoint.serializedBySaveAs, exactStatePreserved: powerPoint.exactStatePreserved, sharedProcessPreserved: powerPoint.sharedProcessPreserved, renderExact: renderComparison.valid },
};
const scorecardHash = crypto.createHash("sha256").update(stable(scorecardCore)).digest("hex");
await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify({ ...scorecardCore, scorecardHash }, null, 2)}\n`, "utf8");
process.stdout.write(`G24-G28 feedback benchmark passed with scorecard ${scorecardHash}\n`);
