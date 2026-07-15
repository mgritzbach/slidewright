import test from "node:test";
import assert from "node:assert/strict";
import { fitText, normalizeRuns } from "../plugins/slidewright/skills/slidewright/scripts/lib/typography.mjs";

test("autosizer chooses the largest approved integer point size that fits", () => {
  const result = fitText({
    text: "A deliberately long title that must step down from the preferred size",
    width: 520,
    height: 120,
    preferredSizePt: 54,
    minSizePt: 28,
    maxLines: 3,
    lineHeight: 1.02,
  });
  assert.equal(result.fits, true);
  assert.equal(Number.isInteger(result.fontSizePt), true);
  assert.ok(result.fontSizePt <= 54);
  assert.ok([54, 48, 44, 40, 36, 32, 28].includes(result.fontSizePt));
});

test("autosizer fails visibly when text cannot fit above the minimum", () => {
  const result = fitText({
    text: "word ".repeat(200),
    width: 200,
    height: 40,
    preferredSizePt: 24,
    minSizePt: 16,
    maxLines: 2,
  });
  assert.equal(result.fits, false);
  assert.equal(result.fontSizePt, 16);
});

test("rich-text normalization preserves explicit bold and regular runs", () => {
  const runs = normalizeRuns({ runs: [{ text: "Bold", bold: true }, { text: " regular", bold: false }] });
  assert.deepEqual(runs.map((run) => run.bold), [true, false]);
});
