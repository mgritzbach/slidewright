#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { adaptExtractedProfile } from "../plugins/slidewright/skills/slidewright/scripts/lib/design-profile.mjs";
import { compileProfileContentSpec } from "../plugins/slidewright/skills/slidewright/scripts/lib/compile_profile_derivation.mjs";

const root = process.cwd();
const fixture = path.join(root, "fixtures", "design-profile", "mit-v1");
const source = path.join(fixture, "slidewright-design-profile-source.pptx");
const intentPath = path.join(fixture, "design-intent.json");
const contentPath = path.join(fixture, "content-spec.json");
const asymmetryManifestPath = path.join(fixture, "asymmetry-manifest.json");
const output = path.join(root, "outputs", "design-profile");
const scriptRoot = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");
const profileScripts = path.join(scriptRoot, "design_profile");
const sourceCopy = path.join(output, "source.pptx");
const derived = path.join(output, "derived.pptx");
const roundtrip = path.join(output, "powerpoint-roundtrip.pptx");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " " + args.join(" ") + " failed with " + result.status);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function findTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { }
  }
  throw new Error("Could not find " + name + " in the Codex presentation runtime.");
}

function canonicalHash(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.copyFile(source, sourceCopy);

const profileA = path.join(output, "profile-a.json");
const profileB = path.join(output, "profile-b.json");
for (const profile of [profileA, profileB]) {
  run(python, [path.join(profileScripts, "extract_design_profile.py"), source, "--asymmetry-manifest", asymmetryManifestPath, "--out", profile, "--quiet"]);
}
const [profileBytesA, profileBytesB] = await Promise.all([fs.readFile(profileA), fs.readFile(profileB)]);
if (!profileBytesA.equals(profileBytesB)) throw new Error("Design-profile extraction is not byte deterministic.");

const rawProfile = JSON.parse(profileBytesA.toString("utf8"));
const intent = await readJson(intentPath);
const contentSpec = await readJson(contentPath);
const reuseProfile = adaptExtractedProfile(rawProfile, intent);
const editPlan = compileProfileContentSpec(reuseProfile, contentSpec);
await writeJson(path.join(output, "reuse-profile.json"), reuseProfile);
await writeJson(path.join(output, "edit-plan.json"), editPlan);

const slidewright = path.join(scriptRoot, "slidewright.mjs");
const renderTool = await findTool("render_slides.py");
run(process.execPath, [slidewright, "profile", source, "--asymmetry-manifest", asymmetryManifestPath, "--out", path.join(output, "cli-profile.json")]);
run(process.execPath, [slidewright, "derive", path.join(output, "cli-profile.json"), "--intent", intentPath, "--content", contentPath, "--out", path.join(output, "cli-edit-plan.json")]);
if (!(await fs.readFile(path.join(output, "cli-profile.json"))).equals(profileBytesA)) throw new Error("Public profile CLI drifted from extractor output.");
if ((await fs.readFile(path.join(output, "cli-edit-plan.json"), "utf8")) !== (await fs.readFile(path.join(output, "edit-plan.json"), "utf8"))) {
  throw new Error("Public derive CLI drifted from direct compilation.");
}

run(python, [path.join(scriptRoot, "template", "edit_template.py"), source, path.join(output, "edit-plan.json"), derived, "--json", path.join(output, "edit-report.json")]);
run(python, [path.join(profileScripts, "audit_design_profile.py"), source, derived, "--profile", profileA, "--edit-plan", path.join(output, "edit-plan.json"), "--asymmetry-manifest", asymmetryManifestPath, "--json", path.join(output, "audit.json")]);
run(python, [path.join(profileScripts, "design_profile_negative_controls.py"), source, derived, profileA, "--edit-plan", path.join(output, "edit-plan.json"), "--asymmetry-manifest", asymmetryManifestPath, "--render-tool", renderTool, "--slides", "2", "--out-dir", path.join(output, "negative"), "--json", path.join(output, "negative-controls.json")]);

const powerPoint = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
try { await fs.access(powerPoint); } catch { throw new Error("Microsoft PowerPoint is required for the G22/G23 benchmark."); }
run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(profileScripts, "powerpoint_design_profile_roundtrip.ps1"), "-InputPptx", derived, "-OutputPptx", roundtrip, "-ReportJson", path.join(output, "powerpoint-roundtrip.json")]);

const slidesTest = await findTool("slides_test.py");
const montageTool = await findTool("create_montage.py");
for (const deck of [sourceCopy, derived, roundtrip]) {
  run(python, [renderTool, deck]);
  run(python, [slidesTest, deck]);
}
run(python, [path.join(scriptRoot, "template", "compare_template_renders.py"), sourceCopy, path.join(output, "edit-plan.json"), path.join(output, "source"), path.join(output, "derived"), "--json", path.join(output, "visual-audit.json"), "--out-dir", path.join(output, "visual-diff")]);
run(python, [path.join(scriptRoot, "template", "compare_exact_renders.py"), path.join(output, "derived"), path.join(output, "powerpoint-roundtrip"), "--slides", "2", "--json", path.join(output, "roundtrip-visual-audit.json"), "--out-dir", path.join(output, "roundtrip-visual-diff")]);
run(python, [montageTool, "--input_dir", path.join(output, "derived"), "--output_file", path.join(output, "montage.png")]);

const audit = await readJson(path.join(output, "audit.json"));
const negatives = await readJson(path.join(output, "negative-controls.json"));
const roundtripReport = await readJson(path.join(output, "powerpoint-roundtrip.json"));
const visual = await readJson(path.join(output, "visual-audit.json"));
const roundtripVisual = await readJson(path.join(output, "roundtrip-visual-audit.json"));
const palette = new Set(Object.values(rawProfile.themes[0].colors).map((entry) => entry.value));
const fonts = new Set(Object.values(rawProfile.themes[0].fonts).flatMap((family) => Object.values(family)));
const scorecard = {
  schemaVersion: "slidewright-design-profile-scorecard/v1",
  valid: false,
  sourceSha256: rawProfile.source.sha256,
  profileSha256: rawProfile.profileSha256,
  deterministicProfile: profileBytesA.equals(profileBytesB),
  slideSize: rawProfile.presentation.slideSize,
  guides: rawProfile.presentation.guides,
  theme: { uniqueColors: [...palette].sort(), fonts: [...fonts].sort() },
  layouts: rawProfile.layouts.filter((item) => intent.expected.layouts.includes(item.name)).map((item) => item.name).sort(),
  logos: rawProfile.assets.groups.map((item) => item.name),
  symmetryContracts: rawProfile.symmetryContracts.map((item) => ({
    id: item.id,
    first: item.first,
    second: item.second,
    thicknessEmu: item.thicknessEmu,
    offsetsEmu: item.oppositeEdgeOffsetsEmu,
    symmetric: item.symmetric,
    declaredAsymmetry: item.declaredAsymmetry !== null,
  })),
  auditValid: audit.valid,
  planBoundPreservation: audit.summary?.planBound === true && audit.summary?.packagePartsChecked > 0 && audit.summary?.authorizedTextShapes === editPlan.edits.length,
  negativeControls: negatives.controls.map((item) => ({ name: item.name, rejected: item.rejected })),
  powerpointRoundtripValid: roundtripReport.valid,
  visualAuditValid: visual.valid,
  powerpointVisualAuditValid: roundtripVisual.valid,
};
scorecard.valid = scorecard.deterministicProfile
  && scorecard.guides.length === 4
  && scorecard.theme.uniqueColors.length === 5
  && scorecard.theme.fonts.length === 1 && scorecard.theme.fonts[0] === "Arial"
  && scorecard.layouts.length === 2
  && scorecard.logos.includes(intent.expected.logoGroup)
  && scorecard.symmetryContracts.length === 5
  && scorecard.symmetryContracts.filter((item) => item.symmetric).length === 4
  && scorecard.symmetryContracts.filter((item) => !item.symmetric && item.declaredAsymmetry).length === 1
  && scorecard.auditValid
  && scorecard.planBoundPreservation
  && scorecard.negativeControls.length === 8
  && scorecard.negativeControls.some((item) => item.name === "target-slide-undeclared-drift" && item.rejected)
  && scorecard.negativeControls.some((item) => item.name === "rendered-rim-geometry-drift" && item.rejected)
  && scorecard.negativeControls.every((item) => item.rejected)
  && scorecard.powerpointRoundtripValid
  && scorecard.visualAuditValid
  && scorecard.powerpointVisualAuditValid;
scorecard.scorecardHash = canonicalHash(scorecard);
await writeJson(path.join(output, "scorecard.json"), scorecard);
if (!scorecard.valid) throw new Error("G22/G23 design-profile scorecard is incomplete.");
process.stdout.write("G22/G23 design-profile benchmark passed with scorecard " + scorecard.scorecardHash + "\n");
