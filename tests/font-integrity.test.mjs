import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyFontIntegrityEvidence } from "../scripts/verify-font-integrity-evidence.mjs";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function passingAudit(seed = "a") {
  const styles = Object.fromEntries(["regular", "bold", "italic", "boldItalic"].map((style, index) => [style, { bytes: 60_000 + index, sha256: hash(`${seed}-${style}`) }]));
  return {
    valid: true,
    family: "Slidewright Fixture Sans",
    licensedFixture: {
      valid: true,
      fonts: ["regular", "bold", "italic", "boldItalic"].map((style) => ({ file: `${style}.ttf`, sha256: hash(`fixture-${style}`), sfnt: { fsType: 0, families: ["Slidewright Fixture Sans"] } })),
    },
    embedding: { partCount: 4, uniquePartHashes: 4, styles },
    visibleText: { slideCount: 2, explicitTypefaceCount: 29, typefaces: ["Slidewright Fixture Sans"], styleCounts: { regular: 10, bold: 4, italic: 2, boldItalic: 1 }, styleFingerprint: hash("same-style-fingerprint") },
    nativeStructure: { tableCount: 1, groupCount: 1, requiredNamesFound: ["a", "b", "c", "d", "e"] },
    diagnostics: [],
  };
}

async function fixtureScorecard() {
  const repositoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-font-integrity-test-"));
  const artifacts = [];
  for (let index = 0; index < 18; index += 1) {
    const name = `artifact-${index}.bin`;
    const content = Buffer.from(`artifact-${index}`);
    await fs.writeFile(path.join(repositoryRoot, name), content);
    artifacts.push({ path: name, sha256: hash(content), kind: index < 4 ? "implementation" : "evidence" });
  }
  const implementationRecords = artifacts.filter((item) => item.kind === "implementation").map(({ path: itemPath, sha256 }) => ({ path: itemPath, sha256 }));
  const audit = passingAudit();
  const scorecard = {
    schemaVersion: 1,
    benchmarkId: "C11-font-integrity-v1",
    valid: true,
    family: "Slidewright Fixture Sans",
    powerPoint: {
      valid: true,
      application: "Microsoft PowerPoint",
      cycles: 2,
      embeddedSaveRequested: true,
      statesEqual: { sourceToFirstOpen: true, firstToSecondOpen: true, secondToFinalOpen: true },
      sourceSha256: hash("source"),
      roundtrip1Sha256: hash("roundtrip1"),
      roundtrip2Sha256: hash("roundtrip2"),
      missingControlSha256: hash("missing"),
    },
    audits: {
      source: structuredClone(audit),
      roundtrip1: structuredClone(audit),
      roundtrip2: structuredClone(audit),
      missingFontControl: { valid: false, diagnostics: [{ ruleId: "SWF130", message: "Visible slide text requests an unexpected or substituted font family." }] },
    },
    fontAuditControl: { valid: false, substitutionApplied: false, diagnostics: [{ ruleId: "SWF001", message: "Rendering is blocked to prevent silent substitution." }] },
    destructiveControls: [
      { mode: "remove-embedded", audit: { valid: false, diagnostics: [{ ruleId: "SWF123" }] } },
      { mode: "truncate-embedded", audit: { valid: false, diagnostics: [{ ruleId: "SWF124" }] } },
      { mode: "substitute-visible", audit: { valid: false, diagnostics: [{ ruleId: "SWF130" }] } },
    ],
    renderProof: {
      slidesPerState: 2,
      overflowChecks: 3,
      states: ["source", "roundtrip1", "roundtrip2"].map((state) => ({ state, slides: [{ slide: 1, sha256: hash("slide-1") }, { slide: 2, sha256: hash("slide-2") }] })),
    },
    fullSizeReview: {
      schemaVersion: 1,
      benchmarkId: "C11-font-integrity-v1",
      result: "pass",
      statesCovered: ["source", "roundtrip1", "roundtrip2"],
      slides: [
        { slide: 1, sha256: hash("slide-1"), passed: true, observations: "Full-size review found no overlap, clipping, or unintended wrapping on slide one." },
        { slide: 2, sha256: hash("slide-2"), passed: true, observations: "Full-size review found no overlap, clipping, or unintended wrapping on slide two." },
      ],
    },
    artifacts,
    implementationClosureSha256: hash(JSON.stringify(implementationRecords)),
  };
  return { repositoryRoot, scorecard };
}

test("C11 evidence verifier accepts a complete two-cycle licensed font proof", async (context) => {
  const { repositoryRoot, scorecard } = await fixtureScorecard();
  context.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  assert.equal(await verifyFontIntegrityEvidence(scorecard, { repositoryRoot }), true);
});

test("C11 evidence verifier rejects accepted substitution and missing-font controls", async (context) => {
  const { repositoryRoot, scorecard } = await fixtureScorecard();
  context.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  scorecard.audits.missingFontControl.valid = true;
  await assert.rejects(verifyFontIntegrityEvidence(scorecard, { repositoryRoot }), /missing-font control was accepted/u);
});

test("C11 evidence verifier rejects lost embedded styles and changed run fingerprints", async (context) => {
  const { repositoryRoot, scorecard } = await fixtureScorecard();
  context.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  scorecard.audits.roundtrip2.embedding.partCount = 3;
  await assert.rejects(verifyFontIntegrityEvidence(scorecard, { repositoryRoot }), /four distinct embedded font payloads/u);
  scorecard.audits.roundtrip2.embedding.partCount = 4;
  scorecard.audits.roundtrip2.visibleText.styleFingerprint = hash("changed");
  await assert.rejects(verifyFontIntegrityEvidence(scorecard, { repositoryRoot }), /fingerprint changed/u);
});

test("C11 evidence verifier rejects artifact tampering", async (context) => {
  const { repositoryRoot, scorecard } = await fixtureScorecard();
  context.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(repositoryRoot, scorecard.artifacts[6].path), "tampered");
  await assert.rejects(verifyFontIntegrityEvidence(scorecard, { repositoryRoot }), /Artifact hash mismatch/u);
});
