import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import {
  buildExecutiveReview,
  validateExecutiveReviewSpecificity,
  REVIEW_MODE_OFF,
  REVIEW_MODE_OVERLAY,
  REVIEW_SCHEMA_VERSION,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/executive-review.mjs";

const spec = JSON.parse(await fs.readFile(path.resolve("fixtures/universal-design/deck-spec.json"), "utf8"));
const plan = compileDeck(spec);
const executiveReviewSource = await fs.readFile(path.resolve("plugins/slidewright/skills/slidewright/scripts/lib/executive-review.mjs"), "utf8");
const fixtureLanguage = /Mandell|negotiat(?:e|ed|es|ing|ion|ions|or|ors)?|counterpart|party veto|party constraint|deal requirement|interest type|pre-commitment|live issue|package choice|before agreement|first 180 seconds|facilitator|setup action|rehearse once|operating model|setup principle|under pressure|high-stakes case/iu;

function overlaps(left, right) {
  return left.left < right.left + right.width
    && left.left + left.width > right.left
    && left.top < right.top + right.height
    && left.top + left.height > right.top;
}

function rewriteShapeText(shape, value) {
  const replacement = { text: value };
  shape.text.paragraphs = [{ ...(shape.text.paragraphs?.[0] ?? {}), runs: [replacement] }];
}

function comparisonWithLabels(left, right, id, relationship) {
  const slide = structuredClone(plan.slides.find((item) => item.layout === "two-column"));
  slide.id = id;
  slide.reviewIntent = { relationship };
  rewriteShapeText(slide.shapes.find((shape) => shape.role === "subheading"), left);
  rewriteShapeText(slide.shapes.filter((shape) => shape.role === "subheading")[1], right);
  return { ...plan, slides: [slide] };
}

test("E6 off is a clean, reversible no-overlay contract", () => {
  const before = JSON.stringify(plan);
  const review = buildExecutiveReview(plan, REVIEW_MODE_OFF);
  assert.equal(review.schemaVersion, REVIEW_SCHEMA_VERSION);
  assert.equal(review.mode, "off");
  assert.equal(review.canonicalDeckModified, false);
  assert.equal(review.reviewCopyRequired, false);
  assert.deepEqual(review.findings, []);
  assert.equal(JSON.stringify(plan), before);
});

test("E6 executive overlay creates concise, editable, target-bound partner checks", () => {
  const first = buildExecutiveReview(plan, REVIEW_MODE_OVERLAY);
  const second = buildExecutiveReview(plan, REVIEW_MODE_OVERLAY);
  assert.deepEqual(first, second);
  assert.equal(first.reviewCopyRequired, true);
  assert.equal(first.findings.length, plan.slides.length);
  assert.equal(first.counts.slidesFlagged, plan.slides.length);
  assert.equal(first.specificity.valid, true);
  assert.deepEqual(validateExecutiveReviewSpecificity(first, plan), first.specificity);
  assert.equal(new Set(first.findings.map((item) => item.id)).size, first.findings.length);
  for (const finding of first.findings) {
    const slide = plan.slides[finding.slideIndex - 1];
    assert.equal(slide.id, finding.slideId);
    assert.ok(slide.shapes.some((shape) => shape.id === finding.targetShapeId));
    assert.equal(finding.editable, true);
    assert.equal(finding.manuallyRemovable, true);
    assert.ok(finding.note.length >= 120);
    assert.ok(finding.note.length <= 520);
    assert.equal(finding.exactObject.shapeId, finding.targetShapeId);
    assert.ok(finding.exactObject.excerpt.length > 0);
    assert.ok(finding.diagnosis.length > 24);
    assert.ok(finding.executiveImpact.length > 24);
    assert.ok(finding.recommendation.length > 24);
    assert.match(finding.diagnosis, new RegExp(`^Target ${finding.targetShapeId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} `, "u"));
    assert.match(finding.recommendation, new RegExp(`^Revise ${finding.targetShapeId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:`, "u"));
    assert.equal(finding.noteFit.fits, true);
    assert.ok(finding.noteFit.lines <= 12);
    assert.ok(finding.overlayPosition.left >= 0 && finding.overlayPosition.top >= 0);
    assert.ok(finding.overlayPosition.left + finding.overlayPosition.width <= plan.canvas.width);
    assert.ok(finding.overlayPosition.top + finding.overlayPosition.height <= plan.canvas.height);
  }
  for (const slide of plan.slides) {
    const findings = first.findings.filter((item) => item.slideId === slide.id);
    for (let index = 0; index < findings.length; index += 1) {
      for (let peer = index + 1; peer < findings.length; peer += 1) assert.equal(overlaps(findings[index].overlayPosition, findings[peer].overlayPosition), false);
    }
  }
});

test("E6 keeps provenance sentences unique when several slides reuse one source concept", () => {
  const reused = structuredClone(plan);
  for (const [index, slide] of reused.slides.entries()) {
    slide.designProvenance = {
      conceptId: "shared-source-concept",
      referenceSlides: [12],
      selectedConcept: "shared comparison structure",
      compositionModel: "comparison",
    };
    slide.id = `reused-source-${index + 1}`;
  }
  const review = buildExecutiveReview(reused, REVIEW_MODE_OVERLAY);
  assert.equal(review.specificity.valid, true);
  assert.equal(new Set(review.findings.map((finding) => finding.provenanceContext)).size, review.findings.length);
  for (const finding of review.findings) assert.match(finding.provenanceContext, new RegExp(`Ref ${finding.targetShapeId}:`, "u"));
});

test("E6 production templates contain no Mandell or negotiation-fixture prose", () => {
  assert.doesNotMatch(executiveReviewSource, fixtureLanguage);
  const review = buildExecutiveReview(plan, REVIEW_MODE_OVERLAY);
  for (const finding of review.findings) assert.doesNotMatch(finding.note, fixtureLanguage);
});

test("E6 rejects repeated boilerplate and comments without exact object grounding", () => {
  const review = buildExecutiveReview(plan, REVIEW_MODE_OVERLAY);
  const mutant = structuredClone(review);
  mutant.findings[1].note = mutant.findings[0].note;
  mutant.findings[1].diagnosis = mutant.findings[0].diagnosis;
  mutant.findings[1].executiveImpact = mutant.findings[0].executiveImpact;
  mutant.findings[1].recommendation = mutant.findings[0].recommendation;
  assert.equal(validateExecutiveReviewSpecificity(mutant, plan).valid, false);
  const missing = structuredClone(review);
  delete missing.findings[0].exactObject;
  assert.equal(validateExecutiveReviewSpecificity(missing, plan).valid, false);
  const overflowing = structuredClone(review);
  overflowing.findings[0].noteFit.fits = false;
  assert.equal(validateExecutiveReviewSpecificity(overflowing, plan).valid, false);
  const semanticDuplicate = structuredClone(review);
  const source = semanticDuplicate.findings[0];
  const target = semanticDuplicate.findings[1];
  target.diagnosis = `Target ${target.targetShapeId} “different object”: ${source.diagnosis.replace(/^Target\s+[^:]+:\s*/u, "")}`;
  target.recommendation = `Revise ${target.targetShapeId}: ${source.recommendation.replace(/^Revise\s+[^:]+:\s*/u, "")}`;
  target.note = `${target.diagnosis} ${target.executiveImpact} ${target.recommendation}`;
  assert.equal(validateExecutiveReviewSpecificity(semanticDuplicate, plan).valid, false);
});

test("E6 fails closed on an unsupported activation value", () => {
  assert.throws(() => buildExecutiveReview(plan, "yellow-notes-maybe"), /Unsupported executive review mode/u);
});

test("E6 classifies the decision relationship in a two-panel slide instead of repeating generic comparison advice", () => {
  const cases = [
    ["ALPHA", "BETA", "crosswalk", "crosswalk-logic"],
    ["GAMMA", "DELTA", "comparison-selection", "comparison-decision-rule"],
    ["EPSILON", "ZETA", "role-boundary", "role-boundary"],
    ["ETA", "THETA", "sequence-handoff", "sequence-handoff"],
  ];
  const notes = [];
  for (const [left, right, relationship, category] of cases) {
    const review = buildExecutiveReview(comparisonWithLabels(left, right, `relationship-${category}`, relationship), REVIEW_MODE_OVERLAY);
    assert.equal(review.findings.length, 1);
    const finding = review.findings[0];
    assert.equal(finding.category, category);
    assert.equal(review.specificity.valid, true);
    assert.match(finding.diagnosis, new RegExp(left, "u"));
    assert.match(finding.diagnosis, new RegExp(right, "u"));
    assert.match(finding.recommendation, new RegExp(right, "u"));
    assert.match(finding.diagnosis, new RegExp(`^Target ${finding.targetShapeId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} `, "u"));
    assert.match(finding.recommendation, new RegExp(`^Revise ${finding.targetShapeId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:`, "u"));
    notes.push(finding.note);
  }
  assert.equal(new Set(notes).size, cases.length);
});

test("E6 content-derived relationship checks stay compact with long labels and source provenance", () => {
  const left = "INTERNATIONAL DISTRIBUTION READINESS AND CHANNEL CAPACITY";
  const right = "REGIONAL CUSTOMER ADOPTION CONDITIONS AND SERVICE CONSTRAINTS";
  const customPlan = comparisonWithLabels(left, right, "relationship-long-labels", "crosswalk");
  customPlan.slides[0].designProvenance = {
    conceptId: "source-concept",
    referenceSlides: [47],
    selectedConcept: "A LONG SOURCE CONCEPT FOR A COMPLEX TWO-COLUMN CROSSWALK",
    compositionModel: "two-column-relationship-model",
  };
  const review = buildExecutiveReview(customPlan, REVIEW_MODE_OVERLAY);
  const finding = review.findings[0];
  assert.equal(finding.noteFit.fits, true);
  assert.ok(finding.note.length <= 520);
  assert.equal(finding.exactObject.shapeId, finding.targetShapeId);
  assert.match(finding.exactObject.excerpt, /INTERNATIONAL DISTRIBUTION/u);
  assert.match(finding.diagnosis, /REGIONAL CUSTOMER/u);
  assert.match(finding.recommendation, /REGIONAL CUSTOMER/u);
  assert.match(finding.note, /Ref s3-left-heading: slide 47/u);
  assert.doesNotMatch(finding.note, fixtureLanguage);
});
