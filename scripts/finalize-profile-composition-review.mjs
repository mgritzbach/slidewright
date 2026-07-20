#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "outputs", "profile-composition");
const inputIndex = process.argv.indexOf("--input");
if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error("Usage: node scripts/finalize-profile-composition-review.mjs --input <completed-review.json>");
const input = path.resolve(root, process.argv[inputIndex + 1]);

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const scorecardPath = path.join(output, "scorecard.json");
const scorecard = await readJson(scorecardPath);
const review = await readJson(input);
invariant(scorecard.schemaVersion === "slidewright-profile-composition-scorecard/v1" && scorecard.automatedValid === true,
  "The automated g22-v2 scorecard must be valid before review finalization.");
invariant(review.schemaVersion === "slidewright-profile-composition-review/v1", "Unexpected review schema.");
invariant(review.scorecardSha256 === await sha256(scorecardPath), "Review is not bound to the current pre-review scorecard.");
invariant(review.reviewMethod === "full-size-individual", "Review method must be full-size-individual.");
invariant(["human", "primary-agent"].includes(review.reviewerKind), "Reviewer kind must be human or primary-agent.");
invariant(/^[a-f0-9]{64}$/u.test(review.reviewerIdSha256 ?? ""), "Review requires a pseudonymous reviewer SHA-256.");
invariant(Number.isFinite(Date.parse(review.reviewedAt ?? "")), "Review requires a valid reviewedAt timestamp.");

const expected = [];
for (const deck of ["composed", "powerpoint-roundtrip"]) {
  for (let slide = 1; slide <= 4; slide += 1) expected.push({ deck, slide, path: `${deck}/slide-${slide}.png` });
}
invariant(Array.isArray(review.slides) && review.slides.length === expected.length, "Review must cover exactly eight full-size images.");
for (const [index, item] of review.slides.entries()) {
  const expectedItem = expected[index];
  invariant(item.deck === expectedItem.deck && item.slide === expectedItem.slide && item.path === expectedItem.path,
    `Review image ${index + 1} is out of order or does not match the required inventory.`);
  invariant(item.decision === "pass", `${item.path} does not have an explicit pass decision.`);
  const actualHash = await sha256(path.join(output, ...item.path.split("/")));
  invariant(item.imageSha256 === actualHash, `${item.path} hash does not match the reviewed image.`);
}

const receiptPath = path.join(output, "full-size-review.json");
await writeJson(receiptPath, review);
scorecard.goalComplete = true;
scorecard.goalCompletionBlocker = null;
scorecard.fullSizeReview = {
  schemaVersion: review.schemaVersion,
  reviewedAt: review.reviewedAt,
  reviewerIdSha256: review.reviewerIdSha256,
  reviewerKind: review.reviewerKind,
  slideCount: review.slides.length,
  receipt: "full-size-review.json",
  receiptSha256: await sha256(receiptPath),
  preReviewScorecardSha256: review.scorecardSha256,
};
await writeJson(scorecardPath, scorecard);
process.stdout.write("g22-v2 full-size review finalized; scorecard goalComplete=true.\n");
