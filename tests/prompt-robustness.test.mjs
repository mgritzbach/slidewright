import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  evaluateRequestPolicy,
  IMMUTABLE_REQUEST_STAGES,
  REQUEST_QUALITY_CONTRACT,
  REQUEST_SCHEMA_VERSION,
} from "../plugins/slidewright/skills/slidewright/scripts/lib/request-policy.mjs";
import { runRequestBuild, verifyRequestRun } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";
import { parseStrictJson } from "../plugins/slidewright/skills/slidewright/scripts/lib/strict-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "fixtures", "prompt-robustness", "v1");
const manifest = JSON.parse(await fs.readFile(path.join(fixtureDir, "fixture-manifest.json"), "utf8"));
const benchmarkRunner = await fs.readFile(path.join(root, "scripts", "run-prompt-robustness-benchmark.mjs"), "utf8");

async function requestFor(fixture) {
  const spec = JSON.parse(await fs.readFile(path.resolve(fixtureDir, fixture.spec), "utf8"));
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id: fixture.id,
    prompt: fixture.prompt,
    spec,
    ...(fixture.requestPatch ?? {}),
  };
}

test("C12 matrix has the required 12-case category coverage and three repeats", () => {
  assert.equal(manifest.cases.length, 12);
  assert.equal(manifest.repeatRuns, 3);
  const counts = Object.groupBy(manifest.cases, (fixture) => fixture.category);
  assert.equal(counts.minimal.length, 2);
  assert.equal(counts.verbose.length, 2);
  assert.equal(counts.conflicting.length, 4);
  assert.equal(counts.adversarial.length, 4);
});

test("mandatory request stages and quality floors are code-owned", () => {
  assert.deepEqual(IMMUTABLE_REQUEST_STAGES, ["policy", "compile", "fonts", "lint", "render", "audit", "executive-review", "delivery"]);
  assert.equal(REQUEST_QUALITY_CONTRACT.geometryTolerancePx, 1);
  assert.equal(REQUEST_QUALITY_CONTRACT.minimumFontSizeByRolePt.title, 28);
  assert.equal(REQUEST_QUALITY_CONTRACT.minimumFontSizeByRolePt.body, 16);
  assert.equal(REQUEST_QUALITY_CONTRACT.warningsAreFailures, true);
  assert.equal(REQUEST_QUALITY_CONTRACT.promptMayControlStages, false);
  assert.equal(REQUEST_QUALITY_CONTRACT.promptMayControlPaths, false);
  assert.equal(REQUEST_QUALITY_CONTRACT.atomicPublicationRequired, true);
});

test("C12 scorecard and fault controls consume the shared immutable stage contract", () => {
  assert.match(benchmarkRunner, /for \(const stage of \[\.\.\.IMMUTABLE_REQUEST_STAGES, "before-publication"\]\)/u);
  assert.match(benchmarkRunner, /stableJson\(run\.stageNames\) === stableJson\(IMMUTABLE_REQUEST_STAGES\)/u);
  assert.match(benchmarkRunner, /"executive-review-clean-audit\.json"/u);
  assert.match(benchmarkRunner, /"executive-review-previews"/u);
  assert.doesNotMatch(benchmarkRunner, /stableJson\(\["policy", "compile", "fonts", "lint", "render", "audit", "delivery"\]\)/u);
});

test("E6 activation is explicit and invalid review controls fail closed", async () => {
  const base = await requestFor(manifest.cases.find((fixture) => fixture.id === "minimal-demo"));
  assert.equal(evaluateRequestPolicy({ ...base, reviewMode: "off" }).valid, true);
  assert.equal(evaluateRequestPolicy({ ...base, reviewMode: "executive-overlay" }).valid, true);
  const invalid = evaluateRequestPolicy({ ...base, reviewMode: "comments" });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((item) => item.ruleId === "SWP000" && /reviewMode/u.test(item.message)));
});

for (const fixture of manifest.cases) {
  test(`prompt policy closes ${fixture.id}`, async () => {
    const policy = evaluateRequestPolicy(await requestFor(fixture));
    assert.equal(policy.valid, fixture.expectedOutcome === "built", JSON.stringify(policy.diagnostics, null, 2));
    const ruleIds = new Set(policy.diagnostics.map((item) => item.ruleId));
    for (const ruleId of fixture.expectedRuleIds ?? []) assert.equal(ruleIds.has(ruleId), true, `${fixture.id} should emit ${ruleId}`);
    assert.equal(policy.promptTreatedAsData, true);
    assert.equal(policy.promptExecuted, false);
    assert.deepEqual(policy.immutableStages, IMMUTABLE_REQUEST_STAGES);
  });
}

test("strict JSON rejects duplicate keys, non-finite numbers, invalid UTF-8, and excessive depth", () => {
  assert.throws(() => parseStrictJson(Buffer.from('{"id":1,"id":2}')), /Duplicate object key/u);
  assert.throws(() => parseStrictJson(Buffer.from('{"value":1e309}')), /Non-finite number/u);
  assert.throws(() => parseStrictJson(Uint8Array.from([0xc3, 0x28])), /valid UTF-8/u);
  assert.throws(() => parseStrictJson(Buffer.from("[".repeat(66) + "]".repeat(66))), /nesting exceeds/u);
});

test("unknown request controls and plan-policy fields fail closed", async () => {
  const request = await requestFor(manifest.cases.find((fixture) => fixture.id === "minimal-demo"));
  request.skipAudit = true;
  request.spec.slides[0].quality = { maximumOccupancyRatio: 1 };
  request.spec.layout = { margin: 1, geometryTolerance: 100 };
  const policy = evaluateRequestPolicy(request);
  assert.equal(policy.valid, false);
  assert.ok(policy.diagnostics.some((item) => item.ruleId === "SWP000"));
  assert.ok(policy.diagnostics.some((item) => item.ruleId === "SWP009"));
});

test("a rejected request atomically publishes only inert evidence and cannot create a deck", async () => {
  const fixture = manifest.cases.find((item) => item.id === "adversarial-command-path");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c12-reject-"));
  const requestPath = path.join(directory, "request.json");
  const outputDir = path.join(directory, "run");
  await fs.writeFile(requestPath, `${JSON.stringify(await requestFor(fixture), null, 2)}\n`, "utf8");
  try {
    const result = await runRequestBuild({ requestPath, outputDir });
    assert.equal(result.run.outcome, "rejected");
    assert.equal(result.run.valid, false);
    const verification = await verifyRequestRun(outputDir);
    assert.equal(verification.valid, true, JSON.stringify(verification.diagnostics));
    const files = await fs.readdir(outputDir);
    assert.deepEqual(files.sort(), ["policy.json", "request.json", "run.json"]);
    await assert.rejects(fs.access(path.join(outputDir, "deck.pptx")));
    await fs.writeFile(path.join(outputDir, "forged.pptx"), "not a deck", "utf8");
    const tampered = await verifyRequestRun(outputDir);
    assert.equal(tampered.valid, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
