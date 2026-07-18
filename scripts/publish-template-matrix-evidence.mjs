#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalHash, readJson, sha256File, verifyTemplateMatrixReview } from "./lib/template-matrix-evidence.mjs";
import { verifyPublishedTemplateMatrixEvidence } from "./lib/template-matrix-public-evidence.mjs";

const root = process.cwd();
const source = path.join(root, "outputs", "template-matrix");
const published = path.join(root, "evidence", "c10", "v1");
const machine = await verifyTemplateMatrixReview({ root, published: source, requireCurrentSource: true });
const current = await readJson(path.join(source, "current.json"));
const currentReview = await readJson(path.join(source, "current-review.json"));
const scorecardSource = path.join(source, ...current.run.split("/"), "scorecard.json");
const reviewSource = path.join(source, ...currentReview.review.split("/"));
const runRelative = `runs/${machine.scorecardHash}`;
const reviewRelative = `reviews/${machine.reviewHash}.json`;
const runDirectory = path.join(published, ...runRelative.split("/"));
await fs.mkdir(runDirectory, { recursive: true });
await fs.mkdir(path.join(published, "reviews"), { recursive: true });
const scorecardTarget = path.join(runDirectory, "scorecard.json");
const reviewTarget = path.join(published, ...reviewRelative.split("/"));
await fs.copyFile(scorecardSource, scorecardTarget);
await fs.copyFile(reviewSource, reviewTarget);
const receipt = async (file) => ({ byteLength: (await fs.stat(file)).size, sha256: await sha256File(file) });
const pointer = {
  schemaVersion: "slidewright-c10-public-evidence/v1",
  valid: true,
  scorecardHash: machine.scorecardHash,
  reviewHash: machine.reviewHash,
  run: runRelative,
  review: reviewRelative,
  files: {
    scorecard: await receipt(scorecardTarget),
    review: await receipt(reviewTarget),
  },
  scope: {
    artifactHashesPublished: true,
    artifactBodiesCommitted: false,
    regenerationCommand: "npm run template:matrix",
    reviewCommand: "npm run template:matrix:review -- --input <review-input.json>",
    verificationCommand: "npm run template:matrix:verify:published",
    limitation: "The public snapshot contains all artifact paths, byte lengths, SHA-256 receipts, machine decisions, and human review bindings; generated PPTX and PNG bodies remain ignored and are regenerated on a PowerPoint-capable host.",
  },
};
pointer.pointerHash = canonicalHash(pointer);
await fs.writeFile(path.join(published, "current.json"), `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
const verified = await verifyPublishedTemplateMatrixEvidence({ root, published });
process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
