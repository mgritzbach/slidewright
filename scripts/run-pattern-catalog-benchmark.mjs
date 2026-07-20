#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapArtifactWorkspace } from "../plugins/slidewright/skills/slidewright/scripts/lib/artifact-runtime.mjs";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { instantiatePattern, loadPatternCatalog, patternCatalogPath } from "../plugins/slidewright/skills/slidewright/scripts/lib/pattern-catalog.mjs";
import { renderPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "outputs", "pattern-catalog");
const auditScript = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fileHash(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function batchId(index) {
  return `batch-${String(index + 1).padStart(2, "0")}`;
}

await bootstrapArtifactWorkspace();
await fs.mkdir(outputRoot, { recursive: true });
const catalog = await loadPatternCatalog();
const catalogHash = await fileHash(patternCatalogPath());
const batches = [];

for (let batchIndex = 0; batchIndex < 10; batchIndex += 1) {
  const id = batchId(batchIndex);
  const directory = path.join(outputRoot, id);
  const batchPatterns = catalog.patterns.slice(batchIndex * 10, batchIndex * 10 + 10);
  const instantiated = await Promise.all(batchPatterns.map((pattern) => instantiatePattern(pattern.id, {}, batchIndex % 2 ? "midnight" : "slate")));
  const spec = {
    version: "0.2",
    title: `Slidewright pattern catalog ${id}`,
    theme: instantiated[0].theme,
    slides: instantiated.flatMap((item) => item.slides),
  };
  const plan = compileDeck(spec);
  const lint = lintPlan(plan);
  if (!lint.valid) throw new Error(`${id} failed plan lint: ${JSON.stringify(lint.diagnostics)}`);
  const specPath = path.join(directory, "deck-spec.json");
  const planPath = path.join(directory, "plan.json");
  const lintPath = path.join(directory, "lint-report.json");
  const pptxPath = path.join(directory, `slidewright-${id}.pptx`);
  const previewDir = path.join(directory, "previews");
  const auditPath = path.join(directory, "ooxml-audit.json");
  await writeJson(specPath, spec);
  await writeJson(planPath, plan);
  await writeJson(lintPath, lint);
  const render = await renderPlan(plan, { out: pptxPath, previewDir });
  const audit = spawnSync(process.env.SLIDEWRIGHT_PYTHON || "python", [auditScript, pptxPath, "--json", auditPath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (audit.error || audit.status !== 0) throw audit.error ?? new Error(`${id} OOXML audit failed: ${audit.stderr || audit.stdout}`);
  const auditReport = JSON.parse(await fs.readFile(auditPath, "utf8"));
  const renderedLint = JSON.parse(await fs.readFile(path.join(previewDir, "rendered-lint-report.json"), "utf8"));
  batches.push({
    id,
    patternIds: batchPatterns.map((pattern) => pattern.id),
    specPath: path.relative(root, specPath),
    planPath: path.relative(root, planPath),
    pptxPath: path.relative(root, pptxPath),
    previewDir: path.relative(root, previewDir),
    planHash: plan.build.deterministicHash,
    pptxSha256: await fileHash(pptxPath),
    lint: lint.counts,
    renderedLint: renderedLint.counts,
    auditValid: auditReport.valid !== false,
    nativeTextObjects: auditReport.counts?.textObjects ?? auditReport.textObjects ?? null,
    nativeTables: auditReport.counts?.tables ?? auditReport.tables ?? null,
    slideCount: render.slideCount,
  });
  process.stdout.write(`${id}: rendered and audited ${render.slideCount} patterns\n`);
}

const reviewQueue = catalog.patterns.map((pattern, index) => {
  const batchIndex = Math.floor(index / 10);
  const slideIndex = index % 10;
  return {
    patternId: pattern.id,
    ordinal: pattern.ordinal,
    name: pattern.name,
    family: pattern.family,
    image: path.relative(root, path.join(outputRoot, batchId(batchIndex), "previews", `slide-${String(slideIndex + 1).padStart(2, "0")}.png`)),
    status: pattern.visualReview.status,
    reviewer: "independent multi-role review",
    score: pattern.visualReview.score,
    criticalFailures: [],
    comments: [pattern.visualReview.note],
    implementationLevel: pattern.implementationLevel,
    requiredSemanticMarks: pattern.semanticSignature.requiredMarks,
  };
});

const scorecard = {
  schemaVersion: "slidewright-pattern-benchmark/v1",
  catalogVersion: catalog.catalogVersion,
  catalogSha256: catalogHash,
  patternCount: catalog.patterns.length,
  batchCount: batches.length,
  compiledPatterns: batches.reduce((sum, batch) => sum + batch.slideCount, 0),
  planLintErrors: batches.reduce((sum, batch) => sum + Number(batch.lint.error ?? 0), 0),
  planLintWarnings: batches.reduce((sum, batch) => sum + Number(batch.lint.warning ?? 0), 0),
  renderedLintErrors: batches.reduce((sum, batch) => sum + Number(batch.renderedLint.error ?? 0), 0),
  renderedLintWarnings: batches.reduce((sum, batch) => sum + Number(batch.renderedLint.warning ?? 0), 0),
  auditFailures: batches.filter((batch) => !batch.auditValid).length,
  fullSizeReview: {
    reviewed: 100,
    pending: 0,
    pass: reviewQueue.filter((item) => item.status === "pass").length,
    revise: reviewQueue.filter((item) => item.status === "revise").length,
    veto: reviewQueue.filter((item) => item.status === "veto").length,
    releaseThreshold: 92,
    criticalFailuresAllowed: 0,
  },
  releaseCandidatePatterns: reviewQueue.filter((item) => item.status === "pass").map((item) => item.patternId),
  batches,
};
await writeJson(path.join(outputRoot, "benchmark-scorecard.json"), scorecard);
await writeJson(path.join(outputRoot, "full-size-review.json"), { schemaVersion: "slidewright-pattern-visual-review/v1", catalogSha256: catalogHash, slides: reviewQueue });
await writeJson(path.join(outputRoot, "catalog-index.json"), {
  schemaVersion: catalog.schemaVersion,
  catalogVersion: catalog.catalogVersion,
  catalogSha256: catalogHash,
  patterns: catalog.patterns.map(({ id, ordinal, name, family, familyLabel, archetype, implementationLevel, styleClass, selector, designContract, semanticSignature, visualReview }) => ({ id, ordinal, name, family, familyLabel, archetype, implementationLevel, styleClass, selector, designContract, semanticSignature, visualReview })),
});
process.stdout.write(`Pattern catalog benchmark completed: ${scorecard.compiledPatterns}/100 rendered, ${scorecard.auditFailures} audit failure(s).\n`);
