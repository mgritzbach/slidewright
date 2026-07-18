import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { compileDeck } from "../plugins/slidewright/skills/slidewright/scripts/lib/compiler.mjs";
import { lintPlan } from "../plugins/slidewright/skills/slidewright/scripts/lib/linter.mjs";

const spec = JSON.parse(await fs.readFile(new URL("../examples/demo/deck-spec.json", import.meta.url), "utf8"));

test("compiler output is deterministic", () => {
  const first = compileDeck(spec);
  const second = compileDeck(spec);
  assert.deepEqual(second, first);
  assert.equal(first.build.deterministicHash, second.build.deterministicHash);
});

test("demo plan passes all formatting rules", () => {
  const report = lintPlan(compileDeck(spec));
  assert.equal(report.valid, true, JSON.stringify(report.diagnostics, null, 2));
});

test("linter rejects asymmetric outer margins", () => {
  const plan = compileDeck(spec);
  plan.slides[0].frame.left += 5;
  const report = lintPlan(plan);
  assert.equal(report.valid, false);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW006"));
});

test("linter rejects asymmetric component padding", () => {
  const plan = compileDeck(spec);
  const surface = plan.slides[0].shapes.find((shape) => shape.padding);
  surface.padding.right += 8;
  const report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW007"));
});

test("linter rejects fractional and nonstandard font sizes", () => {
  const plan = compileDeck(spec);
  const title = plan.slides[0].shapes.find((shape) => shape.role === "title");
  title.style.fontSizePt = 37.5;
  let report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW003"));

  title.style.fontSizePt = 37;
  report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW002"));
});

test("linter rejects any text size below its configured minimum", () => {
  const plan = compileDeck(spec);
  const body = plan.slides[0].shapes.find((shape) => shape.role === "body");
  body.style.fontSizePt = 14;
  const report = lintPlan(plan);
  assert.ok(report.diagnostics.some((item) => item.ruleId === "SW009"));
});

test("legacy golden-template plan uses the hardened source-object identity contract", async (t) => {
  const root = process.cwd();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-legacy-template-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = path.join(root, "fixtures", "template", "mit-v1");
  const source = path.join(fixture, "slidewright-mit-template.pptx");
  const planPath = path.join(fixture, "edit-plan.json");
  const editor = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "template", "edit_template.py");
  const python = process.env.SLIDEWRIGHT_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const output = path.join(directory, "edited.pptx");
  const report = path.join(directory, "report.json");
  const accepted = spawnSync(python, [editor, source, planPath, output, "--json", report], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(accepted.status, 0, accepted.stderr);
  const payload = JSON.parse(await fs.readFile(report, "utf8"));
  assert.deepEqual(payload.editedShapes, ["MIT Fixture Title", "MIT Fixture Body"]);

  const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
  delete plan.edits[0].sourceObjectKey;
  const mutant = path.join(directory, "mutant.json");
  await fs.writeFile(mutant, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const rejected = spawnSync(python, [editor, source, mutant, path.join(directory, "mutant.pptx"), "--json", path.join(directory, "mutant-report.json")], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /requires a complete source-bound object identity/u);
});
