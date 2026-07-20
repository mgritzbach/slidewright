#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReviewerFormConfig } from "./lib/c13-reviewer-workflow.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultScorecard = path.join(root, "outputs", "professional-quality", "scorecard.json");
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function onlyKeys(object, allowed, label) {
  invariant(object && typeof object === "object" && !Array.isArray(object), `${label} must be an object.`);
  const extras = Object.keys(object).filter((key) => !allowed.includes(key));
  invariant(extras.length === 0, `${label} contains forbidden fields: ${extras.join(", ")}`);
}

function quantileNearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hamming64(left, right) {
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (value) { count += Number(value & 1n); value >>= 1n; }
  return count;
}

function validateParticipant(response) {
  onlyKeys(response, ["schemaVersion", "participant", "attestations", "assignmentId", "reviews", "submittedAt"], "response");
  invariant(response.schemaVersion === "slidewright-c13-response/v1", "Response schemaVersion is invalid.");
  onlyKeys(response.participant, ["id", "role", "human", "independent", "agentOrAi", "implementationTeamMember", "professionalPresentationExpert", "monthlyProfessionalDeckUse"], "participant");
  const participant = response.participant;
  invariant(/^[a-z0-9][a-z0-9_-]{5,63}$/u.test(participant.id), "Participant id must be a pseudonymous slug without direct personal data.");
  invariant(!participant.id.includes("@"), "Participant id must not contain an email address.");
  invariant(participant.human === true && participant.independent === true, "Only independent human participants qualify.");
  invariant(participant.agentOrAi === false, "Agents, models, bots, and AI reviewers never qualify for C13.");
  invariant(participant.implementationTeamMember === false, "Implementation-team members never qualify for C13.");
  invariant(["blind-expert", "target-user"].includes(participant.role), "Participant role must be blind-expert or target-user.");
  if (participant.role === "blind-expert") invariant(participant.professionalPresentationExpert === true, "Blind expert lacks professional-presentation expertise attestation.");
  if (participant.role === "target-user") invariant(participant.monthlyProfessionalDeckUse === true, "Target user lacks monthly professional deck-use attestation.");
  onlyKeys(response.attestations, ["candidateOriginsHidden", "conditionLabelsHidden", "adminKeyUnavailableBeforeSubmission", "noDirectPersonalData", "timedWithoutAssistance"], "attestations");
  invariant(response.attestations.noDirectPersonalData === true, "Response lacks the privacy attestation.");
  invariant(Array.isArray(response.reviews), "Response reviews must be an array.");
  invariant(typeof response.submittedAt === "string" && ISO_DATE_TIME.test(response.submittedAt) && Number.isFinite(Date.parse(response.submittedAt)), "submittedAt must be a valid ISO date-time string.");
  return participant;
}

function validateExpertResponse(response, candidateCodes, contract) {
  const participant = validateParticipant(response);
  invariant(participant.role === "blind-expert", "Expert response has the wrong role.");
  for (const key of contract.blindExpert.requiredBlindnessAttestations) invariant(response.attestations[key] === true, `Expert blindness attestation is missing: ${key}`);
  invariant(response.assignmentId === "expert-all-designs", "Expert response has the wrong assignmentId.");
  invariant(response.reviews.length >= contract.blindExpert.minimumDesignsPerExpert, "Expert reviewed too few designs.");
  const reviewedCodes = new Set();
  const dimensions = contract.blindExpert.dimensions;
  for (const review of response.reviews) {
    onlyKeys(review, ["candidateCode", "firstOpenAcceptable", "scores"], "expert review");
    invariant(candidateCodes.has(review.candidateCode), `Expert reviewed an unknown candidate: ${review.candidateCode}`);
    invariant(!reviewedCodes.has(review.candidateCode), `Expert reviewed a candidate twice: ${review.candidateCode}`);
    reviewedCodes.add(review.candidateCode);
    invariant(typeof review.firstOpenAcceptable === "boolean", "Expert firstOpenAcceptable must be boolean.");
    onlyKeys(review.scores, dimensions, "expert scores");
    for (const dimension of dimensions) invariant(Number.isInteger(review.scores[dimension]) && review.scores[dimension] >= 1 && review.scores[dimension] <= 5, `Expert ${dimension} score must be an integer from 1 to 5.`);
  }
  invariant([...candidateCodes].every((code) => reviewedCodes.has(code)), "Expert response does not cover every blinded candidate.");
}

function validateTargetResponse(response, assignment, candidateCodes) {
  const participant = validateParticipant(response);
  invariant(participant.role === "target-user", "Target-user response has the wrong role.");
  invariant(response.attestations.timedWithoutAssistance === true, "Target-user timing was not independently measured.");
  invariant(response.assignmentId === assignment.assignmentId, "Target-user assignmentId does not match the study plan.");
  invariant(response.reviews.length === assignment.candidateCodes.length, "Target user did not review the exact assigned design count.");
  const expected = new Set(assignment.candidateCodes);
  const actual = new Set();
  for (const review of response.reviews) {
    onlyKeys(review, ["candidateCode", "firstOpenAcceptable", "cleanupSeconds", "repairActions"], "target-user review");
    invariant(candidateCodes.has(review.candidateCode) && expected.has(review.candidateCode), `Target user reviewed an unassigned candidate: ${review.candidateCode}`);
    invariant(!actual.has(review.candidateCode), `Target user reviewed a candidate twice: ${review.candidateCode}`);
    actual.add(review.candidateCode);
    invariant(typeof review.firstOpenAcceptable === "boolean", "Target-user firstOpenAcceptable must be boolean.");
    invariant(Number.isInteger(review.cleanupSeconds) && review.cleanupSeconds >= 0 && review.cleanupSeconds <= 3600, "cleanupSeconds must be an integer from 0 to 3600.");
    invariant(Number.isInteger(review.repairActions) && review.repairActions >= 0 && review.repairActions <= 50, "repairActions must be an integer from 0 to 50.");
    invariant(review.firstOpenAcceptable === (review.cleanupSeconds === 0 && review.repairActions === 0), "First-open acceptance must correspond to zero cleanup time and zero repair actions.");
  }
}

export function validateProfessionalQualityResponse(response, { contract, candidates, assignments }) {
  const candidateCodes = new Set(candidates.map((candidate) => candidate.candidateCode));
  const participant = validateParticipant(response);
  if (participant.role === "blind-expert") validateExpertResponse(response, candidateCodes, contract);
  else {
    const assignment = assignments.find((item) => item.assignmentId === response.assignmentId);
    invariant(assignment, `Unknown target-user assignment: ${response.assignmentId}`);
    validateTargetResponse(response, assignment, candidateCodes);
  }
  return true;
}

export function sanitizeProfessionalQualityResponse(response, { contract, candidates, assignments }) {
  validateProfessionalQualityResponse(response, { contract, candidates, assignments });
  const sanitized = structuredClone(response);
  sanitized.participant.id = `p-${crypto.createHmac("sha256", contract.selectionSeed).update(`${sanitized.participant.role}:${sanitized.participant.id}`).digest("hex").slice(0, 16)}`;
  validateProfessionalQualityResponse(sanitized, { contract, candidates, assignments });
  return sanitized;
}

export function buildBlindedTargetUserRouting(assignments, candidateRouting) {
  const routeByCode = new Map(candidateRouting.map((route) => [route.candidateCode, route]));
  return assignments.map((assignment) => ({
    schemaVersion: "slidewright-c13-target-user-routing/v1",
    assignmentId: assignment.assignmentId,
    blinded: true,
    designs: assignment.candidateCodes.map((candidateCode) => {
      const route = routeByCode.get(candidateCode);
      invariant(route, `No route exists for assigned candidate ${candidateCode}.`);
      return { candidateCode, deck: `decks/${route.deckCode}.pptx`, slide: route.slide };
    }),
    responseTemplate: "target-user-response-template.json",
    rubric: "RUBRIC.md",
  }));
}

export function evaluateProfessionalQualityEvidence({ contract, candidates, assignments, responses }) {
  const errors = [];
  const candidateCodes = new Set(candidates.map((candidate) => candidate.candidateCode));
  const responseIds = new Set();
  const experts = [];
  const users = [];
  for (const response of responses) {
    try {
      const participant = validateParticipant(response);
      invariant(!responseIds.has(participant.id), `Duplicate participant id: ${participant.id}`);
      responseIds.add(participant.id);
      if (participant.role === "blind-expert") {
        validateExpertResponse(response, candidateCodes, contract);
        experts.push(response);
      } else {
        const assignment = assignments.find((item) => item.assignmentId === response.assignmentId);
        invariant(assignment, `Unknown target-user assignment: ${response.assignmentId}`);
        validateTargetResponse(response, assignment, candidateCodes);
        users.push(response);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const expertReviews = experts.flatMap((response) => response.reviews);
  const expertAcceptanceRate = expertReviews.length ? expertReviews.filter((review) => review.firstOpenAcceptable).length / expertReviews.length : null;
  const expertDimensionValues = expertReviews.flatMap((review) => contract.blindExpert.dimensions.map((dimension) => review.scores[dimension]));
  const expertMeanDimensionScore = mean(expertDimensionValues);
  const expertMinimumDimensionScore = expertDimensionValues.length ? Math.min(...expertDimensionValues) : null;

  const userReviews = users.flatMap((response) => response.reviews);
  const userAcceptanceRate = userReviews.length ? userReviews.filter((review) => review.firstOpenAcceptable).length / userReviews.length : null;
  const perUserAcceptanceRates = users.map((response) => ({ participantId: response.participant.id, rate: response.reviews.filter((review) => review.firstOpenAcceptable).length / response.reviews.length }));
  const cleanup = userReviews.map((review) => review.cleanupSeconds);
  const repairActions = userReviews.map((review) => review.repairActions);
  const coveredDesigns = new Set(userReviews.map((review) => review.candidateCode));

  const expertThresholdsMet = experts.length >= contract.blindExpert.minimumIndependentHumanExperts
    && expertAcceptanceRate >= contract.blindExpert.minimumFirstOpenAcceptanceRate
    && expertMeanDimensionScore >= contract.blindExpert.minimumMeanDimensionScore
    && expertMinimumDimensionScore >= contract.blindExpert.minimumIndividualDimensionScore;
  const userThresholdsMet = users.length >= contract.targetUsers.minimumIndependentHumanUsers
    && coveredDesigns.size >= contract.targetUsers.minimumDistinctDesignsCovered
    && userAcceptanceRate >= contract.targetUsers.minimumOverallFirstOpenAcceptanceRate
    && perUserAcceptanceRates.every((item) => item.rate >= contract.targetUsers.minimumPerUserFirstOpenAcceptanceRate)
    && quantileNearestRank(cleanup, 0.5) <= contract.targetUsers.maximumMedianCleanupSeconds
    && quantileNearestRank(cleanup, 0.9) <= contract.targetUsers.maximumP90CleanupSeconds
    && quantileNearestRank(repairActions, 0.5) <= contract.targetUsers.maximumMedianRepairActions;
  const externalEvidenceComplete = experts.length >= contract.blindExpert.minimumIndependentHumanExperts
    && users.length >= contract.targetUsers.minimumIndependentHumanUsers
    && coveredDesigns.size >= contract.targetUsers.minimumDistinctDesignsCovered;

  return {
    validResponses: experts.length + users.length,
    rejectedResponses: errors.length,
    rejectionReasons: errors,
    experts: experts.length,
    targetUsers: users.length,
    externalEvidenceComplete,
    expertThresholdsMet,
    userThresholdsMet,
    c13Satisfied: errors.length === 0 && externalEvidenceComplete && expertThresholdsMet && userThresholdsMet,
    metrics: {
      expertDesignReviews: expertReviews.length,
      expertAcceptanceRate,
      expertMeanDimensionScore,
      expertMinimumDimensionScore,
      userDesignReviews: userReviews.length,
      userAcceptanceRate,
      perUserAcceptanceRates,
      distinctDesignsCoveredByUsers: coveredDesigns.size,
      medianCleanupSeconds: quantileNearestRank(cleanup, 0.5),
      p90CleanupSeconds: quantileNearestRank(cleanup, 0.9),
      medianRepairActions: quantileNearestRank(repairActions, 0.5),
    },
  };
}

export async function verifyProfessionalQualityScorecard(scorecard, { repositoryRoot = root, requireComplete = false } = {}) {
  invariant(scorecard?.schemaVersion === "slidewright-c13-scorecard/v1", "C13 scorecard schemaVersion is invalid.");
  invariant(scorecard.goalId === "C13", "C13 scorecard goalId is invalid.");
  invariant(scorecard.preparationValid === true, "C13 review preparation is not valid.");
  invariant(scorecard.corpus.availableDesigns >= scorecard.contract.corpus.minimumIndependentDesigns && scorecard.corpus.selectedDesigns >= scorecard.contract.corpus.minimumIndependentDesigns, "C13 corpus has fewer than the frozen minimum independent designs.");
  invariant(scorecard.corpus.licensedSourceFamilies >= 4, "C13 corpus has fewer than four licensed source families.");
  invariant(scorecard.corpus.uniqueDesignIdentities === scorecard.corpus.selectedDesigns, "C13 design identities are not unique.");
  invariant(scorecard.corpus.uniqueRenderHashes === scorecard.corpus.selectedDesigns, "C13 selected renders are not byte-unique.");
  invariant(scorecard.corpus.minimumPairwisePerceptualDistance >= scorecard.contract.corpus.minimumPairwisePerceptualDistance, "C13 visual corpus is insufficiently diverse under the frozen perceptual threshold.");
  invariant(scorecard.internalTechnicalReview?.allSelectedPassed === true, "Internal full-size review did not pass every selected design.");
  invariant(scorecard.internalTechnicalReview.countsTowardExternalEvidence === false, "Internal or agent review was incorrectly counted as external C13 evidence.");
  invariant(scorecard.externalEvidence.experts === scorecard.evaluation.experts, "External expert count mismatch.");
  invariant(scorecard.externalEvidence.targetUsers === scorecard.evaluation.targetUsers, "External target-user count mismatch.");
  invariant(scorecard.c13Satisfied === scorecard.evaluation.c13Satisfied, "C13 status disagrees with the evaluated human evidence.");
  invariant(scorecard.professionalQualityClaim === scorecard.c13Satisfied, "Professional-quality claim must remain false until C13 is satisfied.");
  invariant(Array.isArray(scorecard.artifacts) && scorecard.artifacts.length >= 30, "C13 scorecard binds too few artifacts.");
  for (const artifact of scorecard.artifacts) {
    invariant(typeof artifact.path === "string" && !path.isAbsolute(artifact.path), `Artifact path must be repository-relative: ${artifact.path}`);
    const absolute = path.resolve(repositoryRoot, artifact.path);
    invariant(absolute.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`), `Artifact escapes repository root: ${artifact.path}`);
    invariant(sha256(await fs.readFile(absolute)) === artifact.sha256, `Artifact hash mismatch: ${artifact.path}`);
  }
  invariant(scorecard.reviewPacket.blinded === true && scorecard.reviewPacket.adminKeyExcluded === true, "Reviewer packet is not proven blind.");
  const rubric = await fs.readFile(path.resolve(repositoryRoot, scorecard.reviewPacket.rubric), "utf8");
  for (const anchor of ["1 - Critical failure", "2 - Major repair", "3 - Usable with cleanup", "4 - Professional", "5 - Exceptional"]) invariant(rubric.includes(anchor), `C13 rubric lacks anchor: ${anchor}.`);
  invariant(rubric.includes("presentation-ready without any edit"), "C13 rubric does not define first-open acceptance strictly.");
  invariant(Array.isArray(scorecard.reviewPacket.routingSheets) && scorecard.reviewPacket.routingSheets.length === scorecard.contract.targetUsers.minimumIndependentHumanUsers, "C13 packet lacks one blinded routing sheet per target user.");
  const assignmentDocument = JSON.parse(await fs.readFile(path.resolve(repositoryRoot, scorecard.reviewPacket.assignments), "utf8"));
  for (const routingRecord of scorecard.reviewPacket.routingSheets) {
    invariant(routingRecord.designCount === scorecard.contract.targetUsers.designsPerUser && routingRecord.sourceFieldsExcluded === true, `Routing sheet ${routingRecord.assignmentId} is incomplete or leaks source fields.`);
    const routing = JSON.parse(await fs.readFile(path.resolve(repositoryRoot, routingRecord.path), "utf8"));
    onlyKeys(routing, ["schemaVersion", "assignmentId", "blinded", "designs", "responseTemplate", "rubric"], "routing sheet");
    invariant(routing.schemaVersion === "slidewright-c13-target-user-routing/v1" && routing.blinded === true && routing.assignmentId === routingRecord.assignmentId, `Routing sheet ${routingRecord.assignmentId} identity is invalid.`);
    const assignment = assignmentDocument.assignments.find((item) => item.assignmentId === routing.assignmentId);
    invariant(assignment && JSON.stringify(routing.designs.map((design) => design.candidateCode)) === JSON.stringify(assignment.candidateCodes), `Routing sheet ${routing.assignmentId} does not match its frozen assignment.`);
    for (const design of routing.designs) {
      onlyKeys(design, ["candidateCode", "deck", "slide"], "blinded route");
      invariant(/^D-[0-9A-F]{10}$/u.test(design.candidateCode), `Routing sheet ${routing.assignmentId} has an invalid candidate code.`);
      invariant(/^decks\/P-[0-9A-F]{10}\.pptx$/u.test(design.deck), `Routing sheet ${routing.assignmentId} has a non-opaque deck path.`);
      invariant(Number.isInteger(design.slide) && design.slide >= 1, `Routing sheet ${routing.assignmentId} has an invalid slide number.`);
    }
  }
  const reviewerForms = scorecard.reviewPacket.reviewerForms;
  invariant(Array.isArray(reviewerForms) && reviewerForms.length === 1 + scorecard.contract.targetUsers.minimumIndependentHumanUsers, "C13 packet lacks one offline form for the expert and each target user.");
  invariant(reviewerForms.filter((form) => form.role === "blind-expert").length === 1, "C13 packet must contain exactly one blind-expert form.");
  invariant(reviewerForms.filter((form) => form.role === "target-user").length === scorecard.contract.targetUsers.minimumIndependentHumanUsers, "C13 packet lacks a form for every target-user assignment.");
  const manifestPath = path.resolve(repositoryRoot, scorecard.reviewPacket.candidateManifest);
  const packetRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  for (const form of reviewerForms) {
    invariant(form.offline === true && form.sourceFieldsExcluded === true, `C13 reviewer form ${form.assignmentId} is not declared offline and blind.`);
    const formPath = path.resolve(repositoryRoot, form.path);
    invariant(formPath.startsWith(`${packetRoot}${path.sep}`), `C13 reviewer form ${form.assignmentId} escapes the blinded packet.`);
    const html = await fs.readFile(formPath, "utf8");
    invariant(sha256(Buffer.from(html)) === form.sha256, `C13 reviewer form ${form.assignmentId} hash mismatch.`);
    invariant(html.includes("connect-src 'none'"), `C13 reviewer form ${form.assignmentId} does not block network requests.`);
    invariant(!/https?:\/\//u.test(html), `C13 reviewer form ${form.assignmentId} contains an external URL.`);
    invariant(!/<textarea\b/iu.test(html), `C13 reviewer form ${form.assignmentId} permits unstructured personal data.`);
    invariant(!/(fixtureId|sourceDeckSha256|finalDeckSha256|designId|dhash64)/u.test(html), `C13 reviewer form ${form.assignmentId} leaks administrator-only source fields.`);
    const embedded = html.match(/<script type="application\/json" id="review-config">([^<]+)<\/script>/u);
    invariant(embedded, `C13 reviewer form ${form.assignmentId} lacks its embedded blinded configuration.`);
    const config = JSON.parse(embedded[1]);
    validateReviewerFormConfig(config);
    invariant(config.role === form.role && config.assignmentId === form.assignmentId && config.reviews.length === form.designCount, `C13 reviewer form ${form.assignmentId} disagrees with its scorecard record.`);
    if (form.role === "blind-expert") {
      invariant(form.designCount >= scorecard.contract.blindExpert.minimumDesignsPerExpert, "C13 expert form covers too few designs.");
      invariant(JSON.stringify(config.reviews.map((review) => review.candidateCode)) === JSON.stringify(manifest.candidates.map((candidate) => candidate.candidateCode)), "C13 expert form does not cover the frozen candidate manifest in order.");
    } else {
      const assignment = assignmentDocument.assignments.find((item) => item.assignmentId === form.assignmentId);
      invariant(assignment && JSON.stringify(config.reviews.map((review) => review.candidateCode)) === JSON.stringify(assignment.candidateCodes), `C13 target-user form ${form.assignmentId} does not match its frozen assignment.`);
    }
  }
  if (requireComplete) invariant(scorecard.c13Satisfied === true, `C13 remains incomplete: ${scorecard.externalEvidence.missing.join("; ")}`);
  return true;
}

export function minimumPairwiseDhashDistance(candidates) {
  let minimum = Number.POSITIVE_INFINITY;
  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) minimum = Math.min(minimum, hamming64(candidates[left].dhash64, candidates[right].dhash64));
  }
  return Number.isFinite(minimum) ? minimum : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const requireComplete = args.includes("--require-complete");
  const positional = args.filter((arg) => arg !== "--require-complete");
  const scorecardPath = path.resolve(positional[0] ?? defaultScorecard);
  const scorecard = JSON.parse(await fs.readFile(scorecardPath, "utf8"));
  await verifyProfessionalQualityScorecard(scorecard, { requireComplete });
  if (scorecard.c13Satisfied) process.stdout.write(`C13 professional-quality evidence complete: ${scorecardPath}\n`);
  else process.stdout.write(`C13 review preparation verified; external evidence remains incomplete: ${scorecard.externalEvidence.missing.join("; ")}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
