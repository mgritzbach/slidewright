#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildIterationManifests, buildIterationPlan } from "../plugins/slidewright/skills/slidewright/scripts/benchmark/iteration_suite.mjs";
import { applyNamedEditManifest, canonicalHash, fingerprintNamedObjects } from "../plugins/slidewright/skills/slidewright/scripts/lib/named-edits.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "iteration");
const cli = path.join(root, "packages", "cli", "src", "cli.mjs");
const benchmark = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "benchmark");
const auditPptx = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py");
const packageAudit = path.join(benchmark, "audit_iteration_package.py");
const renderCompare = path.join(benchmark, "compare_iteration_renders.py");
const negativeControls = path.join(benchmark, "iteration_negative_controls.py");
const powerPointRoundTrip = path.join(benchmark, "powerpoint_iteration_roundtrip.ps1");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* PATH fallback */ }

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
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

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(file) {
  return fs.readFile(file, "utf8").then((value) => JSON.parse(value.replace(/^\uFEFF/u, "")));
}

function csv(values) {
  return values.join(",");
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
run(process.execPath, [path.join(root, "scripts", "setup-artifact-runtime.mjs")]);
const renderTool = await findTool("render_slides.py");
const slidesTest = await findTool("slides_test.py");

const baselinePlan = buildIterationPlan();
const baselinePlanPath = path.join(output, "baseline-plan.json");
const baselineDeck = path.join(output, "baseline.pptx");
await writeJson(baselinePlanPath, baselinePlan);
run(process.execPath, [cli, "lint", baselinePlanPath, "--out", path.join(output, "baseline-lint.json")]);
run(process.execPath, [cli, "render", baselinePlanPath, "--out", baselineDeck]);
run(python, [auditPptx, baselineDeck, "--json", path.join(output, "baseline-ooxml-audit.json")]);
run(python, [renderTool, baselineDeck]);
run(python, [slidesTest, baselineDeck]);

const repeatDeck = path.join(output, "baseline-repeat.pptx");
run(process.execPath, [cli, "render", baselinePlanPath, "--out", repeatDeck]);
run(python, [renderTool, repeatDeck]);
run(python, [packageAudit, baselineDeck, repeatDeck, "--allowed-changed", "", "--required-changed", "", "--require-identical-package", "--json", path.join(output, "baseline-repeat-package-audit.json")]);
run(python, [renderCompare, baselineDeck, repeatDeck, path.join(output, "baseline"), path.join(output, "baseline-repeat"), "--mask-ids", "", "--json", path.join(output, "baseline-repeat-render-audit.json")]);
const baselinePackageHash = createHash("sha256").update(await fs.readFile(baselineDeck)).digest("hex");
const repeatPackageHash = createHash("sha256").update(await fs.readFile(repeatDeck)).digest("hex");

const variants = [];
for (const manifest of buildIterationManifests(baselinePlan)) {
  const folder = path.join(output, "variants", manifest.id);
  const planPath = path.join(folder, "plan.json");
  const deck = path.join(folder, `${manifest.id}.pptx`);
  const result = applyNamedEditManifest(baselinePlan, manifest);
  const requiredChangedIds = result.changedIds;
  const maskIds = requiredChangedIds;
  await writeJson(path.join(folder, "manifest.json"), manifest);
  await writeJson(planPath, result.plan);
  await writeJson(path.join(folder, "plan-object-comparison.json"), result.comparison);
  run(process.execPath, [cli, "lint", planPath, "--out", path.join(folder, "lint.json")]);
  run(process.execPath, [cli, "render", planPath, "--out", deck]);
  run(python, [auditPptx, deck, "--json", path.join(folder, "ooxml-audit.json")]);
  run(python, [renderTool, deck]);
  run(python, [slidesTest, deck]);
  run(python, [packageAudit, baselineDeck, deck, "--allowed-changed", csv(result.changedIds), "--required-changed", csv(requiredChangedIds), "--json", path.join(folder, "package-audit.json")]);
  run(python, [renderCompare, baselineDeck, deck, path.join(output, "baseline"), path.join(folder, manifest.id), "--mask-ids", csv(maskIds), "--json", path.join(folder, "render-locality-audit.json")]);
  variants.push({
    id: manifest.id,
    deck,
    renderDir: path.join(folder, manifest.id),
    changedIds: result.changedIds,
    requiredChangedIds,
    maskIds,
    planObjectComparison: result.comparison,
    packageAudit: await readJson(path.join(folder, "package-audit.json")),
    renderAudit: await readJson(path.join(folder, "render-locality-audit.json")),
  });
}

const textVariant = variants.find((variant) => variant.id === "text");
run(python, [
  negativeControls,
  baselineDeck,
  textVariant.deck,
  path.join(output, "baseline"),
  textVariant.renderDir,
  "--allowed-changed", csv(textVariant.changedIds),
  "--required-changed", csv(textVariant.requiredChangedIds),
  "--mask-ids", csv(textVariant.maskIds),
  "--audit-script", packageAudit,
  "--compare-script", renderCompare,
  "--json", path.join(output, "negative-controls.json"),
]);
const negativeReport = await readJson(path.join(output, "negative-controls.json"));

const powerPointPath = "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE";
let powerPointReport = { valid: false, skipped: true, reason: "Microsoft PowerPoint is unavailable." };
const roundTripRenderAudits = [];
if (await exists(powerPointPath)) {
  const cases = [
    { id: "baseline", input: baselineDeck, output: path.join(output, "powerpoint-roundtrip", "baseline.pptx") },
    ...variants.map((variant) => ({ id: variant.id, input: variant.deck, output: path.join(output, "powerpoint-roundtrip", `${variant.id}.pptx`) })),
  ];
  const casesPath = path.join(output, "powerpoint-cases.json");
  await writeJson(casesPath, cases);
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", powerPointRoundTrip, "-CasesJson", casesPath, "-ReportJson", path.join(output, "powerpoint-roundtrip.json")]);
  powerPointReport = await readJson(path.join(output, "powerpoint-roundtrip.json"));
  for (const item of cases) {
    const sourceRenderDir = item.id === "baseline" ? path.join(output, "baseline") : variants.find((variant) => variant.id === item.id).renderDir;
    const roundTripRenderDir = path.join(output, "powerpoint-roundtrip", item.id);
    run(process.execPath, [cli, "verify", item.output, "--out", path.join(output, "powerpoint-roundtrip", `${item.id}-delivery.json`)]);
    run(python, [auditPptx, item.output, "--json", path.join(output, "powerpoint-roundtrip", `${item.id}-ooxml-audit.json`)]);
    run(python, [renderTool, item.output]);
    run(python, [slidesTest, item.output]);
    const sourceDeck = item.id === "baseline" ? baselineDeck : variants.find((variant) => variant.id === item.id).deck;
    const renderAuditPath = path.join(output, "powerpoint-roundtrip", `${item.id}-render-audit.json`);
    run(python, [renderCompare, sourceDeck, item.output, sourceRenderDir, roundTripRenderDir, "--mask-ids", "", "--json", renderAuditPath]);
    roundTripRenderAudits.push({ id: item.id, ...(await readJson(renderAuditPath)) });
  }
}

const scorecard = {
  valid: true,
  c16ProofComplete: true,
  version: "c16-v1",
  baseline: {
    planHash: baselinePlan.build.deterministicHash,
    namedObjectCount: Object.keys(fingerprintNamedObjects(baselinePlan)).length,
    rawPackageHashEqual: baselinePackageHash === repeatPackageHash,
    deterministicNormalization: {
      excludedFields: [],
      relationshipIdsAndReferences: "sorted and deterministically rewritten",
      coreTimestamps: "fixed",
      creationIds: "deterministic UUIDv5",
      zipMetadata: "sorted entries with fixed timestamps and compression metadata",
    },
    packageAudit: await readJson(path.join(output, "baseline-repeat-package-audit.json")),
    renderAudit: await readJson(path.join(output, "baseline-repeat-render-audit.json")),
  },
  variants,
  negativeControls: negativeReport,
  powerPoint: powerPointReport,
  powerPointRenderAudits: roundTripRenderAudits,
};
scorecard.valid = Boolean(
  scorecard.baseline.rawPackageHashEqual
  && scorecard.baseline.packageAudit.valid
  && scorecard.baseline.renderAudit.valid
  && variants.length === 6
  && variants.every((variant) => variant.planObjectComparison.valid && variant.packageAudit.valid && variant.renderAudit.valid)
  && negativeReport.valid
  && negativeReport.rejectedArtifactsDeleted
  && powerPointReport.valid
  && powerPointReport.cases?.length === 7
  && roundTripRenderAudits.length === 7
  && roundTripRenderAudits.every((report) => report.valid)
);
scorecard.c16ProofComplete = scorecard.valid;
scorecard.scorecardHash = canonicalHash({ ...scorecard, scorecardHash: undefined });
await writeJson(path.join(output, "scorecard.json"), scorecard);
if (!scorecard.valid) throw new Error("C16 fine-grained iteration scorecard is not complete.");
process.stdout.write(`C16 fine-grained iteration passed with scorecard ${scorecard.scorecardHash}\n`);
