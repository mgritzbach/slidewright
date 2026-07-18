import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { evaluateProfessionalQualityEvidence, minimumPairwiseDhashDistance } from "../scripts/verify-professional-quality-evidence.mjs";

const contract = JSON.parse(await fs.readFile(path.resolve("fixtures/professional-quality/c13-v1/contract.json"), "utf8"));
const candidates = Array.from({ length: 24 }, (_, index) => ({ candidateCode: `D-${String(index + 1).padStart(3, "0")}` }));
const assignments = [0, 1, 2, 3, 4].map((index) => ({
  assignmentId: `target-user-${index + 1}`,
  candidateCodes: index < 4 ? candidates.slice(index * 5, index * 5 + 5).map((item) => item.candidateCode) : [...candidates.slice(20, 24).map((item) => item.candidateCode), candidates[0].candidateCode],
}));

function attestations(role) {
  return {
    candidateOriginsHidden: true,
    conditionLabelsHidden: true,
    adminKeyUnavailableBeforeSubmission: true,
    noDirectPersonalData: true,
    timedWithoutAssistance: role === "target-user",
  };
}

function participant(id, role) {
  return {
    id,
    role,
    human: true,
    independent: true,
    agentOrAi: false,
    implementationTeamMember: false,
    professionalPresentationExpert: role === "blind-expert",
    monthlyProfessionalDeckUse: role === "target-user",
  };
}

function expertResponse() {
  return {
    schemaVersion: "slidewright-c13-response/v1",
    participant: participant("expert-001", "blind-expert"),
    attestations: attestations("blind-expert"),
    assignmentId: "expert-all-designs",
    reviews: candidates.map(({ candidateCode }) => ({ candidateCode, firstOpenAcceptable: true, scores: Object.fromEntries(contract.blindExpert.dimensions.map((dimension) => [dimension, 4])) })),
    submittedAt: "2026-07-18T12:00:00Z",
  };
}

function userResponse(index, { slowFailure = false } = {}) {
  const assignment = assignments[index];
  return {
    schemaVersion: "slidewright-c13-response/v1",
    participant: participant(`target-user-${String(index + 1).padStart(3, "0")}`, "target-user"),
    attestations: attestations("target-user"),
    assignmentId: assignment.assignmentId,
    reviews: assignment.candidateCodes.map((candidateCode, reviewIndex) => {
      const failed = slowFailure && reviewIndex === 0;
      return { candidateCode, firstOpenAcceptable: !failed, cleanupSeconds: failed ? 1000 : 0, repairActions: failed ? 3 : 0 };
    }),
    submittedAt: "2026-07-18T12:00:00Z",
  };
}

test("C13 remains unsatisfied when external human evidence is absent", () => {
  const result = evaluateProfessionalQualityEvidence({ contract, candidates, assignments, responses: [] });
  assert.equal(result.c13Satisfied, false);
  assert.equal(result.experts, 0);
  assert.equal(result.targetUsers, 0);
  assert.equal(result.externalEvidenceComplete, false);
});

test("agents and implementation-team members never count as C13 humans", () => {
  const agentExpert = expertResponse();
  agentExpert.participant.id = "agent-reviewer-001";
  agentExpert.participant.agentOrAi = true;
  const teamUser = userResponse(0);
  teamUser.participant.implementationTeamMember = true;
  const result = evaluateProfessionalQualityEvidence({ contract, candidates, assignments, responses: [agentExpert, teamUser] });
  assert.equal(result.validResponses, 0);
  assert.equal(result.rejectedResponses, 2);
  assert.match(result.rejectionReasons.join(" "), /Agents, models, bots|Implementation-team/u);
  assert.equal(result.c13Satisfied, false);
});

test("one blind expert and five target users can satisfy every frozen threshold", () => {
  const responses = [expertResponse(), ...assignments.map((_, index) => userResponse(index))];
  const result = evaluateProfessionalQualityEvidence({ contract, candidates, assignments, responses });
  assert.equal(result.rejectedResponses, 0);
  assert.equal(result.experts, 1);
  assert.equal(result.targetUsers, 5);
  assert.equal(result.metrics.distinctDesignsCoveredByUsers, 24);
  assert.equal(result.expertThresholdsMet, true);
  assert.equal(result.userThresholdsMet, true);
  assert.equal(result.c13Satisfied, true);
});

test("complete samples still fail C13 when cleanup-time thresholds fail", () => {
  const responses = [expertResponse(), ...assignments.map((_, index) => userResponse(index, { slowFailure: true }))];
  const result = evaluateProfessionalQualityEvidence({ contract, candidates, assignments, responses });
  assert.equal(result.externalEvidenceComplete, true);
  assert.equal(result.metrics.userAcceptanceRate, 0.8);
  assert.equal(result.metrics.p90CleanupSeconds, 1000);
  assert.equal(result.userThresholdsMet, false);
  assert.equal(result.c13Satisfied, false);
});

test("perceptual diversity uses true pairwise 64-bit Hamming distance", () => {
  assert.equal(minimumPairwiseDhashDistance([{ dhash64: "0000000000000000" }, { dhash64: "000000000000000f" }, { dhash64: "ffffffffffffffff" }]), 4);
});
