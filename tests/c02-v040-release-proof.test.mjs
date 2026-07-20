import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(root, "evidence", "c02", "v2");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizeText = (value) => value.replace(/\r\n?/gu, "\n");
const isSha256 = (value) => /^[a-f0-9]{64}$/u.test(value ?? "");
const isGitSha = (value) => /^[a-f0-9]{40}$/u.test(value ?? "");

test("C02 v0.4.0 CLI proof credits only directly observed public skill use", () => {
  const proof = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "cli-client-proof.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", "slidewright", ".codex-plugin", "plugin.json"), "utf8"));
  const skill = fs.readFileSync(path.join(root, "plugins", "slidewright", "skills", "slidewright", "SKILL.md"), "utf8");
  const complaint = fs.readFileSync(path.join(root, "plugins", "slidewright", "skills", "slidewright", "references", "complaint-contract.md"));

  assert.equal(proof.schemaVersion, "slidewright-c02-cli-proof/v2");
  assert.equal(proof.valid, true);
  assert.equal(proof.surface, "codex-cli");
  assert.equal(proof.source.version, manifest.version);
  assert.equal(proof.source.tag, `v${manifest.version}`);
  assert.ok(isGitSha(proof.source.commit));
  assert.equal(proof.installation.bytesMatchPublicSource, true);
  assert.equal(proof.installation.installedSkillNormalizedSha256, sha256(normalizeText(skill)));
  assert.equal(proof.installation.publicSourceNormalizedSha256, sha256(normalizeText(skill)));
  assert.equal(proof.probe.explicitSkillInvocation, "$slidewright");
  assert.equal(proof.probe.selectionAcknowledged, true);
  assert.equal(proof.probe.installedReferenceRead, "references/complaint-contract.md");
  assert.equal(proof.probe.installedReferenceReadExitCode, 0);
  assert.equal(proof.probe.installedReferenceSha256, sha256(complaint));
  assert.ok(isSha256(proof.probe.rawClientOutputSha256));
  assert.ok(isSha256(proof.probe.lastMessageSha256));
  assert.equal(proof.probe.requestedExactDiagnosticResponseObserved, false);
  assert.ok(proof.limitations.some((item) => item.includes("Desktop") && item.includes("VS Code")));
});

test("C02 v0.4.0 tag proof binds exact cross-platform artifacts without overstating primary clients", () => {
  const proof = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "tag-installation-proof.json"), "utf8"));
  const contract = JSON.parse(fs.readFileSync(path.join(root, "evidence", "install-contract.json"), "utf8"));

  assert.equal(proof.schemaVersion, "slidewright-c02-tag-installation-proof/v1");
  assert.equal(proof.valid, true);
  assert.equal(proof.version, contract.pluginVersion);
  assert.equal(proof.tag, `v${contract.pluginVersion}`);
  assert.ok(isGitSha(proof.commit));
  assert.equal(proof.workflow.conclusion, "success");
  assert.equal(proof.workflow.headBranch, proof.tag);
  assert.equal(proof.aggregate.gitSha, proof.commit);
  assert.deepEqual(proof.aggregate.platforms, [...contract.requiredHostPlatforms].sort());
  assert.deepEqual(proof.aggregate.surfaces, contract.requiredSurfaces);
  assert.equal(proof.aggregate.codexPackage, contract.codexPackage);
  assert.equal(proof.aggregate.codexVersion, contract.codexVersion);
  assert.ok(isSha256(proof.aggregate.pluginTreeHash));
  assert.ok(isSha256(proof.aggregate.contractHash));
  assert.ok(isSha256(proof.aggregate.implementationHash));
  assert.ok(isSha256(proof.aggregate.aggregateHash));
  assert.equal(proof.independentVerification.downloadedAllThreeHostArtifacts, true);
  assert.equal(proof.independentVerification.rawCommandLogsVerified, contract.requiredHostPlatforms.length * contract.requiredCommands.length * 2);
  assert.equal(proof.independentVerification.reaggregatedOnExactCheckout, true);
  assert.equal(proof.independentVerification.locallyRecomputedAggregateHash, proof.aggregate.aggregateHash);
  assert.equal(proof.independentVerification.matchesCiAggregate, true);
  assert.equal(proof.artifactArchives.length, 4);
  assert.ok(proof.artifactArchives.every((artifact) => /^\d+$/u.test(artifact.id) && /^sha256:[a-f0-9]{64}$/u.test(artifact.digest)));
  assert.ok(proof.limitations.some((item) => item.includes("C02 remains 0")));
});
