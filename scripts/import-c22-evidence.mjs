#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { contentHash, sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const value = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
};
const input = path.resolve(value("--input"));
const artifactsFile = path.resolve(value("--artifacts"));
const runId = value("--run-id");
const sourceCommit = value("--source-commit");
const repository = value("--repository");
if (!/^\d+$/u.test(runId) || !/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  throw new Error("C22 import attribution is invalid.");
}
const runUrl = `https://github.com/${repository}/actions/runs/${runId}`;

async function walk(directory) {
  const found = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(target));
    else if (entry.isFile()) found.push(target);
  }
  return found;
}

const files = await walk(input);
const named = (name) => files.filter((file) => path.basename(file) === name);
const hosts = named("fresh-host-scorecard.json");
const aggregateFiles = named("aggregate-scorecard.json");
const reports = named("FRESH_MACHINE_REPLICATION.md");
if (hosts.length !== 2 || aggregateFiles.length !== 1 || reports.length !== 1) {
  throw new Error(`Expected two host scorecards, one aggregate, and one report; found ${hosts.length}/${aggregateFiles.length}/${reports.length}.`);
}
const hostValues = await Promise.all(hosts.map(async (file) => ({ file, value: JSON.parse(await fs.readFile(file, "utf8")) })));
const linux = hostValues.find((item) => item.value.environment?.platform?.toLowerCase() === "linux");
const windows = hostValues.find((item) => item.value.environment?.platform?.toLowerCase() === "windows");
if (!linux || !windows) throw new Error("C22 import requires Linux and Windows host scorecards.");
const aggregate = JSON.parse(await fs.readFile(aggregateFiles[0], "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "evidence", "manifest.json"), "utf8"));
for (const item of [linux.value, windows.value]) {
  if (item.valid !== true || item.environment?.gitSha !== sourceCommit || item.scorecardHash !== contentHash(item, "scorecardHash")
    || item.portableResultHash !== contentHash(item.portableResult, "unused")) throw new Error("C22 host scorecard is invalid or belongs to another commit.");
}
if (aggregate.valid !== true || aggregate.gitSha !== sourceCommit || `${aggregate.runId}` !== runId || aggregate.runUrl !== runUrl
  || aggregate.manifestHash !== manifest.manifestHash || aggregate.aggregateHash !== contentHash(aggregate, "aggregateHash")
  || aggregate.portableResultHash !== linux.value.portableResultHash || aggregate.portableResultHash !== windows.value.portableResultHash) {
  throw new Error("C22 aggregate is invalid, stale, or belongs to another run/manifest.");
}

const rawArtifacts = JSON.parse(await fs.readFile(artifactsFile, "utf8"));
const artifactValues = Array.isArray(rawArtifacts) ? rawArtifacts : rawArtifacts.artifacts;
const expectedNames = [
  `slidewright-public-evidence-Linux-${sourceCommit}`,
  `slidewright-public-evidence-Windows-${sourceCommit}`,
  `slidewright-cross-platform-replication-${sourceCommit}`,
].sort();
const selected = (artifactValues ?? []).filter((item) => expectedNames.includes(item.name)).map((item) => ({
  id: item.id,
  name: item.name,
  sizeInBytes: item.size_in_bytes ?? item.sizeInBytes,
  digest: item.digest,
})).sort((left, right) => left.name.localeCompare(right.name));
if (selected.length !== 3 || JSON.stringify(selected.map((item) => item.name)) !== JSON.stringify(expectedNames)
  || selected.some((item) => !Number.isInteger(item.id) || !Number.isInteger(item.sizeInBytes) || item.sizeInBytes < 1 || !/^sha256:[a-f0-9]{64}$/u.test(item.digest ?? ""))) {
  throw new Error("C22 GitHub artifact metadata is missing, duplicated, or unauthenticated.");
}

const c22 = path.join(root, "evidence", "c22", "v1");
const targets = [
  [linux.file, path.join(c22, "linux-fresh-host-scorecard.json")],
  [windows.file, path.join(c22, "windows-fresh-host-scorecard.json")],
  [aggregateFiles[0], path.join(c22, "aggregate-scorecard.json")],
  [reports[0], path.join(c22, "FRESH_MACHINE_REPLICATION.md")],
];
const artifactManifestPath = path.join(c22, "artifact-manifest.json");
const releaseStatePath = path.join(root, "evidence", "release-state.json");
const allTargets = [...targets.map((item) => item[1]), artifactManifestPath, releaseStatePath];
const backup = new Map();
for (const target of allTargets) {
  try { backup.set(target, await fs.readFile(target)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
try {
  await fs.mkdir(c22, { recursive: true });
  for (const [source, target] of targets) await fs.copyFile(source, target);
  const fileReceipts = [];
  for (const [, target] of targets) {
    const bytes = await fs.readFile(target);
    fileReceipts.push({ path: path.relative(path.join(root, "evidence"), target).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) });
  }
  const artifactManifest = {
    schemaVersion: "slidewright-c22-artifact-manifest/v1",
    valid: true,
    repository,
    runId,
    runUrl,
    sourceCommit,
    artifacts: selected,
    files: fileReceipts,
  };
  artifactManifest.manifestHash = contentHash(artifactManifest, "manifestHash");
  await fs.writeFile(artifactManifestPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, "utf8");
  const priorState = JSON.parse(backup.get(releaseStatePath)?.toString("utf8") ?? "{}");
  const releaseState = {
    schemaVersion: "slidewright-public-evidence-release-state/v1",
    state: "replicated",
    manifestHash: manifest.manifestHash,
    priorReplicatedManifestHash: priorState.priorReplicatedManifestHash ?? null,
    sourceCommit,
    runId,
    runUrl,
    artifactManifestHash: artifactManifest.manifestHash,
  };
  releaseState.stateHash = contentHash(releaseState, "stateHash");
  await fs.writeFile(releaseStatePath, `${JSON.stringify(releaseState, null, 2)}\n`, "utf8");
  const verified = spawnSync(process.execPath, ["scripts/verify-public-evidence.mjs"], { cwd: root, encoding: "utf8", shell: false });
  if (verified.status !== 0) throw new Error(verified.stderr || "C22 post-import verification failed.");
  process.stdout.write(verified.stdout);
} catch (error) {
  for (const target of allTargets) {
    if (backup.has(target)) await fs.writeFile(target, backup.get(target));
    else await fs.rm(target, { force: true });
  }
  throw error;
}
