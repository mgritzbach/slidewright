#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  C19_REQUIRED_SUITES,
  canonicalHash,
  contractWithHash,
  runC19DestructiveControls,
  sha256,
  validateC19SuiteEvidence,
  verifyPublishedC19Evidence,
} from "./lib/c19-interop-evidence.mjs";

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function command(name, args = ["--version"]) {
  const result = spawnSync(name, args, { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/u)[0] : null;
}

function capabilityStatus() {
  const platform = process.platform;
  const powerpointPath = platform === "win32"
    ? "C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE"
    : "/Applications/Microsoft PowerPoint.app";
  const keynotePath = "/Applications/Keynote.app";
  const libreOfficeVersion = command(platform === "win32" ? "soffice.exe" : "soffice");
  return [
    { id: "powerpoint-windows", callable: platform === "win32" && command("powershell", ["-NoProfile", "-Command", `(Test-Path '${powerpointPath.replaceAll("'", "''")}')`]) === "True", evidence: false, reason: platform === "win32" ? "Application detected; a clean-commit COM suite run is still required." : "Requires a Windows suite host." },
    { id: "powerpoint-macos", callable: platform === "darwin" && command("test", ["-d", powerpointPath]) !== null, evidence: false, reason: "Requires a clean-commit macOS AppleScript suite run." },
    { id: "google-slides", callable: false, evidence: false, reason: "Requires an authenticated browser-automation import/edit/export job; URL access alone is not evidence." },
    { id: "keynote-macos", callable: platform === "darwin" && command("test", ["-d", keynotePath]) !== null, evidence: false, reason: "Requires a clean-commit macOS AppleScript suite run." },
    { id: "libreoffice", callable: Boolean(libreOfficeVersion), evidence: false, reason: libreOfficeVersion ? `Detected ${libreOfficeVersion}; a clean-commit UNO suite run is still required.` : "LibreOffice/soffice was not detected on this host." },
    { id: "canva", callable: false, evidence: false, reason: "Requires an authenticated browser-automation import/edit/export job; URL access alone is not evidence." },
  ];
}

const root = process.cwd();
const evidenceFile = value("--evidence");
const out = value("--out");
if (!evidenceFile) {
  let published = null;
  try { published = await verifyPublishedC19Evidence({ root }); } catch { /* pending is an expected state */ }
  const status = {
    schemaVersion: "slidewright-c19-status/v1",
    valid: published?.valid === true,
    host: { platform: os.platform(), architecture: os.arch() },
    requiredSuites: C19_REQUIRED_SUITES,
    capabilities: capabilityStatus(),
    published,
    warning: "Capability detection is not interoperability evidence. Only imported, artifact-bound suite-runner output can make C19 valid.",
  };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(status.valid ? 0 : 2);
}

const absoluteEvidence = path.resolve(evidenceFile);
const bundleRoot = path.dirname(absoluteEvidence);
const evidence = JSON.parse(await fs.readFile(absoluteEvidence, "utf8"));
const gitHead = command("git", ["rev-parse", "HEAD"]);
const gitStatus = command("git", ["status", "--porcelain"]);
if (!gitHead || gitStatus !== "") throw new Error("C19 suite validation requires an exact clean Git checkout.");
const { contract, hash: contractHash } = await contractWithHash(root);
const verified = await validateC19SuiteEvidence(evidence, {
  contract,
  contractHash,
  expectedSourceCommit: gitHead,
  expectedRepository: evidence.attribution?.repository,
  bundleRoot,
  verifyArtifactBodies: true,
});
const destructiveControls = await runC19DestructiveControls(evidence, {
  contract,
  contractHash,
  expectedSourceCommit: gitHead,
  expectedRepository: evidence.attribution.repository,
});
const result = {
  schemaVersion: "slidewright-c19-suite-validation/v1",
  valid: true,
  suiteId: verified.suiteId,
  sourceCommit: gitHead,
  sourceDeckSha256: verified.sourceDeckSha256,
  suiteEvidenceSha256: sha256(await fs.readFile(absoluteEvidence)),
  artifactReceiptsVerified: verified.receipts,
  destructiveControls,
};
result.validationHash = canonicalHash(result, "validationHash");
if (out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
