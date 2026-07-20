import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildBlindedTargetUserRouting, evaluateProfessionalQualityEvidence, minimumPairwiseDhashDistance, sanitizeProfessionalQualityResponse } from "../scripts/verify-professional-quality-evidence.mjs";

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

test("target-user routing is deterministic, complete, and blind", () => {
  const candidateRouting = candidates.map(({ candidateCode }, index) => ({ candidateCode, deckCode: `P-${String(index % 4).padStart(10, "0")}`, slide: index + 1, fixtureId: "must-not-leak", sourceDeckSha256: "must-not-leak" }));
  const routing = buildBlindedTargetUserRouting(assignments, candidateRouting);
  assert.equal(routing.length, 5);
  for (const [index, sheet] of routing.entries()) {
    assert.equal(sheet.assignmentId, assignments[index].assignmentId);
    assert.deepEqual(sheet.designs.map((design) => design.candidateCode), assignments[index].candidateCodes);
    assert.equal(sheet.designs.length, 5);
    assert.doesNotMatch(JSON.stringify(sheet), /fixture|source|sha256|designId/u);
    assert.deepEqual(Object.keys(sheet.designs[0]), ["candidateCode", "deck", "slide"]);
  }
});

test("response sanitizer replaces participant pseudonyms and rejects private or agent fields", () => {
  const raw = expertResponse();
  raw.participant.id = "reviewer-alpha";
  const sanitized = sanitizeProfessionalQualityResponse(raw, { contract, candidates, assignments });
  assert.match(sanitized.participant.id, /^p-[0-9a-f]{16}$/u);
  assert.notEqual(sanitized.participant.id, raw.participant.id);
  assert.equal(raw.participant.id, "reviewer-alpha");
  const preformatted = expertResponse();
  preformatted.participant.id = "p-0123456789abcdef";
  assert.notEqual(sanitizeProfessionalQualityResponse(preformatted, { contract, candidates, assignments }).participant.id, preformatted.participant.id);
  const privateResponse = expertResponse();
  privateResponse.participant.email = "forbidden@example.com";
  assert.throws(() => sanitizeProfessionalQualityResponse(privateResponse, { contract, candidates, assignments }), /forbidden fields/u);
  const agentResponse = expertResponse();
  agentResponse.participant.agentOrAi = true;
  assert.throws(() => sanitizeProfessionalQualityResponse(agentResponse, { contract, candidates, assignments }), /Agents, models, bots/u);
  const ambiguousDateResponse = expertResponse();
  ambiguousDateResponse.submittedAt = "07/19/2026 12:00";
  assert.throws(() => sanitizeProfessionalQualityResponse(ambiguousDateResponse, { contract, candidates, assignments }), /ISO date-time/u);
});

test("response importer writes only sanitized evidence and is idempotent", async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c13-import-"));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const packetRoot = path.join(temporary, "packet");
  const outDir = path.join(temporary, "evidence");
  const input = path.join(temporary, "raw-response.json");
  const contractPath = path.join(temporary, "contract.json");
  await fs.mkdir(packetRoot, { recursive: true });
  await fs.writeFile(path.join(packetRoot, "manifest.json"), `${JSON.stringify({ candidates })}\n`);
  await fs.writeFile(path.join(packetRoot, "target-user-assignments.json"), `${JSON.stringify({ assignments })}\n`);
  await fs.writeFile(contractPath, `${JSON.stringify(contract)}\n`);
  const response = expertResponse();
  response.participant.id = "raw-reviewer-alpha";
  await fs.writeFile(input, `${JSON.stringify(response)}\n`);
  const args = ["scripts/import-professional-quality-response.mjs", "--input", input, "--out-dir", outDir, "--packet-root", packetRoot, "--contract", contractPath];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = spawnSync(process.execPath, args, { cwd: path.resolve("."), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  const outputs = await fs.readdir(outDir);
  assert.equal(outputs.length, 1);
  const imported = JSON.parse(await fs.readFile(path.join(outDir, outputs[0]), "utf8"));
  assert.match(imported.participant.id, /^p-[0-9a-f]{16}$/u);
  assert.doesNotMatch(JSON.stringify(imported), /raw-reviewer-alpha/u);
});
