#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultScorecard = path.join(root, "outputs", "font-integrity", "scorecard.json");
const EXPECTED_STYLES = ["regular", "bold", "italic", "boldItalic"];
const EXPECTED_MUTANTS = {
  "remove-embedded": "SWF123",
  "truncate-embedded": "SWF124",
  "substitute-visible": "SWF130",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isSha256(value) {
  return /^[0-9a-f]{64}$/u.test(String(value ?? ""));
}

function assertPassingAudit(audit, label) {
  invariant(audit?.valid === true, `${label} audit is not valid.`);
  invariant(audit.family === "Slidewright Fixture Sans", `${label} family identity changed.`);
  invariant(audit.licensedFixture?.valid === true, `${label} does not prove the licensed fixture.`);
  invariant(audit.licensedFixture.fonts?.length === 4, `${label} does not bind four licensed font files.`);
  for (const font of audit.licensedFixture.fonts) {
    invariant(font.sfnt?.fsType === 0, `${label} font ${font.file} is not installable-embedding licensed.`);
    invariant(font.sfnt?.families?.includes("Slidewright Fixture Sans"), `${label} font ${font.file} has the wrong family identity.`);
    invariant(isSha256(font.sha256), `${label} font ${font.file} lacks a SHA-256.`);
  }
  invariant(audit.embedding?.partCount === 4 && audit.embedding?.uniquePartHashes === 4, `${label} does not retain four distinct embedded font payloads.`);
  for (const style of EXPECTED_STYLES) {
    const embedded = audit.embedding.styles?.[style];
    invariant(embedded?.bytes >= 50_000 && isSha256(embedded.sha256), `${label} embedded ${style} payload is missing or implausible.`);
    invariant(audit.visibleText?.styleCounts?.[style] >= 1, `${label} lacks an explicit ${style} text run.`);
  }
  invariant(audit.visibleText?.slideCount === 2, `${label} slide count changed.`);
  invariant(audit.visibleText?.explicitTypefaceCount >= 20, `${label} has too few explicit visible font bindings.`);
  invariant(JSON.stringify(audit.visibleText?.typefaces) === JSON.stringify(["Slidewright Fixture Sans"]), `${label} contains an unexpected visible typeface.`);
  invariant(isSha256(audit.visibleText?.styleFingerprint), `${label} lacks a style fingerprint.`);
  invariant(audit.nativeStructure?.tableCount >= 1 && audit.nativeStructure?.groupCount >= 1, `${label} lost the native table or editable group.`);
  invariant(audit.nativeStructure?.requiredNamesFound?.length === 5, `${label} lost required named native objects.`);
  invariant(Array.isArray(audit.diagnostics) && audit.diagnostics.length === 0, `${label} has diagnostics.`);
}

export async function verifyFontIntegrityEvidence(scorecard, { repositoryRoot = root } = {}) {
  invariant(scorecard?.schemaVersion === 1, "Font-integrity scorecard schemaVersion must be 1.");
  invariant(scorecard.benchmarkId === "C11-font-integrity-v1", "Unexpected font-integrity benchmarkId.");
  invariant(scorecard.valid === true, "Font-integrity scorecard is not valid.");
  invariant(scorecard.family === "Slidewright Fixture Sans", "Font-integrity family identity changed.");

  const ppt = scorecard.powerPoint;
  invariant(ppt?.valid === true && ppt.application === "Microsoft PowerPoint", "A real Microsoft PowerPoint run is not proven.");
  invariant(ppt.cycles === 2 && ppt.embeddedSaveRequested === true, "Two embedding-enabled PowerPoint cycles are required.");
  invariant(Object.values(ppt.statesEqual ?? {}).length === 3 && Object.values(ppt.statesEqual).every((value) => value === true), "PowerPoint native font state changed across save/reopen boundaries.");
  invariant(new Set([ppt.sourceSha256, ppt.roundtrip1Sha256, ppt.roundtrip2Sha256]).size === 3, "PowerPoint round trips were not independently serialized.");
  for (const value of [ppt.sourceSha256, ppt.roundtrip1Sha256, ppt.roundtrip2Sha256, ppt.missingControlSha256]) invariant(isSha256(value), "PowerPoint report lacks an artifact SHA-256.");

  const audits = scorecard.audits;
  for (const label of ["source", "roundtrip1", "roundtrip2"]) assertPassingAudit(audits?.[label], label);
  const fingerprints = [audits.source, audits.roundtrip1, audits.roundtrip2].map((audit) => audit.visibleText.styleFingerprint);
  invariant(new Set(fingerprints).size === 1, "Native font/run/style fingerprint changed across PowerPoint round trips.");
  for (const style of EXPECTED_STYLES) {
    const payloadSizes = [audits.source, audits.roundtrip1, audits.roundtrip2].map((audit) => audit.embedding.styles[style].bytes);
    invariant(new Set(payloadSizes).size === 1, `Embedded ${style} payload size changed across PowerPoint round trips.`);
  }

  invariant(audits.missingFontControl?.valid === false, "Actual PowerPoint missing-font control was accepted.");
  invariant(audits.missingFontControl?.diagnostics?.some((item) => item.ruleId === "SWF130" && /unexpected or substituted font family/u.test(item.message)), "Missing-font control lacks a visible substitution diagnostic.");
  const fontAuditControl = scorecard.fontAuditControl;
  invariant(fontAuditControl?.valid === false && fontAuditControl.substitutionApplied === false, "Slidewright silently substituted the missing font control.");
  invariant(fontAuditControl?.diagnostics?.some((item) => item.ruleId === "SWF001" && /Rendering is blocked/u.test(item.message)), "Slidewright missing-font control lacks SWF001 render-blocking evidence.");

  invariant(scorecard.destructiveControls?.length === 3, "Exactly three destructive PPTX controls are required.");
  for (const [mode, ruleId] of Object.entries(EXPECTED_MUTANTS)) {
    const control = scorecard.destructiveControls.find((item) => item.mode === mode);
    invariant(control?.audit?.valid === false, `Destructive control ${mode} was accepted.`);
    invariant(control.audit.diagnostics?.some((item) => item.ruleId === ruleId), `Destructive control ${mode} lacks ${ruleId}.`);
  }

  invariant(scorecard.renderProof?.states?.length === 3 && scorecard.renderProof?.slidesPerState === 2, "Render proof must cover all six source/round-trip slides.");
  for (const slide of [1, 2]) {
    const hashes = scorecard.renderProof.states.map((state) => state.slides.find((item) => item.slide === slide)?.sha256);
    invariant(hashes.every(isSha256) && new Set(hashes).size === 1, `Rendered slide ${slide} changed across PowerPoint round trips.`);
  }
  invariant(scorecard.renderProof.overflowChecks === 3, "All three PPTX states require slide-boundary checks.");
  const review = scorecard.fullSizeReview;
  invariant(review?.schemaVersion === 1 && review.benchmarkId === "C11-font-integrity-v1" && review.result === "pass", "Bound full-size review is missing or did not pass.");
  invariant(JSON.stringify(review.statesCovered) === JSON.stringify(["source", "roundtrip1", "roundtrip2"]), "Full-size review does not cover all PowerPoint states.");
  invariant(review.slides?.length === 2 && review.slides.every((slide) => slide.passed === true && typeof slide.observations === "string" && slide.observations.length > 40), "Every unique rendered slide requires a substantive full-size review.");
  for (const reviewed of review.slides) {
    const renderedHashes = scorecard.renderProof.states.map((state) => state.slides.find((item) => item.slide === reviewed.slide)?.sha256);
    invariant(renderedHashes.every((value) => value === reviewed.sha256), `Full-size review hash does not cover rendered slide ${reviewed.slide}.`);
  }

  invariant(Array.isArray(scorecard.artifacts) && scorecard.artifacts.length >= 18, "Font-integrity evidence does not bind enough artifacts.");
  for (const artifact of scorecard.artifacts) {
    invariant(typeof artifact.path === "string" && !path.isAbsolute(artifact.path), `Artifact path must be repository-relative: ${artifact.path}`);
    invariant(isSha256(artifact.sha256), `Artifact lacks SHA-256: ${artifact.path}`);
    const absolute = path.resolve(repositoryRoot, artifact.path);
    invariant(absolute.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`), `Artifact escapes repository root: ${artifact.path}`);
    const actual = sha256(await fs.readFile(absolute));
    invariant(actual === artifact.sha256, `Artifact hash mismatch: ${artifact.path}`);
  }
  invariant(isSha256(scorecard.implementationClosureSha256), "Implementation closure hash is missing.");
  const implementationRecords = scorecard.artifacts.filter((item) => item.kind === "implementation").map(({ path: itemPath, sha256: itemSha }) => ({ path: itemPath, sha256: itemSha }));
  const actualClosure = sha256(Buffer.from(JSON.stringify(implementationRecords)));
  invariant(actualClosure === scorecard.implementationClosureSha256, "Implementation closure hash does not match bound implementation files.");
  return true;
}

async function main() {
  const scorecardPath = path.resolve(process.argv[2] ?? defaultScorecard);
  const scorecard = JSON.parse(await fs.readFile(scorecardPath, "utf8"));
  await verifyFontIntegrityEvidence(scorecard);
  process.stdout.write(`Font-integrity evidence verified: ${scorecardPath}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
