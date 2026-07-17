#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const decisionsPath = option("--decisions");
if (!decisionsPath) throw new Error("--decisions <review-decisions.json> is required.");
const root = process.cwd();
const published = path.join(root, "outputs", "prompt-robustness");
const scorecard = JSON.parse(await fs.readFile(path.join(published, "scorecard.json"), "utf8"));
if (scorecard.schemaVersion !== "slidewright-prompt-robust-scorecard/v1" || !scorecard.valid || !scorecard.reviewArtifactsReady) throw new Error("Current C12 machine scorecard is not ready for review finalization.");
const decisions = JSON.parse(await fs.readFile(path.resolve(decisionsPath), "utf8"));
if (decisions.schemaVersion !== "slidewright-prompt-review-decisions/v1" || !Array.isArray(decisions.decisions)) throw new Error("Invalid C12 review decision schema.");

const expected = scorecard.uniquePositiveOutputs.flatMap((output) => output.previewHashes.map((preview, index) => ({
  group: output.group,
  slide: index + 1,
  previewSha256: preview.sha256,
  previewPath: `${output.representativeRun}/${preview.path}`,
})));
if (expected.length !== 9 || decisions.decisions.length !== expected.length) throw new Error(`Exactly ${expected.length} individual full-size decisions are required.`);
const byKey = new Map(decisions.decisions.map((decision) => [`${decision.group}:${decision.slide}`, decision]));
if (byKey.size !== decisions.decisions.length) throw new Error("Duplicate C12 review decision.");
const runRoot = path.join(published, "runs", scorecard.scorecardHash);
for (const item of expected) {
  const decision = byKey.get(`${item.group}:${item.slide}`);
  if (!decision) throw new Error(`Missing review decision for ${item.group} slide ${item.slide}.`);
  if (decision.previewSha256 !== item.previewSha256) throw new Error(`Review hash mismatch for ${item.group} slide ${item.slide}.`);
  if (decision.status !== "GO" || typeof decision.note !== "string" || !decision.note.trim()) throw new Error(`Review decision for ${item.group} slide ${item.slide} must be GO with a non-empty note.`);
  const bytes = await fs.readFile(path.join(runRoot, ...item.previewPath.split("/")));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== item.previewSha256) throw new Error(`Preview bytes drifted for ${item.group} slide ${item.slide}.`);
}

const recordCore = {
  schemaVersion: "slidewright-prompt-review/v1",
  machineScorecardHash: scorecard.scorecardHash,
  reviewer: decisions.reviewer,
  reviewMethod: decisions.reviewMethod,
  reviewImplementationSha256: createHash("sha256").update(await fs.readFile(fileURLToPath(import.meta.url))).digest("hex"),
  montageAcceptedAsEvidence: false,
  expectedDecisionCount: expected.length,
  decisionCount: decisions.decisions.length,
  allGo: decisions.decisions.every((decision) => decision.status === "GO"),
  decisions: expected.map((item) => ({ ...item, ...byKey.get(`${item.group}:${item.slide}`) })),
};
if (typeof recordCore.reviewer !== "string" || !recordCore.reviewer.trim()) throw new Error("Reviewer identity is required.");
if (recordCore.reviewMethod !== "individual-original-resolution") throw new Error("Review method must be individual-original-resolution.");
const reviewHash = createHash("sha256").update(stableJson(recordCore)).digest("hex");
const record = { ...recordCore, valid: recordCore.allGo && recordCore.decisionCount === recordCore.expectedDecisionCount, reviewHash };
if (!record.valid) throw new Error("C12 full-size review did not close.");
const reviews = path.join(published, "reviews", scorecard.scorecardHash);
await fs.mkdir(reviews, { recursive: true });
const finalPath = path.join(reviews, `${reviewHash}.json`);
const payload = `${JSON.stringify(record, null, 2)}\n`;
try {
  await fs.writeFile(finalPath, payload, { encoding: "utf8", flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST" || await fs.readFile(finalPath, "utf8") !== payload) throw error;
}
const pointer = { schemaVersion: "slidewright-prompt-review-current/v1", machineScorecardHash: scorecard.scorecardHash, reviewHash, review: path.relative(published, finalPath).split(path.sep).join("/") };
const pointerPath = path.join(published, "current-review.json");
const temporary = `${pointerPath}.tmp-${process.pid}-${Date.now()}`;
await fs.writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
await fs.rename(temporary, pointerPath);
process.stdout.write(`C12 full-size review finalized: ${record.decisionCount} individual GO decisions, review ${reviewHash}.\n`);
