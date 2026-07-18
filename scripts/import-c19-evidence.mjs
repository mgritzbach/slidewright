#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  C19_REQUIRED_SUITES,
  canonicalHash,
  contractWithHash,
  implementationClosure,
  matrixArtifactNames,
  receiptForBytes,
  runC19DestructiveControls,
  sha256,
  validateC19SuiteEvidence,
  verifyPublishedC19Evidence,
} from "./lib/c19-interop-evidence.mjs";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function readArtifacts(file) {
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.artifacts;
}

async function writeAtomic(file, contents) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, contents);
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

export async function importC19Evidence({ root, input, artifactsFile, runId, sourceCommit, repository, published = path.join(root, "evidence", "c19", "v1"), enforceCheckout = true }) {
  invariant(/^\d+$/u.test(`${runId}`) && /^[a-f0-9]{40}$/u.test(sourceCommit ?? "")
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? ""), "C19 import attribution is invalid.");
  if (enforceCheckout) {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", windowsHide: true });
    invariant(head.status === 0 && head.stdout.trim() === sourceCommit, "C19 import checkout is not the exact source commit.");
    invariant(status.status === 0 && status.stdout.trim() === "", "C19 import requires a clean source checkout before publication.");
  }
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;
  const { contract, hash: contractHash } = await contractWithHash(root);
  const expectedNames = matrixArtifactNames(sourceCommit);
  const artifactValues = await readArtifacts(artifactsFile);
  const selected = (artifactValues ?? []).filter((item) => expectedNames.includes(item.name)).map((item) => ({
    id: item.id,
    name: item.name,
    sizeInBytes: item.size_in_bytes ?? item.sizeInBytes,
    digest: item.digest,
  })).sort((left, right) => left.name.localeCompare(right.name));
  invariant(selected.length === expectedNames.length && JSON.stringify(selected.map((item) => item.name)) === JSON.stringify(expectedNames)
    && selected.every((item) => Number.isInteger(item.id) && item.id > 0 && Number.isInteger(item.sizeInBytes) && item.sizeInBytes > 0
      && /^sha256:[a-f0-9]{64}$/u.test(item.digest ?? "")), "C19 GitHub artifact metadata is missing, duplicated, or unauthenticated.");

  const evidenceBySuite = new Map();
  for (const suiteId of C19_REQUIRED_SUITES) {
    const artifactName = `slidewright-c19-${suiteId}-${sourceCommit}`;
    const bundleRoot = path.join(input, artifactName);
    const evidencePath = path.join(bundleRoot, "suite-evidence.json");
    let bytes;
    try { bytes = await fs.readFile(evidencePath); }
    catch (error) { throw new Error(`${suiteId}: downloaded suite artifact is missing suite-evidence.json (${error.message}).`); }
    const evidence = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, ""));
    invariant(evidence.suiteId === suiteId, `${suiteId}: downloaded artifact contains evidence for ${evidence.suiteId ?? "<missing>"}.`);
    const verified = await validateC19SuiteEvidence(evidence, {
      contract,
      contractHash,
      expectedSourceCommit: sourceCommit,
      expectedRepository: repository,
      bundleRoot,
      verifyArtifactBodies: true,
    });
    const controls = await runC19DestructiveControls(evidence, { contract, contractHash, expectedSourceCommit: sourceCommit, expectedRepository: repository });
    evidenceBySuite.set(suiteId, { bytes, evidence, verified, controls });
  }
  const sourceDeckHashes = new Set([...evidenceBySuite.values()].map((item) => item.verified.sourceDeckSha256));
  invariant(sourceDeckHashes.size === 1, "C19 requires all six suites to exercise one exact source deck SHA-256.");
  const sourceInventoryHashes = new Set([...evidenceBySuite.values()].map((item) => item.evidence.semantic.sourceInventoryHash));
  invariant(sourceInventoryHashes.size === 1, "C19 requires all six suites to use one exact source semantic inventory.");

  const closure = await implementationClosure(root);
  const suites = C19_REQUIRED_SUITES.map((id) => {
    const item = evidenceBySuite.get(id);
    return {
      id,
      application: item.evidence.application.name,
      applicationVersion: item.evidence.application.version,
      automationMode: item.evidence.automation.mode,
      sourceDeckSha256: item.verified.sourceDeckSha256,
      evidenceSha256: sha256(item.bytes),
      receipts: item.verified.receipts,
      advancedOutcomes: Object.fromEntries(item.evidence.semantic.advancedChecks.map((check) => [check.id, check.outcome])),
      destructiveControls: item.controls,
    };
  });
  const scorecard = {
    schemaVersion: "slidewright-c19-matrix-scorecard/v1",
    valid: true,
    allRequiredSuitesVerified: true,
    contractHash,
    repository,
    sourceCommit,
    sourceTreeClean: true,
    runId: `${runId}`,
    runUrl,
    sourceDeckSha256: [...sourceDeckHashes][0],
    sourceInventoryHash: [...sourceInventoryHashes][0],
    artifactBodiesVerifiedAtImport: true,
    artifactBodiesCommitted: false,
    artifacts: selected,
    suites,
    artifactReceiptCount: suites.reduce((sum, item) => sum + item.receipts, 0),
    implementationClosure: closure,
    implementationClosureHash: canonicalHash(closure),
  };
  scorecard.scorecardHash = canonicalHash(scorecard, "scorecardHash");

  await fs.mkdir(path.join(published, "runs"), { recursive: true });
  const staging = path.join(published, `.staging-${process.pid}-${Date.now()}`);
  const finalRun = path.join(published, "runs", scorecard.scorecardHash);
  await fs.mkdir(path.join(staging, "suites"), { recursive: true });
  try {
    await fs.writeFile(path.join(staging, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
    for (const suiteId of C19_REQUIRED_SUITES) await fs.writeFile(path.join(staging, "suites", `${suiteId}.json`), evidenceBySuite.get(suiteId).bytes);
    try { await fs.rename(staging, finalRun); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
      const existing = await fs.readFile(path.join(finalRun, "scorecard.json"));
      invariant(sha256(existing) === sha256(await fs.readFile(path.join(staging, "scorecard.json"))), "C19 immutable run key already exists with different bytes.");
      await fs.rm(staging, { recursive: true, force: true });
    }
    const runRelative = `runs/${scorecard.scorecardHash}`;
    const scorecardBytes = await fs.readFile(path.join(finalRun, "scorecard.json"));
    const suiteReceipts = [];
    for (const suiteId of C19_REQUIRED_SUITES) {
      const bytes = await fs.readFile(path.join(finalRun, "suites", `${suiteId}.json`));
      suiteReceipts.push(receiptForBytes(`${runRelative}/suites/${suiteId}.json`, bytes));
    }
    const pointer = {
      schemaVersion: "slidewright-c19-current/v1",
      valid: true,
      state: "replicated",
      scorecardHash: scorecard.scorecardHash,
      run: runRelative,
      contractHash,
      repository,
      sourceCommit,
      runId: `${runId}`,
      runUrl,
      files: {
        scorecard: receiptForBytes(`${runRelative}/scorecard.json`, scorecardBytes),
        suites: suiteReceipts,
      },
    };
    pointer.pointerHash = canonicalHash(pointer, "pointerHash");
    await writeAtomic(path.join(published, "current.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    return await verifyPublishedC19Evidence({ root, published });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const result = await importC19Evidence({
    root,
    input: path.resolve(argument("--input")),
    artifactsFile: path.resolve(argument("--artifacts")),
    runId: argument("--run-id"),
    sourceCommit: argument("--source-commit"),
    repository: argument("--repository"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
