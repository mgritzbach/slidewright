import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpertReviewerFormConfig,
  buildTargetUserReviewerFormConfig,
  renderReviewerForm,
  validateReviewerFormConfig,
} from "../scripts/lib/c13-reviewer-workflow.mjs";

function candidateCode(index) {
  return `D-${index.toString(16).toUpperCase().padStart(10, "0")}`;
}

function embeddedConfig(html) {
  const match = html.match(/<script type="application\/json" id="review-config">([^<]+)<\/script>/u);
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("offline expert form covers the frozen blind candidates without source leakage", () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    candidateCode: candidateCode(index + 1),
    fixtureId: `secret-fixture-${index}`,
    sourceDeckSha256: "must-not-leak",
  }));
  const dimensions = ["hierarchy", "spacing", "readability", "consistency", "professionalPolish"];
  const config = buildExpertReviewerFormConfig({ candidates, dimensions });
  const html = renderReviewerForm(config);
  assert.equal(validateReviewerFormConfig(config), true);
  assert.deepEqual(embeddedConfig(html), config);
  assert.deepEqual(config.reviews.map((review) => review.candidateCode), candidates.map((candidate) => candidate.candidateCode));
  assert.match(html, /connect-src 'none'/u);
  assert.match(html, /collects no free-form text/u);
  assert.match(html, /download response JSON/u);
  assert.doesNotMatch(html, /https?:\/\//u);
  assert.doesNotMatch(html, /<textarea\b/iu);
  assert.doesNotMatch(html, /secret-fixture|sourceDeckSha256|must-not-leak/u);
});

test("offline target-user form binds one opaque five-design assignment and timing workflow", () => {
  const routing = {
    assignmentId: "target-user-3",
    designs: Array.from({ length: 5 }, (_, index) => ({
      candidateCode: candidateCode(index + 8),
      deck: `decks/P-${String(index + 1).padStart(10, "0")}.pptx`,
      slide: index + 1,
      fixtureId: "must-not-leak",
      designId: "must-not-leak",
    })),
  };
  const config = buildTargetUserReviewerFormConfig(routing);
  const html = renderReviewerForm(config);
  assert.equal(validateReviewerFormConfig(config), true);
  assert.deepEqual(embeddedConfig(html), config);
  assert.equal(config.reviews.length, 5);
  assert.ok(config.reviews.every((review) => review.deck.startsWith("../decks/P-")));
  assert.match(html, /Open deck \+ start timer/u);
  assert.match(html, /cleanupSeconds/u);
  assert.match(html, /repairActions/u);
  assert.match(html, /monthlyProfessionalDeckUse/u);
  assert.doesNotMatch(html, /fixtureId|designId|must-not-leak/u);
});

test("reviewer-form config rejects source paths and duplicate candidates", () => {
  const config = buildTargetUserReviewerFormConfig({
    assignmentId: "target-user-1",
    designs: [{ candidateCode: candidateCode(1), deck: "decks/P-0000000001.pptx", slide: 1 }],
  });
  config.reviews.push({ ...config.reviews[0] });
  assert.throws(() => validateReviewerFormConfig(config), /repeats a candidate/u);

  const pathLeak = buildTargetUserReviewerFormConfig({
    assignmentId: "target-user-2",
    designs: [{ candidateCode: candidateCode(2), deck: "decks/P-0000000002.pptx", slide: 2 }],
  });
  pathLeak.reviews[0].deck = "../fixtures/private/source.pptx";
  assert.throws(() => validateReviewerFormConfig(pathLeak), /deck path is invalid/u);
});
