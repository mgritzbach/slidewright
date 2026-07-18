#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalHash,
  readJson,
  sha256File,
  verifyTemplateMatrixEvidence,
  verifyTemplateMatrixReview,
} from "./lib/template-matrix-evidence.mjs";

const root = process.cwd();
const published = path.join(root, "outputs", "template-matrix");
let inputPath = null;
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--input") inputPath = process.argv[++index];
  else throw new Error(`Unknown argument ${process.argv[index]}.`);
}
if (!inputPath) throw new Error("Usage: node scripts/finalize-template-matrix-review.mjs --input <review-input.json>");

const pointer = await readJson(path.join(published, "current.json"));
if (pointer.schemaVersion !== "slidewright-template-matrix-current/v1" || pointer.run !== `runs/${pointer.scorecardHash}`) throw new Error("C10 current pointer is invalid.");
const runDirectory = path.join(published, "runs", pointer.scorecardHash);
await verifyTemplateMatrixEvidence({ root, runDirectory, requireCurrentSource: true });
const scorecard = await readJson(path.join(runDirectory, "scorecard.json"));
const input = await readJson(path.resolve(inputPath));
if (input.schemaVersion !== "slidewright-template-matrix-review-input/v1" || input.scorecardHash !== pointer.scorecardHash
  || !input.reviewer?.kind || !input.reviewer?.id || !Array.isArray(input.artifacts)) {
  throw new Error("C10 review input lacks its schema, scorecard binding, reviewer, or artifact decisions.");
}
const decisions = new Map();
for (const decision of input.artifacts) {
  if (typeof decision.path !== "string" || decisions.has(decision.path) || !["pass", "fail"].includes(decision.verdict) || !Array.isArray(decision.findings)) {
    throw new Error(`C10 review decision is invalid or duplicated: ${decision.path}`);
  }
  decisions.set(decision.path, decision);
}
if (decisions.size !== scorecard.reviewArtifacts.length) throw new Error(`C10 review requires exactly ${scorecard.reviewArtifacts.length} decisions.`);
const artifacts = [];
for (const expected of scorecard.reviewArtifacts) {
  const decision = decisions.get(expected.path);
  if (!decision) throw new Error(`C10 review is missing ${expected.path}.`);
  const absolute = path.resolve(runDirectory, ...expected.path.split("/"));
  if (!absolute.startsWith(path.resolve(runDirectory) + path.sep) || await sha256File(absolute) !== expected.sha256) throw new Error(`C10 review artifact drifted: ${expected.path}`);
  artifacts.push({ ...expected, verdict: decision.verdict, findings: decision.findings });
}
const review = {
  schemaVersion: "slidewright-template-matrix-review/v1",
  valid: artifacts.every((item) => item.verdict === "pass" && item.findings.length === 0),
  scorecardHash: pointer.scorecardHash,
  reviewer: input.reviewer,
  inspectionMethod: "Every source, edited, PowerPoint-round-tripped, and intentionally corrupted slide render was inspected individually at full size; montages were overview-only.",
  artifacts,
};
review.reviewHash = canonicalHash(review);
const relativeReview = `reviews/${pointer.scorecardHash}/${review.reviewHash}.json`;
const reviewPath = path.join(published, ...relativeReview.split("/"));
await fs.mkdir(path.dirname(reviewPath), { recursive: true });
const contents = `${JSON.stringify(review, null, 2)}\n`;
try {
  const existing = await fs.readFile(reviewPath, "utf8");
  if (existing !== contents) throw new Error("Existing C10 content-addressed review has different bytes.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await fs.writeFile(reviewPath, contents, "utf8");
}
if (review.valid) {
  await fs.writeFile(path.join(published, "current-review.json"), `${JSON.stringify({
    schemaVersion: "slidewright-template-matrix-current-review/v1",
    scorecardHash: pointer.scorecardHash,
    reviewHash: review.reviewHash,
    review: relativeReview,
  }, null, 2)}\n`, "utf8");
  await verifyTemplateMatrixReview({ root, published, requireCurrentSource: true });
}
process.stdout.write(`${review.valid ? "C10 full-size review passed" : "C10 review recorded failures"}: ${reviewPath}\n`);
if (!review.valid) process.exitCode = 1;
