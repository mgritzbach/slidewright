import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = process.env.SLIDEWRIGHT_PYTHON || "python";
const auditor = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "repair_free", "audit_opc_package.py");
const fixtureBuilder = path.join(root, "tests", "fixtures", "make-opc-package.py");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

async function makeAndAudit(directory, mode) {
  const pptx = path.join(directory, `${mode}.pptx`);
  const reportPath = path.join(directory, `${mode}.json`);
  const built = run(python, [fixtureBuilder, pptx, "--mode", mode]);
  assert.equal(built.status, 0, built.stderr);
  const result = run(python, [auditor, pptx, "--json", reportPath]);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.deepEqual(JSON.parse(result.stdout), report);
  return { result, report };
}

test("generic repair-free OPC auditor accepts a complete deterministic PowerPoint package", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-opc-valid-"));
  const { result, report } = await makeAndAudit(directory, "valid");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.schemaVersion, "slidewright-repair-free-opc-audit/v1");
  assert.equal(report.valid, true);
  assert.ok(Object.values(report.checks).every(Boolean));
  assert.deepEqual(report.summary, {
    contentTypeDefaults: 2,
    contentTypeOverrides: 2,
    contentTypedNonRelationshipParts: 3,
    parts: 7,
    relationshipParts: 3,
    relationships: 3,
    xmlParts: 6,
  });
  assert.deepEqual(report.failures, []);
});

test("generic repair-free OPC auditor rejects package and relationship corruption", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-opc-negative-"));
  const cases = [
    ["corrupt-zip", "RF001"],
    ["crc-corrupt", "RF001"],
    ["duplicate-part", "RF002"],
    ["invalid-xml", "RF004"],
    ["orphan-owner", "RF005"],
    ["empty-id", "RF006"],
    ["duplicate-id", "RF006"],
    ["missing-target", "RF007"],
    ["dangling-reference", "RF008"],
    ["missing-content-type", "RF009"],
  ];
  for (const [mode, expectedCode] of cases) {
    await t.test(mode, async () => {
      const { result, report } = await makeAndAudit(directory, mode);
      assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
      assert.equal(report.valid, false);
      assert.ok(report.failures.some((item) => item.code === expectedCode), `${mode}: ${JSON.stringify(report.failures)}`);
    });
  }
});
