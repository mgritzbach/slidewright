#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateProfessionalQualityEvidence, minimumPairwiseDhashDistance, verifyProfessionalQualityScorecard } from "./verify-professional-quality-evidence.mjs";

const root = process.cwd();
const output = path.join(root, "outputs", "professional-quality");
const packet = path.join(output, "reviewer-packet");
const admin = path.join(output, "administrator-only");
const contractPath = path.join(root, "fixtures", "professional-quality", "c13-v1", "contract.json");
const templateMatrixRoot = path.join(root, "outputs", "template-matrix");
const imageTool = path.join(root, "scripts", "professional-quality", "image_fingerprint.py");
const responseEvidenceDir = path.join(root, "evidence", "c13", "v1", "responses");
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe");
let python = "python";
try { await fs.access(bundledPython); python = bundledPython; } catch { /* PATH fallback */ }

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(candidate) {
  return sha256(await fs.readFile(candidate));
}

function relative(candidate) {
  return path.relative(root, candidate).split(path.sep).join("/");
}

async function readJson(candidate) {
  return JSON.parse((await fs.readFile(candidate, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeJson(candidate, value) {
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

function hamming(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

function candidateSort(left, right) {
  return left.designId.localeCompare(right.designId);
}

async function artifact(candidate, kind) {
  return { path: relative(candidate), sha256: await sha256File(candidate), kind };
}

const contract = await readJson(contractPath);
const expectedParent = path.join(root, "outputs");
invariant(path.dirname(output) === expectedParent, `Unsafe C13 output path: ${output}`);
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(path.join(packet, "images"), { recursive: true });
await fs.mkdir(path.join(packet, "decks"), { recursive: true });
await fs.mkdir(admin, { recursive: true });

const current = await readJson(path.join(templateMatrixRoot, "current.json"));
const currentReview = await readJson(path.join(templateMatrixRoot, "current-review.json"));
invariant(current.scorecardHash === currentReview.scorecardHash, "Current C10 scorecard and review do not bind the same run.");
const c10Run = path.join(templateMatrixRoot, current.run);
const c10ScorecardPath = path.join(c10Run, "scorecard.json");
const c10Scorecard = await readJson(c10ScorecardPath);
invariant(c10Scorecard.machineValid === true && c10Scorecard.reviewArtifactsReady === true, "Current C10 run is not machine-valid and review-ready.");
invariant(c10Scorecard.scorecardHash === current.scorecardHash, "Current C10 pointer does not match its scorecard.");
const c10ReviewPath = path.join(templateMatrixRoot, currentReview.review);
const c10Review = await readJson(c10ReviewPath);
invariant(c10Review.valid === true && c10Review.scorecardHash === current.scorecardHash, "Current C10 full-size review is invalid or stale.");
invariant(c10Review.reviewer?.kind === "hash-bound-carry-forward" || c10Review.reviewer?.kind === "multi-agent-panel", "C10 review provenance is unexpected.");

const reviewByKey = new Map(c10Review.artifacts.filter((item) => item.deck === contract.corpus.candidateState).map((item) => [`${item.fixtureId}:${item.slide}`, item]));
const candidates = [];
for (const fixture of c10Scorecard.fixtures) {
  invariant(fixture.licensed === true && fixture.powerpointRepeatRoundtripValid === true && fixture.powerpointRepeatVisualAuditValid === true && fixture.slidesTestValid === true, `Fixture ${fixture.id} lacks licensed, two-cycle, visual, or boundary evidence.`);
  const fixtureRoot = path.join(c10Run, "fixtures", fixture.id);
  const sourcePptx = path.join(fixtureRoot, "source.pptx");
  const finalPptx = path.join(fixtureRoot, "powerpoint-roundtrip-repeat.pptx");
  const sourceDeckSha256 = await sha256File(sourcePptx);
  const finalDeckSha256 = await sha256File(finalPptx);
  for (let slide = 1; slide <= fixture.expected.slideCount; slide += 1) {
    const image = path.join(fixtureRoot, contract.corpus.candidateState, `slide-${slide}.png`);
    invariant(await exists(image), `Final reviewed render is missing: ${image}`);
    const review = reviewByKey.get(`${fixture.id}:${slide}`);
    invariant(review?.verdict === "pass" && Array.isArray(review.findings) && review.findings.length === 0, `Final render lacks a clean full-size C10 review: ${fixture.id} slide ${slide}`);
    const imageSha256 = await sha256File(image);
    invariant(imageSha256 === review.sha256, `C10 review hash mismatch: ${fixture.id} slide ${slide}`);
    const designId = sha256(Buffer.from(JSON.stringify({ fixtureId: fixture.id, sourceDeckSha256, slide })));
    candidates.push({
      fixtureId: fixture.id,
      slide,
      designId,
      image,
      sha256: imageSha256,
      sourceDeckSha256,
      finalDeckSha256,
      finalPptx,
      blindOrder: crypto.createHmac("sha256", contract.selectionSeed).update(designId).digest("hex"),
    });
  }
}
invariant(candidates.length >= contract.corpus.minimumIndependentDesigns, `C10 supplies only ${candidates.length} slide lineages.`);

const fingerprintInput = path.join(output, "fingerprint-input.json");
const fingerprintOutput = path.join(output, "fingerprints.json");
await writeJson(fingerprintInput, candidates.map((candidate) => candidate.image));
const fingerprintResult = spawnSync(python, [imageTool, "--list", fingerprintInput, "--out", fingerprintOutput, "--minimum-distance", String(contract.corpus.minimumPairwisePerceptualDistance), "--minimum-count", String(contract.corpus.minimumIndependentDesigns)], { cwd: root, stdio: "inherit", windowsHide: true });
if (fingerprintResult.error) throw fingerprintResult.error;
invariant(fingerprintResult.status === 0, `Image fingerprinting failed with ${fingerprintResult.status}.`);
const fingerprints = new Map((await readJson(fingerprintOutput)).map((record) => [path.resolve(record.path), record]));
for (const candidate of candidates) {
  const fingerprint = fingerprints.get(path.resolve(candidate.image));
  invariant(fingerprint?.sha256 === candidate.sha256, `Fingerprint hash mismatch: ${candidate.image}`);
  Object.assign(candidate, { dhash64: fingerprint.dhash64, width: fingerprint.width, height: fingerprint.height, selected: fingerprint.selected });
}

const fixtureIds = [...new Set(candidates.map((candidate) => candidate.fixtureId))].sort();
const selected = candidates.filter((candidate) => candidate.selected).sort((left, right) => left.blindOrder.localeCompare(right.blindOrder));
invariant(selected.length === contract.corpus.minimumIndependentDesigns, `Diversity selector returned ${selected.length} designs; expected ${contract.corpus.minimumIndependentDesigns}.`);
invariant(new Set(selected.map((candidate) => candidate.fixtureId)).size >= contract.corpus.minimumLicensedSourceFamilies, "Selected designs do not cover every required licensed source family.");
const minimumDistance = minimumPairwiseDhashDistance(selected);
invariant(minimumDistance >= contract.corpus.minimumPairwisePerceptualDistance, `Selected corpus minimum perceptual distance ${minimumDistance} is below ${contract.corpus.minimumPairwisePerceptualDistance}.`);

const deckCodes = new Map();
for (const candidate of selected) {
  candidate.candidateCode = `D-${crypto.createHmac("sha256", contract.selectionSeed).update(`candidate:${candidate.designId}`).digest("hex").slice(0, 10).toUpperCase()}`;
  if (!deckCodes.has(candidate.fixtureId)) deckCodes.set(candidate.fixtureId, `P-${crypto.createHmac("sha256", contract.selectionSeed).update(`deck:${candidate.fixtureId}`).digest("hex").slice(0, 10).toUpperCase()}`);
  candidate.deckCode = deckCodes.get(candidate.fixtureId);
  const destination = path.join(packet, "images", `${candidate.candidateCode}.png`);
  await fs.copyFile(candidate.image, destination);
  candidate.packetImage = destination;
}
for (const [fixtureId, deckCode] of deckCodes) {
  const candidate = selected.find((item) => item.fixtureId === fixtureId);
  await fs.copyFile(candidate.finalPptx, path.join(packet, "decks", `${deckCode}.pptx`));
}

const expertCandidates = selected.map((candidate) => ({ candidateCode: candidate.candidateCode, image: `images/${candidate.candidateCode}.png` }));
const orderedCodes = expertCandidates.map((candidate) => candidate.candidateCode);
const assignments = [0, 1, 2, 3, 4].map((index) => {
  const start = index * 5;
  const candidateCodes = orderedCodes.slice(start, start + 5);
  for (let fill = 0; candidateCodes.length < contract.targetUsers.designsPerUser; fill += 1) candidateCodes.push(orderedCodes[fill]);
  return { assignmentId: `target-user-${index + 1}`, candidateCodes };
});
invariant(new Set(assignments.flatMap((assignment) => assignment.candidateCodes)).size === selected.length, "Target-user assignments do not cover every selected design.");

const packetManifestPath = path.join(packet, "manifest.json");
const assignmentsPath = path.join(packet, "target-user-assignments.json");
const expertTemplatePath = path.join(packet, "expert-response-template.json");
const userTemplatePath = path.join(packet, "target-user-response-template.json");
const instructionsPath = path.join(packet, "INSTRUCTIONS.md");
await writeJson(packetManifestPath, { schemaVersion: "slidewright-c13-blind-packet/v1", blinded: true, assignmentId: "expert-all-designs", candidates: expertCandidates });
await writeJson(assignmentsPath, { schemaVersion: "slidewright-c13-assignments/v1", assignments });
await writeJson(expertTemplatePath, {
  schemaVersion: "slidewright-c13-response/v1",
  participant: { id: "expert-pseudonym", role: "blind-expert", human: true, independent: true, agentOrAi: false, implementationTeamMember: false, professionalPresentationExpert: true, monthlyProfessionalDeckUse: false },
  attestations: { candidateOriginsHidden: true, conditionLabelsHidden: true, adminKeyUnavailableBeforeSubmission: true, noDirectPersonalData: true, timedWithoutAssistance: false },
  assignmentId: "expert-all-designs",
  reviews: expertCandidates.map(({ candidateCode }) => ({ candidateCode, firstOpenAcceptable: null, scores: Object.fromEntries(contract.blindExpert.dimensions.map((dimension) => [dimension, null])) })),
  submittedAt: null,
});
await writeJson(userTemplatePath, {
  schemaVersion: "slidewright-c13-response/v1",
  participant: { id: "user-pseudonym", role: "target-user", human: true, independent: true, agentOrAi: false, implementationTeamMember: false, professionalPresentationExpert: false, monthlyProfessionalDeckUse: true },
  attestations: { candidateOriginsHidden: true, conditionLabelsHidden: true, adminKeyUnavailableBeforeSubmission: true, noDirectPersonalData: true, timedWithoutAssistance: true },
  assignmentId: "replace-with-assignment-id",
  reviews: [{ candidateCode: "replace-from-assignment", firstOpenAcceptable: null, cleanupSeconds: null, repairActions: null }],
  submittedAt: null,
});
await fs.writeFile(instructionsPath, `# Blind C13 review packet\n\nDo not request or inspect the administrator key before submitting your response.\n\n## Blind expert\n\nOpen every image at full size. For each code, record first-open acceptance and integer 1-5 scores for hierarchy, spacing, readability, consistency, and professional polish. Use \`expert-response-template.json\`. Do not infer or research the file origin.\n\n## Target users\n\nUse the assigned five codes in \`target-user-assignments.json\`. Open the opaque deck in \`decks/\` and navigate to the slide number supplied separately by the study administrator. Start timing at first open. Stop when you consider the slide presentation-ready. Record zero cleanup seconds and zero repair actions only if you accept it without edits. Use \`target-user-response-template.json\`.\n\nResponses must use pseudonymous participant ids and contain no names, email addresses, employers, or other personal data.\n`, "utf8");

const adminKeyPath = path.join(admin, "candidate-key.json");
await writeJson(adminKeyPath, {
  schemaVersion: "slidewright-c13-admin-key/v1",
  warning: "Never provide this file to reviewers before response submission.",
  candidates: selected.map((candidate) => ({
    candidateCode: candidate.candidateCode,
    fixtureId: candidate.fixtureId,
    slide: candidate.slide,
    deckCode: candidate.deckCode,
    designId: candidate.designId,
    finalRenderSha256: candidate.sha256,
    dhash64: candidate.dhash64,
    sourceDeckSha256: candidate.sourceDeckSha256,
    finalDeckSha256: candidate.finalDeckSha256,
  })),
});

let responseFiles = [];
try { responseFiles = (await fs.readdir(responseEvidenceDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(responseEvidenceDir, entry.name)).sort(); } catch { /* no external evidence yet */ }
const responses = [];
for (const responseFile of responseFiles) responses.push(await readJson(responseFile));
const evaluation = evaluateProfessionalQualityEvidence({ contract, candidates: expertCandidates, assignments, responses });
const missing = [];
if (evaluation.experts < contract.blindExpert.minimumIndependentHumanExperts) missing.push(`${contract.blindExpert.minimumIndependentHumanExperts - evaluation.experts} independent blind human expert response`);
if (evaluation.targetUsers < contract.targetUsers.minimumIndependentHumanUsers) missing.push(`${contract.targetUsers.minimumIndependentHumanUsers - evaluation.targetUsers} independent target-user responses`);
if (evaluation.metrics.distinctDesignsCoveredByUsers < contract.targetUsers.minimumDistinctDesignsCovered) missing.push(`${contract.targetUsers.minimumDistinctDesignsCovered - evaluation.metrics.distinctDesignsCoveredByUsers} target-user design coverage slots`);

const artifacts = [];
for (const candidate of selected) artifacts.push(await artifact(candidate.packetImage, "blind-candidate-image"));
for (const deckCode of deckCodes.values()) artifacts.push(await artifact(path.join(packet, "decks", `${deckCode}.pptx`), "blind-editable-deck"));
for (const candidate of [packetManifestPath, assignmentsPath, expertTemplatePath, userTemplatePath, instructionsPath, adminKeyPath, fingerprintOutput, c10ScorecardPath, c10ReviewPath]) artifacts.push(await artifact(candidate, "study-evidence"));
for (const responseFile of responseFiles) artifacts.push(await artifact(responseFile, "external-human-response"));
for (const candidate of [
  contractPath,
  imageTool,
  path.join(root, "scripts", "build-professional-quality-review-pack.mjs"),
  path.join(root, "scripts", "verify-professional-quality-evidence.mjs"),
  path.join(root, "tests", "professional-quality.test.mjs"),
  path.join(root, "docs", "C13_PROFESSIONAL_QUALITY.md"),
]) artifacts.push(await artifact(candidate, "implementation"));

const scorecard = {
  schemaVersion: "slidewright-c13-scorecard/v1",
  goalId: "C13",
  generatedAt: new Date().toISOString(),
  preparationValid: true,
  professionalQualityClaim: evaluation.c13Satisfied,
  c13Satisfied: evaluation.c13Satisfied,
  contract,
  c10Binding: {
    scorecardHash: current.scorecardHash,
    scorecardFileSha256: await sha256File(c10ScorecardPath),
    reviewHash: currentReview.reviewHash,
    reviewFileSha256: await sha256File(c10ReviewPath),
    internalReviewerKind: c10Review.reviewer.kind,
    countsTowardExternalEvidence: false,
  },
  corpus: {
    availableDesigns: candidates.length,
    selectedDesigns: selected.length,
    licensedSourceFamilies: fixtureIds.length,
    uniqueDesignIdentities: new Set(selected.map((candidate) => candidate.designId)).size,
    uniqueRenderHashes: new Set(selected.map((candidate) => candidate.sha256)).size,
    minimumPairwisePerceptualDistance: minimumDistance,
    candidateState: contract.corpus.candidateState,
  },
  internalTechnicalReview: {
    reviewedAtFullSize: true,
    selectedReviewed: selected.length,
    allSelectedPassed: selected.every((candidate) => reviewByKey.get(`${candidate.fixtureId}:${candidate.slide}`)?.verdict === "pass"),
    countsTowardExternalEvidence: false,
    reason: "The hash-bound C10 internal/agent review proves technical visual QA only; it is not a blind external expert or target-user study.",
  },
  reviewPacket: {
    blinded: true,
    adminKeyExcluded: !relative(adminKeyPath).startsWith(relative(packet)),
    candidateManifest: relative(packetManifestPath),
    assignments: relative(assignmentsPath),
    adminKey: relative(adminKeyPath),
    packetSha256: await sha256File(packetManifestPath),
    adminKeySha256: await sha256File(adminKeyPath),
  },
  externalEvidence: {
    experts: evaluation.experts,
    targetUsers: evaluation.targetUsers,
    responseFiles: responseFiles.map(relative),
    complete: evaluation.externalEvidenceComplete,
    missing,
  },
  evaluation,
  artifacts,
};
const scorecardPath = path.join(output, "scorecard.json");
await writeJson(scorecardPath, scorecard);
await verifyProfessionalQualityScorecard(scorecard);
await writeJson(path.join(output, "current.json"), { schemaVersion: "slidewright-c13-current/v1", scorecard: relative(scorecardPath), scorecardSha256: await sha256File(scorecardPath) });
process.stdout.write(`C13 review preparation passed: ${selected.length}/${candidates.length} independent licensed slide designs selected across ${fixtureIds.length} source families; external evidence remains ${evaluation.experts} expert and ${evaluation.targetUsers}/5 target users.\n`);
