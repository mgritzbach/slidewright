#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableJson } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";

const root = process.cwd();
const published = path.join(root, "outputs", "copy-resilience");
const inputIndex = process.argv.indexOf("--decisions");
if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error("Usage: finalize-copy-resilience-review --decisions <review-decisions.json>");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function replaceFileAtomically(target, contents) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, contents, "utf8");
  try { await fs.rename(temporary, target); } finally { await fs.rm(temporary, { force: true }); }
}

const current = JSON.parse(await fs.readFile(path.join(published, "current.json"), "utf8"));
if (current.schemaVersion !== "slidewright-copy-resilience-current/v1") throw new Error("Current C15 machine pointer is missing or unsupported.");
const run = path.join(published, ...current.run.split("/"));
const scorecard = JSON.parse(await fs.readFile(path.join(run, "scorecard.json"), "utf8"));
if (!scorecard.valid || scorecard.scorecardHash !== current.scorecardHash || !scorecard.reviewArtifactsReady) throw new Error("Current C15 scorecard is invalid or not review-ready.");
const expected = scorecard.cases.flatMap((item) => item.reviewArtifacts).sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
const supplied = JSON.parse(await fs.readFile(path.resolve(process.argv[inputIndex + 1]), "utf8"));
if (supplied.machineScorecardHash !== current.scorecardHash) throw new Error("Review decisions are not bound to the current C15 machine scorecard.");
if (supplied.reviewMethod !== "individual-original-resolution") throw new Error("C15 review must use individual-original-resolution; a montage is not evidence.");
if (!Array.isArray(supplied.decisions) || supplied.decisions.length !== expected.length) throw new Error(`C15 review requires exactly ${expected.length} individual decisions.`);

const decisions = [...supplied.decisions].sort((left, right) => String(left.path).localeCompare(String(right.path), undefined, { numeric: true }));
for (let index = 0; index < expected.length; index += 1) {
  const want = expected[index];
  const got = decisions[index];
  if (got.path !== want.path || got.sha256 !== want.sha256) throw new Error(`Review decision ${index + 1} does not match the bound preview path and hash.`);
  if (got.status !== "GO") throw new Error(`Review decision ${got.path} is not GO.`);
  if (typeof got.note !== "string" || got.note.trim().length < 12) throw new Error(`Review decision ${got.path} needs a substantive note.`);
  const actualHash = sha256(await fs.readFile(path.join(run, ...got.path.split("/"))));
  if (actualHash !== want.sha256) throw new Error(`Review artifact bytes drifted for ${got.path}.`);
}

const review = {
  schemaVersion: "slidewright-copy-resilience-review/v1",
  machineScorecardHash: current.scorecardHash,
  reviewer: supplied.reviewer,
  reviewMethod: supplied.reviewMethod,
  reviewImplementationSha256: sha256(await fs.readFile(fileURLToPath(import.meta.url))),
  montageAcceptedAsEvidence: false,
  expectedDecisionCount: expected.length,
  decisionCount: decisions.length,
  allGo: true,
  decisions,
  valid: true,
};
review.reviewHash = sha256(Buffer.from(stableJson(review), "utf8"));
const relative = `reviews/${current.scorecardHash}/${review.reviewHash}.json`;
await replaceFileAtomically(path.join(published, ...relative.split("/")), `${JSON.stringify(review, null, 2)}\n`);
await replaceFileAtomically(path.join(published, "current-review.json"), `${JSON.stringify({
  schemaVersion: "slidewright-copy-resilience-review-current/v1",
  machineScorecardHash: current.scorecardHash,
  reviewHash: review.reviewHash,
  review: relative,
}, null, 2)}\n`);
process.stdout.write(`C15 full-size review finalized: ${decisions.length} individual GO decisions, review ${review.reviewHash}.\n`);
