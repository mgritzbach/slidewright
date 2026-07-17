import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import {
  buildExecutiveReview,
  REVIEW_MODE_OFF,
  REVIEW_MODE_OVERLAY,
  REVIEW_SCHEMA_VERSION,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/executive-review.mjs";

const spec = JSON.parse(await fs.readFile(path.resolve("fixtures/universal-design/deck-spec.json"), "utf8"));
const plan = compileDeck(spec);

function overlaps(left, right) {
  return left.left < right.left + right.width
    && left.left + left.width > right.left
    && left.top < right.top + right.height
    && left.top + left.height > right.top;
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
  assert.ok(first.findings.length >= plan.slides.length);
  assert.ok(first.findings.length <= plan.slides.length * 2);
  assert.equal(first.counts.slidesFlagged, plan.slides.length);
  assert.equal(new Set(first.findings.map((item) => item.id)).size, first.findings.length);
  for (const finding of first.findings) {
    const slide = plan.slides[finding.slideIndex - 1];
    assert.equal(slide.id, finding.slideId);
    assert.ok(slide.shapes.some((shape) => shape.id === finding.targetShapeId));
    assert.equal(finding.editable, true);
    assert.equal(finding.manuallyRemovable, true);
    assert.ok(finding.note.length <= 72);
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

test("E6 fails closed on an unsupported activation value", () => {
  assert.throws(() => buildExecutiveReview(plan, "yellow-notes-maybe"), /Unsupported executive review mode/u);
});
