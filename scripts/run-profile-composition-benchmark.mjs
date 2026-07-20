#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const fixture = path.join(root, "fixtures", "design-profile", "mit-v1");
const source = path.join(fixture, "slidewright-design-profile-source.pptx");
const intent = path.join(fixture, "design-intent.json");
const content = path.join(fixture, "composition-spec.json");
const asymmetry = path.join(fixture, "asymmetry-manifest.json");
const output = path.join(root, "outputs", "profile-composition");
const scriptRoot = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");
const profileScripts = path.join(scriptRoot, "design_profile");
const templateScripts = path.join(scriptRoot, "template");
const slidewright = path.join(scriptRoot, "slidewright.mjs");
const profile = path.join(output, "profile.json");
const sourceCopy = path.join(output, "source.pptx");
const plan = path.join(output, "composition-plan.json");
const composed = path.join(output, "composed.pptx");
const composedRepeat = path.join(output, "composed-repeat.pptx");
const provenance = path.join(output, "provenance.json");
const provenanceRepeat = path.join(output, "provenance-repeat.json");
const roundtrip = path.join(output, "powerpoint-roundtrip.pptx");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { }

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label ?? command} failed with ${result.status}.`);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { }
  }
  throw new Error(`Could not find ${name}; run npm run setup:runtime first.`);
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.copyFile(source, sourceCopy);

run(process.execPath, [slidewright, "profile", source, "--asymmetry-manifest", asymmetry, "--out", profile], "profile extraction");
run(process.execPath, [slidewright, "derive", profile, "--intent", intent, "--content", content, "--out", plan], "composition-plan derivation");
run(process.execPath, [slidewright, "compose-profile", source, "--plan", plan, "--out", composed, "--report", provenance], "source-native composition");
run(process.execPath, [slidewright, "compose-profile", source, "--plan", plan, "--out", composedRepeat, "--report", provenanceRepeat], "repeat source-native composition");
if ((await sha256(composed)) !== (await sha256(composedRepeat))) throw new Error("Composed PPTX bytes are not deterministic.");
if ((await sha256(provenance)) !== (await sha256(provenanceRepeat))) throw new Error("Composition provenance is not deterministic.");

run(python, [path.join(profileScripts, "audit_profile_composition.py"), source, composed,
  "--profile", profile, "--plan", plan, "--provenance", provenance,
  "--asymmetry-manifest", asymmetry, "--json", path.join(output, "structural-audit.json")], "composition structural audit");
run(python, [path.join(profileScripts, "profile_composition_negative_controls.py"), source, composed, profile, plan, provenance,
  "--asymmetry-manifest", asymmetry, "--out-dir", path.join(output, "negative-controls"),
  "--json", path.join(output, "negative-controls.json")], "composition negative controls");

const renderTool = await findPresentationTool("render_slides.py");
const slidesTest = await findPresentationTool("slides_test.py");
run(python, [renderTool, sourceCopy], "source render");
run(python, [renderTool, composed], "composition render");
run(python, [slidesTest, composed], "composition overflow audit");
run(python, [path.join(profileScripts, "compare_profile_composition_renders.py"), sourceCopy, plan,
  path.join(output, "source"), path.join(output, "composed"),
  "--json", path.join(output, "mapped-visual-audit.json"), "--out-dir", path.join(output, "mapped-visual-diff")], "mapped visual audit");

const powerPoint = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
try { await fs.access(powerPoint); } catch { throw new Error("Microsoft PowerPoint is required for the g22-v2 evidence benchmark."); }
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(templateScripts, "powerpoint_template_matrix_roundtrip.ps1"),
  "-InputPptx", composed, "-OutputPptx", roundtrip, "-ReportJson", path.join(output, "powerpoint-roundtrip.json"),
  "-OwnershipRecordJson", path.join(output, "powerpoint-ownership.json"), "-FixtureId", "g22-v2"], "safe PowerPoint roundtrip");
run(python, [path.join(profileScripts, "audit_profile_composition_roundtrip.py"), composed, roundtrip,
  "--asymmetry-manifest", asymmetry,
  "--json", path.join(output, "powerpoint-semantic-audit.json")], "PowerPoint semantic audit");
run(python, [renderTool, roundtrip], "PowerPoint roundtrip render");
run(python, [slidesTest, roundtrip], "PowerPoint roundtrip overflow audit");
run(python, [path.join(templateScripts, "compare_exact_renders.py"), path.join(output, "composed"), path.join(output, "powerpoint-roundtrip"),
  "--slides", "4", "--minimum", "0.999", "--json", path.join(output, "powerpoint-visual-audit.json"),
  "--out-dir", path.join(output, "powerpoint-visual-diff")], "PowerPoint visual audit");

const [structural, negatives, visual, powerPointReport, powerPointSemantic, powerPointVisual, compositionPlan] = await Promise.all([
  readJson(path.join(output, "structural-audit.json")), readJson(path.join(output, "negative-controls.json")),
  readJson(path.join(output, "mapped-visual-audit.json")), readJson(path.join(output, "powerpoint-roundtrip.json")),
  readJson(path.join(output, "powerpoint-semantic-audit.json")), readJson(path.join(output, "powerpoint-visual-audit.json")), readJson(plan),
]);
const automatedValid = structural.valid === true
  && negatives.controls?.length === 8 && negatives.controls.every((item) => item.rejected === true)
  && visual.valid === true && visual.slides?.length === 4
  && powerPointReport.valid === true && powerPointSemantic.valid === true && powerPointVisual.valid === true;
const scorecard = {
  schemaVersion: "slidewright-profile-composition-scorecard/v1",
  automatedValid,
  goalComplete: false,
  goalCompletionBlocker: "Inspect each of the four hash-bound composed and PowerPoint-roundtrip renders individually at full size and record the reviewer kind before crediting G22.",
  sourceSha256: compositionPlan.sourceSha256,
  composedSha256: await sha256(composed),
  deterministicComposition: (await sha256(composed)) === (await sha256(composedRepeat)),
  sourceSlideCount: compositionPlan.sourceSlideCount,
  outputSlideCount: compositionPlan.outputSlideCount,
  structuralAuditValid: structural.valid,
  negativeControls: negatives.controls.map((item) => ({ name: item.name, rejected: item.rejected })),
  mappedVisualAuditValid: visual.valid,
  powerpointRoundtripValid: powerPointReport.valid,
  powerpointSemanticAuditValid: powerPointSemantic.valid,
  powerpointVisualAuditValid: powerPointVisual.valid,
};
await writeJson(path.join(output, "scorecard.json"), scorecard);
if (!automatedValid) throw new Error("g22-v2 profile-composition automated evidence is incomplete.");
const scorecardSha256 = await sha256(path.join(output, "scorecard.json"));
const reviewSlides = [];
for (const deck of ["composed", "powerpoint-roundtrip"]) {
  for (let slide = 1; slide <= 4; slide += 1) {
    const relativePath = `${deck}/slide-${slide}.png`;
    reviewSlides.push({ deck, slide, path: relativePath, imageSha256: await sha256(path.join(output, ...relativePath.split("/"))), decision: null });
  }
}
await writeJson(path.join(output, "full-size-review-template.json"), {
  schemaVersion: "slidewright-profile-composition-review/v1",
  scorecardSha256,
  reviewMethod: "full-size-individual",
  reviewerKind: null,
  reviewerIdSha256: null,
  reviewedAt: null,
  slides: reviewSlides,
});
process.stdout.write("g22-v2 automated benchmark passed; full-size individual review remains required.\n");
