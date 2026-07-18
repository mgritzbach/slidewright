import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("C02 CLI proof binds a public installed skill and remains explicitly partial", () => {
  const evidenceRoot = path.join(root, "evidence", "c02", "v1");
  const proof = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "cli-client-proof.json"), "utf8"));
  const result = fs.readFileSync(path.join(evidenceRoot, proof.probe.resultFile));
  const complaint = fs.readFileSync(path.join(root, "plugins", "slidewright", "skills", "slidewright", "references", "complaint-contract.md"));

  assert.equal(proof.schemaVersion, "slidewright-c02-client-proof/v1");
  assert.equal(proof.valid, true);
  assert.equal(proof.surface, "codex-cli");
  assert.match(proof.sourceCommit, /^[a-f0-9]{40}$/u);
  assert.equal(proof.client.exitCode, 0);
  assert.equal(proof.installation.validatorPassed, true);
  assert.equal(proof.installation.cleanWorkspaceBootstrapPassed, true);
  assert.equal(proof.installation.cleanWorkspacePreflightPassed, true);
  assert.equal(proof.installation.requiredCapabilityFailures, 0);
  assert.match(proof.installation.installedSkillNormalizedSha256, /^[a-f0-9]{64}$/u);
  assert.equal(sha256(complaint), proof.probe.referenceSha256);
  assert.equal(sha256(result), proof.probe.resultFileSha256);
  assert.equal(result.toString("utf8").trim(), [
    "skill_name=slidewright",
    "first_workflow_step=Define the communication job in one sentence: audience, intended outcome, and central takeaway.",
    `complaint_contract_sha256=${proof.probe.referenceSha256}`,
  ].join("\n"));
  assert.ok(proof.limitations.some((item) => item.includes("Desktop") && item.includes("VS Code")));
});
