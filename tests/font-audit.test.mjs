import assert from "node:assert/strict";
import test from "node:test";
import { auditFonts } from "../plugins/slidewright/skills/slidewright/scripts/lib/font-audit.mjs";

function plan(fontFamily = "Aptos", fallbackFontFamily = "Arial") {
  return {
    theme: { fontFamily, fallbackFontFamily },
    slides: [{ shapes: [{ type: "text", style: { typeface: fontFamily }, text: { runs: [{ text: "Editable" }] } }] }],
  };
}

test("font audit passes only when every requested family is installed", () => {
  const report = auditFonts(plan(), ["Arial", "Aptos", "Georgia"]);
  assert.equal(report.valid, true);
  assert.equal(report.substitutionApplied, false);
});

test("missing font fails visibly and offers an explicit installed fallback", () => {
  const report = auditFonts(plan("Definitely Missing Slidewright Sans"), ["Arial", "Georgia"]);
  assert.equal(report.valid, false);
  assert.equal(report.diagnostics[0].ruleId, "SWF001");
  assert.match(report.diagnostics[0].message, /silent substitution/);
  assert.match(report.diagnostics[0].remediation, /explicitly set theme\.fontFamily/);
  assert.deepEqual(report.suggestedThemePatch, { fontFamily: "Arial" });
  assert.equal(report.substitutionApplied, false);
});

test("font inventory failure blocks rendering instead of guessing", () => {
  const report = auditFonts(plan(), [], "font service unavailable");
  assert.equal(report.valid, false);
  assert.equal(report.diagnostics[0].ruleId, "SWF000");
});
