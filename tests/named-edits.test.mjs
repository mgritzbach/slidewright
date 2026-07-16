import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main as slidewrightMain } from "../plugins/slidewright/skills/slidewright/scripts/slidewright.mjs";
import test from "node:test";
import { buildIterationManifests, buildIterationPlan } from "../plugins/slidewright/skills/slidewright/scripts/benchmark/iteration_suite.mjs";
import {
  applyNamedEditManifest,
  applyNamedEdits,
  compareNamedFingerprints,
  planContentHash,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/named-edits.mjs";

const expectedClosures = {
  text: ["s1-body"],
  bold: ["s1-title"],
  color: ["s1-callout-surface"],
  position: ["s1-mutation-accent"],
  chart: ["horizontal-chart-component", "horizontal-chart-component-mark-2"],
  layout: ["s2-left-body", "s2-left-heading", "s2-left-surface", "s2-right-body", "s2-right-heading", "s2-right-surface"],
};

test("six c16-v1 manifests derive exact bounded change closures", () => {
  const baseline = buildIterationPlan();
  for (const manifest of buildIterationManifests(baseline)) {
    const result = applyNamedEditManifest(baseline, manifest);
    assert.deepEqual(result.changedIds, expectedClosures[manifest.id]);
    assert.equal(result.comparison.valid, true);
    assert.equal(result.comparison.unchangedCount, 27 - result.changedIds.length);
  }
});

test("named edit manifests reject stale hashes, missing targets, invalid runs, and no-ops", () => {
  const baseline = buildIterationPlan();
  const hash = planContentHash(baseline);
  assert.throws(() => applyNamedEditManifest(baseline, { version: "c16-v1", id: "stale", baselinePlanHash: "0".repeat(64), edit: { type: "color", targetId: "s1-callout-surface", value: "#C7D2FE" } }), /Stale baseline/u);
  assert.throws(() => applyNamedEditManifest(baseline, { version: "c16-v1", id: "missing", baselinePlanHash: hash, edit: { type: "color", targetId: "missing", value: "#000000" } }), /does not exist/u);
  assert.throws(() => applyNamedEditManifest(baseline, { version: "c16-v1", id: "run", baselinePlanHash: hash, edit: { type: "bold", targetId: "s1-title", runIndex: 9, value: true } }), /does not exist/u);
  assert.throws(() => applyNamedEditManifest(baseline, { version: "c16-v1", id: "noop", baselinePlanHash: hash, edit: { type: "bold", targetId: "s1-title", runIndex: 0, value: false } }), /no-op/u);
  assert.throws(() => applyNamedEditManifest(baseline, { version: "c16-v1", id: "gap", baselinePlanHash: hash, edit: { type: "layout", slideId: "difference", columnGap: 400 } }), /between 16 and 96/u);
});

test("user-supplied allowlists cannot expand the editor-derived closure", () => {
  const baseline = buildIterationPlan();
  const manifest = buildIterationManifests(baseline)[0];
  manifest.allowedChangedIds = ["s1-body", "s4-title"];
  const result = applyNamedEditManifest(baseline, manifest);
  assert.deepEqual(result.changedIds, ["s1-body"]);
});

test("fingerprint comparison rejects collateral drift", () => {
  const baseline = buildIterationPlan();
  const result = applyNamedEdits(baseline, [{ type: "bold", targetId: "s1-title", runIndex: 0, value: true }]);
  result.plan.slides[3].shapes.find((shape) => shape.id === "s3-eyebrow").style.color = "#000000";
  const comparison = compareNamedFingerprints(baseline, result.plan, result.changedIds);
  assert.equal(comparison.valid, false);
  assert.deepEqual(comparison.actualChangedIds, ["s1-title", "s3-eyebrow"]);
});

test("iterate CLI applies a stale-safe manifest and writes an updated plan", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-iterate-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const baseline = buildIterationPlan();
  const manifest = buildIterationManifests(baseline)[0];
  const baselinePath = path.join(directory, "baseline.json");
  const manifestPath = path.join(directory, "edit.json");
  const outputPath = path.join(directory, "updated.json");
  await fs.writeFile(baselinePath, JSON.stringify(baseline), "utf8");
  await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  assert.equal(await slidewrightMain(["iterate", baselinePath, "--manifest", manifestPath, "--out", outputPath]), 0);
  const updated = JSON.parse(await fs.readFile(outputPath, "utf8"));
  assert.equal(updated.slides[0].shapes.find((shape) => shape.id === "s1-body").text.runs[0].text, manifest.edit.value);
  assert.equal(compareNamedFingerprints(baseline, updated, ["s1-body"]).valid, true);
});
