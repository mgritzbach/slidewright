import assert from "node:assert/strict";
import test from "node:test";
import { buildPowerPointAdapterScorecard, buildPowerPointAdapterStatus } from "../plugins/slidewright/skills/slidewright/scripts/lib/powerpoint-adapter.mjs";

test("PowerPoint adapter is enabled only when Windows and PowerPoint are available", () => {
  assert.deepEqual(buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: true, generationAvailable: true }), {
    valid: true,
    adapterEnabled: true,
    generationEnabled: true,
    optional: true,
    reason: "Direct PowerPoint editing is available.",
  });
});

test("missing PowerPoint disables only the optional adapter", () => {
  const status = buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: false, generationAvailable: true });
  assert.equal(status.valid, true);
  assert.equal(status.adapterEnabled, false);
  assert.equal(status.generationEnabled, true);
  assert.equal(status.optional, true);
});

test("non-Windows hosts retain generation without the adapter", () => {
  const status = buildPowerPointAdapterStatus({ platform: "linux", powerPointAvailable: true, generationAvailable: true });
  assert.equal(status.valid, true);
  assert.equal(status.adapterEnabled, false);
  assert.equal(status.generationEnabled, true);
});

test("a skipped optional adapter cannot masquerade as complete C21 proof", () => {
  const actualStatus = buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: false, generationAvailable: true });
  const unavailableControl = buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: false, generationAvailable: true });
  const scorecard = buildPowerPointAdapterScorecard({
    actualStatus,
    unavailableControl,
    unavailableGenerationProof: { valid: true },
    adapterReport: null,
  });
  assert.equal(scorecard.optionalGenerationValid, true);
  assert.equal(scorecard.c21ProofComplete, false);
  assert.equal(scorecard.valid, false);
});

test("C21 proof requires live selection and exact group membership preservation", () => {
  const actualStatus = buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: true, generationAvailable: true });
  const unavailableControl = buildPowerPointAdapterStatus({ platform: "win32", powerPointAvailable: false, generationAvailable: true });
  const scorecard = buildPowerPointAdapterScorecard({
    actualStatus,
    unavailableControl,
    unavailableGenerationProof: { valid: true },
    adapterReport: { valid: true, selectionVerified: true, exactMemberSetPreserved: true },
  });
  assert.equal(scorecard.c21ProofComplete, true);
  assert.equal(scorecard.valid, true);
});
