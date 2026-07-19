#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";
import { renderPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/renderer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "fixtures", "emphasis-pattern", "deck-spec.json");
const output = path.join(root, "outputs", "emphasis-pattern");
const previewDir = path.join(output, "previews");
const planPath = path.join(output, "plan.json");
const deckPath = path.join(output, "emphasis-pattern.pptx");
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function runPython(args) {
  const command = process.env.SLIDEWRIGHT_PYTHON || "python";
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || result.stdout || `Python failed with status ${result.status}.`);
}

function requireOnlySw030(id, plan) {
  const report = lintPlan(plan);
  const ruleIds = report.diagnostics.map((item) => item.ruleId);
  if (report.valid || ruleIds.length !== 1 || ruleIds[0] !== "SW030") {
    throw new Error(`${id} must fail only SW030; received ${ruleIds.join(", ") || "no diagnostics"}.`);
  }
  return { id, expectedRuleId: "SW030", observedRuleIds: ruleIds, valid: true };
}

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(previewDir, { recursive: true });
const spec = JSON.parse(await fs.readFile(fixturePath, "utf8"));
const plan = compileDeck(spec);
const lint = lintPlan(plan);
if (!lint.valid || lint.counts.error || lint.counts.warning) throw new Error(`Positive fixture failed lint: ${JSON.stringify(lint.diagnostics)}.`);

const body = plan.slides[0].shapes.find((shape) => shape.role === "body");
const peers = body.text.paragraphs.slice(1);
if (peers.length !== 4 || !peers.every((paragraph) => paragraph.runs.length === 2 && paragraph.runs[0].bold === true && paragraph.runs[1].bold === false)) {
  throw new Error("Positive fixture lost an editable label/body run boundary.");
}
if (peers.at(-1).runs[0].italic !== true || peers.at(-1).runs[1].italic !== false) throw new Error("Label-only italics leaked into the final explanation.");

const alternating = structuredClone(plan);
const alternatingPeers = alternating.slides[0].shapes.find((shape) => shape.role === "body").text.paragraphs.slice(1);
alternatingPeers.forEach((paragraph, index) => {
  paragraph.runs = [{ text: paragraph.runs.map((run) => run.text).join(""), bold: index % 2 === 1, italic: false }];
});
const leaked = structuredClone(plan);
leaked.slides[0].shapes.find((shape) => shape.role === "body").text.paragraphs.at(-1).runs[1].bold = true;
const firstWordLeak = structuredClone(plan);
const firstWordParagraph = firstWordLeak.slides[0].shapes.find((shape) => shape.role === "body").text.paragraphs.at(-1);
const explanation = firstWordParagraph.runs[1].text;
const firstBoundary = explanation.indexOf(" ", 1);
firstWordParagraph.runs.splice(1, 1,
  { ...firstWordParagraph.runs[1], text: explanation.slice(0, firstBoundary), bold: true },
  { ...firstWordParagraph.runs[1], text: explanation.slice(firstBoundary), bold: false },
);
const negativeControls = [
  requireOnlySw030("alternating-whole-paragraph-emphasis", alternating),
  requireOnlySw030("single-explanation-emphasis-leak", leaked),
  requireOnlySw030("first-word-explanation-emphasis-leak", firstWordLeak),
];

await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(output, "lint-report.json"), `${JSON.stringify(lint, null, 2)}\n`, "utf8");
await renderPlan(plan, { out: deckPath, previewDir });
runPython([
  path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_request_plan.py"),
  deckPath, planPath, "--json", path.join(output, "plan-audit.json"),
]);
runPython([
  path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "audit_pptx.py"),
  deckPath, "--json", path.join(output, "ooxml-audit.json"),
]);
const planAudit = JSON.parse(await fs.readFile(path.join(output, "plan-audit.json"), "utf8"));
const ooxmlAudit = JSON.parse(await fs.readFile(path.join(output, "ooxml-audit.json"), "utf8"));
if (!planAudit.valid || !ooxmlAudit.valid) throw new Error("Native export audit failed.");

const previewPath = path.join(previewDir, "slide-01.png");
const scorecard = {
  schemaVersion: "slidewright-emphasis-pattern-scorecard/v1",
  valid: true,
  fixture: path.relative(root, fixturePath).replaceAll("\\", "/"),
  ruleId: "SW030",
  paragraphs: peers.length,
  editableRunBoundaries: peers.reduce((sum, paragraph) => sum + paragraph.runs.length, 0),
  labelSpecificItalicPreserved: true,
  planAudit: {
    valid: planAudit.valid,
    expectedTextObjects: planAudit.expectedTextObjects,
    matchedTextObjects: planAudit.matchedTextObjects,
    expectedParagraphs: planAudit.expectedParagraphs,
    matchedParagraphs: planAudit.matchedParagraphs,
  },
  ooxmlAudit: ooxmlAudit.summary,
  negativeControls,
  artifacts: {
    planSha256: sha256(await fs.readFile(planPath)),
    pptxSha256: sha256(await fs.readFile(deckPath)),
    previewSha256: sha256(await fs.readFile(previewPath)),
  },
};
await fs.writeFile(path.join(output, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
process.stdout.write(`Emphasis-pattern benchmark passed: ${peers.length} peer paragraphs, ${scorecard.editableRunBoundaries} native runs, ${negativeControls.length} rejected controls.\n`);
