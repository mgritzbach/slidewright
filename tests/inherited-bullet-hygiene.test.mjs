import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const fixture = path.join(root, "fixtures", "feedback", "inherited-bullets-v1");
const source = path.join(fixture, "slidewright-inherited-empty-bullets.pptx");
const plan = path.join(fixture, "hygiene-plan.json");
const scripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "template");
const python = process.env.SLIDEWRIGHT_PYTHON || "python";

function run(script, args) {
  const result = spawnSync(python, [path.join(scripts, script), ...args], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${script} failed:\n${result.stdout}\n${result.stderr}`);
}

test("G28 removes only empty paragraphs whose bullets are inherited from the PowerPoint master", async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "slidewright-g28-test-"));
  try {
    const output = path.join(temporary, "sanitized.pptx");
    const editReport = path.join(temporary, "edit.json");
    const auditReport = path.join(temporary, "audit.json");
    run("inherited_bullet_hygiene.py", [source, plan, output, "--json", editReport]);
    run("audit_inherited_bullet_hygiene.py", [source, output, plan, "--json", auditReport]);
    const edit = JSON.parse(await fsp.readFile(editReport, "utf8"));
    const audit = JSON.parse(await fsp.readFile(auditReport, "utf8"));
    assert.equal(edit.removedParagraphs, 3);
    assert.equal(edit.remainingEmptyParagraphs, 0);
    assert.equal(edit.bulletInheritanceSource, "master-body-style");
    assert.equal(edit.nonemptyParagraphHashesPreserved, true);
    assert.equal(audit.valid, true);
    assert.equal(audit.summary.passed, audit.summary.checks);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});

test("G28 source-template controls reject stale, collateral, destructive, and reinserted-bullet changes", async () => {
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), "slidewright-g28-negative-test-"));
  try {
    const output = path.join(temporary, "sanitized.pptx");
    run("inherited_bullet_hygiene.py", [source, plan, output, "--json", path.join(temporary, "edit.json")]);
    const reportPath = path.join(temporary, "negative.json");
    run("inherited_bullet_negative_controls.py", [source, output, plan, "--out-dir", path.join(temporary, "mutants"), "--json", reportPath]);
    const report = JSON.parse(await fsp.readFile(reportPath, "utf8"));
    assert.equal(report.valid, true);
    assert.equal(report.summary.total, 6);
    assert.equal(report.summary.rejected, 6);
    assert.equal(report.controls.every((control) => control.rejected), true);
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true });
  }
});
