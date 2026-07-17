#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifySemanticMutationEvidence, verifySemanticMutationReview } from "./lib/semantic-mutation-evidence.mjs";

const root = process.cwd();

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--input") options.input = argv[++index];
    else if (key === "--semantic-mutation-output") options.output = argv[++index];
    else throw new Error(`Unknown argument ${key}.`);
  }
  if (!options.input) throw new Error("Usage: node scripts/finalize-semantic-mutation-review.mjs --input <review-decisions.json>");
  return options;
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, ""));
}

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function canonicalHash(value) {
  const normalize = (item) => Array.isArray(item)
    ? item.map(normalize)
    : item && typeof item === "object"
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]))
      : item;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function contained(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function writeAtomically(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, contents, "utf8");
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not locate presentation tool ${name}.`);
}

const options = parseArgs(process.argv.slice(2));
const published = path.resolve(options.output ?? path.join(root, "outputs", "semantic-mutation"));
const inputPath = path.resolve(options.input);
const current = await readJson(path.join(published, "current.json"));
if (current.schemaVersion !== "slidewright-semantic-current/v1"
  || !/^[a-f0-9]{64}$/u.test(current.scorecardHash ?? "")
  || current.run !== `runs/${current.scorecardHash}`) {
  throw new Error("Semantic-mutation current pointer is invalid.");
}
const runDirectory = path.resolve(published, current.run);
if (!contained(published, runDirectory)) throw new Error("Semantic-mutation current pointer escaped its output root.");
const scorecardPath = path.join(runDirectory, "scorecard.json");
const scorecard = await readJson(scorecardPath);
const scorecardForHash = { ...scorecard };
delete scorecardForHash.scorecardHash;
if (scorecard.schemaVersion !== "slidewright-semantic-mutation-scorecard/v2"
  || scorecard.valid !== true
  || scorecard.reviewArtifactsReady !== true
  || scorecard.scorecardHash !== current.scorecardHash
  || canonicalHash(scorecardForHash) !== current.scorecardHash) {
  throw new Error("Semantic-mutation scorecard is not a valid hash-authenticated review source.");
}
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }
const machineVerification = await verifySemanticMutationEvidence({ root, runDirectory, python, slidesTest: await findPresentationTool("slides_test.py"), requireCurrentGit: false, requireSourceCurrent: false });

const input = await readJson(inputPath);
if (input.schemaVersion !== "slidewright-semantic-mutation-review-input/v1"
  || input.scorecardHash !== current.scorecardHash
  || !input.reviewer?.kind
  || !input.reviewer?.id
  || !Array.isArray(input.slides)) {
  throw new Error("Review input is missing its schema, scorecard binding, reviewer identity, or slide decisions.");
}

const expected = [];
for (const deck of scorecard.renderEvidence ?? []) {
  for (const render of deck.renders ?? []) {
    const png = path.join(runDirectory, "renders", deck.id, render.file);
    const reviewImage = path.join(runDirectory, "renders", deck.id, render.reviewFile);
    if (!contained(runDirectory, png) || !contained(runDirectory, reviewImage)) throw new Error("Review artifact escaped the immutable run directory.");
    const [pngHash, reviewHash] = await Promise.all([sha256(png), sha256(reviewImage)]);
    if (pngHash !== render.sha256 || reviewHash !== render.reviewSha256) throw new Error(`Review artifact bytes drifted for ${deck.id} slide ${render.slide}.`);
    expected.push({
      deckId: deck.id,
      slide: render.slide,
      pngSha256: pngHash,
      reviewSha256: reviewHash,
      width: render.width,
      height: render.height,
    });
  }
}
if (expected.length !== 24) throw new Error(`C18 review requires exactly 24 full-size slides; found ${expected.length}.`);
const decisions = new Map();
for (const decision of input.slides) {
  const key = `${decision.deckId}#${decision.slide}`;
  if (decisions.has(key)) throw new Error(`Duplicate review decision for ${key}.`);
  if (!['pass', 'fail'].includes(decision.verdict) || !Array.isArray(decision.findings)) throw new Error(`Invalid review decision for ${key}.`);
  decisions.set(key, decision);
}
if (decisions.size !== expected.length) throw new Error(`Review input must contain exactly ${expected.length} decisions.`);

const slides = expected.map((artifact) => {
  const decision = decisions.get(`${artifact.deckId}#${artifact.slide}`);
  if (!decision) throw new Error(`Missing review decision for ${artifact.deckId} slide ${artifact.slide}.`);
  return { ...artifact, verdict: decision.verdict, findings: decision.findings };
});
const review = {
  schemaVersion: "slidewright-semantic-mutation-review/v1",
  valid: slides.every((item) => item.verdict === "pass" && item.findings.length === 0),
  scorecardHash: current.scorecardHash,
  scorecardSha256: await sha256(scorecardPath),
  machineVerification,
  reviewer: input.reviewer,
  inspectionMethod: "Every persisted 1600x900 review image inspected individually at full size using exactly one image per visual-tool call; montage and batched-image review do not qualify.",
  slides,
};
review.reviewHash = canonicalHash(review);
const reviewDirectory = path.join(published, "reviews", current.scorecardHash);
const reviewPath = path.join(reviewDirectory, `${review.reviewHash}.json`);
const contents = `${JSON.stringify(review, null, 2)}\n`;
try {
  const existing = await fs.readFile(reviewPath, "utf8");
  if (existing !== contents) throw new Error("Existing content-addressed review differs from the new review bytes.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeAtomically(reviewPath, contents);
}
if (review.valid) {
  const pointerPath = path.join(published, "current-review.json");
  let priorPointer = null;
  try { priorPointer = await fs.readFile(pointerPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const currentAtPublish = await readJson(path.join(published, "current.json"));
  if (canonicalHash(currentAtPublish) !== canonicalHash(current)) throw new Error("Semantic-mutation current pointer changed before review publication.");
  await verifySemanticMutationEvidence({ root, runDirectory, python, slidesTest: await findPresentationTool("slides_test.py"), requireCurrentGit: false, requireSourceCurrent: false });
  await writeAtomically(pointerPath, `${JSON.stringify({
    schemaVersion: "slidewright-semantic-mutation-current-review/v1",
    scorecardHash: current.scorecardHash,
    reviewHash: review.reviewHash,
    review: `reviews/${current.scorecardHash}/${review.reviewHash}.json`,
  }, null, 2)}\n`);
  try {
    const currentAfterPublish = await readJson(path.join(published, "current.json"));
    if (canonicalHash(currentAfterPublish) !== canonicalHash(current)) throw new Error("Semantic-mutation current pointer changed during review publication.");
    await verifySemanticMutationReview({ root, published, python, slidesTest: await findPresentationTool("slides_test.py") });
  } catch (error) {
    if (priorPointer === null) await fs.rm(pointerPath, { force: true });
    else await writeAtomically(pointerPath, priorPointer);
    throw error;
  }
}
process.stdout.write(`${review.valid ? "C18 review passed" : "C18 review recorded failures"}: ${reviewPath}\n`);
if (!review.valid) process.exitCode = 1;
