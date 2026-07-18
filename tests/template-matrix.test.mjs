import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { expectedTemplateMatrixClosurePaths, loadValidatedRejectedSources, validateTemplateMatrixManifest } from "../scripts/lib/template-matrix-evidence.mjs";
import { verifyPublishedTemplateMatrixEvidence } from "../scripts/lib/template-matrix-public-evidence.mjs";

const root = process.cwd();
const fixtureRoot = path.join(root, "fixtures", "template", "c10-v1");
const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const scripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function run(command, args) {
  const completed = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(completed.status, 0, completed.stderr || completed.stdout);
  return completed;
}

test("C10 fixture manifest pins four licensed healthy templates and rejected unhealthy sources", async () => {
  const raw = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const manifest = validateTemplateMatrixManifest(raw);
  assert.equal(manifest.fixtures.length, 4);
  assert.deepEqual(manifest.fixtures.map((item) => item.id), ["automizer-charts-mit", "automizer-tables-mit", "martin-mit", "cats-cc0-sanitized"]);
  for (const fixture of manifest.fixtures) {
    assert.equal(await sha256(path.join(fixtureRoot, fixture.sourceFile)), fixture.sourceSha256);
    assert.ok((await fs.stat(path.join(fixtureRoot, fixture.license.file))).size > 0);
    assert.ok((await fs.stat(path.join(fixtureRoot, fixture.editPlan))).size > 0);
  }
  const rejected = await Promise.all(manifest.rejectedSources.map(async (relative) => JSON.parse(await fs.readFile(path.join(fixtureRoot, relative), "utf8"))));
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((item) => item.status === "rejected"));
  assert.match(rejected.find((item) => item.id.startsWith("triple"))?.rejectionReason ?? "", /not a healthy/u);
  assert.match(rejected.find((item) => item.id.startsWith("keith"))?.rejectionReason ?? "", /terminates the tested Microsoft PowerPoint/u);
});

test("C10 evidence closure re-derives sanitizers, upstreams, licenses, plans, and rejected-source evidence", async () => {
  const raw = JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8"));
  const manifest = validateTemplateMatrixManifest(raw);
  const closure = await expectedTemplateMatrixClosurePaths(root, raw);
  assert.deepEqual(closure, [...closure].sort());
  for (const required of [
    "fixtures/template/c10-v1/automizer-charts/upstream-template.pptx",
    "fixtures/template/c10-v1/cats/upstream-template.pptx",
    "fixtures/template/c10-v1/cats/sanitize.py",
    "fixtures/template/c10-v1/cats/SANITIZATION.md",
    "fixtures/template/c10-v1/rejected/triple.json",
    "fixtures/template/c10-v1/rejected/keith-powerpoint.json",
    "fixtures/template/c10-v1/keith/template.pptx",
    "fixtures/template/c10-v1/keith/edit-plan.json",
    "fixtures/template/c10-v1/keith/LICENSE.txt",
  ]) assert.ok(closure.includes(required), required);
  assert.deepEqual((await loadValidatedRejectedSources(root, manifest)).map((item) => item.id), ["triple-cc-by-4.0", "keith-cc0-powerpoint-incompatible"]);
});

test("C10 native-chart fixture is a deterministic overlap-free derivative of its pinned upstream", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-chart-curation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = path.join(fixtureRoot, "automizer-charts");
  const rebuilt = path.join(directory, "template.pptx");
  assert.equal(await sha256(path.join(fixture, "upstream-template.pptx")), "cb2773c55cda589145f971a754fd2e0dc5412b83e3bbf87646b3d85602306ef6");
  run(python, [path.join(fixture, "sanitize.py"), path.join(fixture, "upstream-template.pptx"), rebuilt]);
  assert.equal(await sha256(rebuilt), "7b4d6833c93229377c160359f6764811a29728c57446ea39b7734eca5189101c");
  assert.equal(await sha256(rebuilt), await sha256(path.join(fixture, "template.pptx")));
});

test("C10 Cats fixture is exactly reproducible from its pinned vendored upstream", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-cats-curation-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = path.join(fixtureRoot, "cats");
  const rebuilt = path.join(directory, "template.pptx");
  assert.equal(await sha256(path.join(fixture, "upstream-template.pptx")), "b0b5eea81ad7d8a47c5cb98f04e286d0b9bbe6177b15b57003618e1165dc77ba");
  run(python, [path.join(fixture, "sanitize.py"), "--input", path.join(fixture, "upstream-template.pptx"), "--output", rebuilt]);
  assert.equal(await sha256(rebuilt), "b996327ede97791a8e54cde0983f04880bdddd68b28901ff129146d59362547c");
  assert.equal(await sha256(rebuilt), await sha256(path.join(fixture, "template.pptx")));
});

test("C10 plans perform exact source-bound edits or byte-exact preservation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-plans-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifest = validateTemplateMatrixManifest(JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8")));
  for (const fixture of manifest.fixtures) {
    const source = path.join(fixtureRoot, fixture.sourceFile);
    const plan = path.join(fixtureRoot, fixture.editPlan);
    const profile = path.join(directory, `${fixture.id}-profile.json`);
    const edited = path.join(directory, `${fixture.id}-edited.pptx`);
    run(python, [path.join(scripts, "design_profile", "extract_design_profile.py"), source, "--out", profile, "--quiet"]);
    run(python, [path.join(scripts, "template", "edit_template.py"), source, plan, edited, "--json", path.join(directory, `${fixture.id}-edit.json`)]);
    run(python, [path.join(scripts, "design_profile", "audit_design_profile.py"), source, edited, "--profile", profile, "--edit-plan", plan, "--json", path.join(directory, `${fixture.id}-audit.json`)]);
    const audit = JSON.parse(await fs.readFile(path.join(directory, `${fixture.id}-audit.json`), "utf8"));
    assert.equal(audit.valid, true);
    assert.equal(audit.summary.planBound, true);
    assert.equal(audit.summary.packagePartsChecked, fixture.inventory.packageParts);
    assert.equal(audit.summary.inheritanceChainsChecked, fixture.inventory.slides);
    if (fixture.targetContract.mode === "preserve-only") assert.equal(await sha256(source), await sha256(edited));
    else assert.notEqual(await sha256(source), await sha256(edited));
  }
});

test("empty-placeholder insertion refuses a missing source-object binding", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-empty-binding-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const plan = JSON.parse(await fs.readFile(path.join(fixtureRoot, "martin", "edit-plan.json"), "utf8"));
  delete plan.edits[0].sourceParagraphSha256s;
  const badPlan = path.join(directory, "bad-plan.json");
  await fs.writeFile(badPlan, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const completed = spawnSync(python, [path.join(scripts, "template", "edit_template.py"), path.join(fixtureRoot, "martin", "template.pptx"), badPlan, path.join(directory, "bad.pptx"), "--json", path.join(directory, "bad.json")], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /requires a complete source-bound object identity/u);
});

test("C10 PowerPoint worker is isolated and has no destructive process-control path", async () => {
  const worker = await fs.readFile(path.join(scripts, "template", "powerpoint_template_matrix_roundtrip.ps1"), "utf8");
  assert.match(worker, /requires PowerPoint to be fully closed/u);
  assert.match(worker, /\/AUTOMATION/u);
  assert.match(worker, /Test-EmptyHiddenApplication/u);
  assert.match(worker, /ownedProcessExitedNaturally/u);
  assert.doesNotMatch(worker, /GetActiveObject|AttachActive|\.Quit\s*\(|Stop-Process|\.Kill\s*\(/u);
});

test("C10 semantic auditor rejects chart, workbook, table, hyperlink, media, and native-object drift", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-semantic-controls-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifest = validateTemplateMatrixManifest(JSON.parse(await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8")));
  const seen = new Set();
  for (const fixture of manifest.fixtures) {
    const source = path.join(fixtureRoot, fixture.sourceFile);
    const report = path.join(directory, `${fixture.id}-audit.json`);
    run(python, [path.join(scripts, "template", "audit_powerpoint_roundtrip_semantics.py"), source, source, "--json", report]);
    const audit = JSON.parse(await fs.readFile(report, "utf8"));
    assert.equal(audit.valid, true);
    const controls = path.join(directory, `${fixture.id}-controls.json`);
    run(python, [path.join(scripts, "template", "powerpoint_roundtrip_semantic_controls.py"), source, source,
      "--out-dir", path.join(directory, `${fixture.id}-controls`), "--json", controls]);
    const payload = JSON.parse(await fs.readFile(controls, "utf8"));
    assert.equal(payload.valid, true);
    for (const item of payload.controls) if (item.applicable) {
      assert.equal(item.rejected, true);
      assert.equal(item.intendedFailureFound, true);
      seen.add(item.name);
    }
  }
  assert.deepEqual([...seen].sort(), [
    "chart-semantic-drift", "embedded-workbook-drift", "hyperlink-target-drift",
    "media-byte-drift", "native-object-editability-drift", "table-cell-drift",
  ]);
});

test("C10 render comparators reject vacuous counts, extra images, invalid thresholds, and a preserve-only target", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-render-controls-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const expected = path.join(directory, "expected");
  const actual = path.join(directory, "actual");
  await fs.mkdir(expected); await fs.mkdir(actual);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  for (const folder of [expected, actual]) {
    await fs.writeFile(path.join(folder, "slide-1.png"), png);
    await fs.writeFile(path.join(folder, "slide-2.png"), png);
  }
  const exact = path.join(scripts, "template", "compare_exact_renders.py");
  for (const tail of [["--slides", "0", "--minimum", "1"], ["--slides", "1", "--minimum", "-1"], ["--slides", "1", "--minimum", "1"]]) {
    const completed = spawnSync(python, [exact, expected, actual, ...tail, "--json", path.join(directory, "exact.json"), "--out-dir", path.join(directory, "diff")], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.notEqual(completed.status, 0);
  }
  const plan = JSON.parse(await fs.readFile(path.join(fixtureRoot, "automizer-charts", "edit-plan.json"), "utf8"));
  plan.preserveOnlySlides = [1, 2];
  const badPlan = path.join(directory, "bad-plan.json");
  await fs.writeFile(badPlan, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const completed = spawnSync(python, [path.join(scripts, "template", "compare_template_renders.py"),
    path.join(fixtureRoot, "automizer-charts", "template.pptx"), badPlan, expected, actual,
    "--json", path.join(directory, "template.json"), "--out-dir", path.join(directory, "template-diff")], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /targetSlide cannot also be listed/u);
});

test("C10 compact public evidence binds the full scorecard, review, and current implementation closure", async (t) => {
  const published = path.join(root, "evidence", "c10", "v1");
  const verified = await verifyPublishedTemplateMatrixEvidence({ root, published });
  assert.deepEqual({
    valid: verified.valid,
    fixtures: verified.fixtures,
    slides: verified.slides,
    artifactReceipts: verified.artifactReceipts,
    reviewedArtifacts: verified.reviewedArtifacts,
  }, { valid: true, fixtures: 4, slides: 39, artifactReceipts: 542, reviewedArtifacts: 195 });

  const mutant = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c10-public-mutant-"));
  t.after(() => fs.rm(mutant, { recursive: true, force: true }));
  await fs.cp(published, mutant, { recursive: true });
  const pointer = JSON.parse(await fs.readFile(path.join(mutant, "current.json"), "utf8"));
  const reviewPath = path.join(mutant, ...pointer.review.split("/"));
  const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
  review.artifacts[0].verdict = "fail";
  await fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await assert.rejects(() => verifyPublishedTemplateMatrixEvidence({ root, published: mutant }), /review bytes drifted/u);
});
