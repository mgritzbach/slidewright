import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicScorecard, contentHash, rejectMachineSpecificContent, sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : null;
const portableSourceOnly = process.argv.includes("--portable-source");
const manifestPath = path.join(root, "evidence", "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

if (manifest.schemaVersion !== "slidewright-public-evidence-manifest/v1" || manifest.valid !== true) {
  throw new Error("Public evidence manifest schema or validity is incorrect.");
}
if (manifest.manifestHash !== contentHash(manifest, "manifestHash")) throw new Error("Public evidence manifest hash mismatch.");
if (!Array.isArray(manifest.entries) || manifest.entries.length < 3) throw new Error("At least three public scorecards are required.");

const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const verified = [];
for (const entry of manifest.entries) {
  const scorecardPath = path.join(root, "evidence", entry.file);
  const bytes = await fs.readFile(scorecardPath);
  if (sha256(bytes) !== entry.fileSha256) throw new Error(`${entry.id}: file SHA-256 mismatch.`);
  const published = JSON.parse(bytes.toString("utf8"));
  if (published.schemaVersion !== "slidewright-public-scorecard/v1" || published.suiteId !== entry.id || published.valid !== true) {
    throw new Error(`${entry.id}: published wrapper is invalid.`);
  }
  if (published.publishedHash !== entry.publishedHash || published.publishedHash !== contentHash(published, "publishedHash")) {
    throw new Error(`${entry.id}: published content hash mismatch.`);
  }
  rejectMachineSpecificContent(entry.id, published);
  assertPublicScorecard(entry.id, published.scorecard);
  const currentOutput = path.join(root, entry.sourceOutput || "");
  try {
    const currentBytes = await fs.readFile(currentOutput);
    if (sha256(currentBytes) !== published.sourceScorecardSha256) {
      throw new Error(`${entry.id}: current generated scorecard differs from the published release fixture; run npm run evidence:publish after a complete release check.`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const scriptName = entry.command.replace(/^npm run\s+/, "");
  if (!packageJson.scripts?.[scriptName]) throw new Error(`${entry.id}: command ${entry.command} is not declared in package.json.`);
  verified.push({ id: entry.id, publishedHash: entry.publishedHash, command: entry.command });
}

const releaseState = JSON.parse(await fs.readFile(path.join(root, "evidence", "release-state.json"), "utf8"));
if (releaseState.schemaVersion !== "slidewright-public-evidence-release-state/v1"
  || !["candidate", "replicated"].includes(releaseState.state)
  || releaseState.manifestHash !== manifest.manifestHash
  || releaseState.stateHash !== contentHash(releaseState, "stateHash")) {
  throw new Error("Public evidence release state is invalid, stale, or unauthenticated.");
}

if (portableSourceOnly) {
  const result = {
    schemaVersion: "slidewright-public-evidence-verification/v1",
    valid: true,
    verificationScope: "portable-source",
    releaseState: releaseState.state,
    manifestHash: manifest.manifestHash,
    scorecards: verified,
    freshHostReplication: null,
  };
  if (out) {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

if (releaseState.state !== "replicated") {
  throw new Error(`Public evidence manifest ${manifest.manifestHash} is a candidate and lacks committed cross-platform replication.`);
}

const c22Root = path.join(root, "evidence", "c22", "v1");
const artifactManifest = JSON.parse(await fs.readFile(path.join(c22Root, "artifact-manifest.json"), "utf8"));
if (artifactManifest.schemaVersion !== "slidewright-c22-artifact-manifest/v1" || artifactManifest.valid !== true) {
  throw new Error("C22 artifact manifest schema or validity is incorrect.");
}
if (artifactManifest.manifestHash !== contentHash(artifactManifest, "manifestHash")) throw new Error("C22 artifact manifest hash mismatch.");
if (artifactManifest.artifacts?.length !== 3 || !artifactManifest.artifacts.every((item) => /^sha256:[a-f0-9]{64}$/.test(item.digest))) {
  throw new Error("C22 must bind exactly three GitHub artifacts to SHA-256 digests.");
}
for (const file of artifactManifest.files || []) {
  const bytes = await fs.readFile(path.join(root, "evidence", file.path));
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`C22 file integrity mismatch: ${file.path}.`);
}
const linux = JSON.parse(await fs.readFile(path.join(c22Root, "linux-fresh-host-scorecard.json"), "utf8"));
const windows = JSON.parse(await fs.readFile(path.join(c22Root, "windows-fresh-host-scorecard.json"), "utf8"));
const aggregate = JSON.parse(await fs.readFile(path.join(c22Root, "aggregate-scorecard.json"), "utf8"));
for (const item of [linux, windows]) {
  if (item.valid !== true || item.environment?.gitSha !== artifactManifest.sourceCommit) throw new Error("C22 host scorecard validity or commit mismatch.");
  if (item.scorecardHash !== contentHash(item, "scorecardHash")) throw new Error("C22 host scorecard content hash mismatch.");
  if (item.portableResultHash !== contentHash(item.portableResult, "unused")) throw new Error("C22 portable result hash mismatch.");
}
if (aggregate.valid !== true || aggregate.aggregateHash !== contentHash(aggregate, "aggregateHash")) throw new Error("C22 aggregate scorecard is invalid.");
if (aggregate.gitSha !== artifactManifest.sourceCommit || aggregate.runId !== artifactManifest.runId || aggregate.runUrl !== artifactManifest.runUrl) {
  throw new Error("C22 aggregate attribution mismatch.");
}
if (aggregate.manifestHash !== manifest.manifestHash || aggregate.portableResultHash !== linux.portableResultHash || aggregate.portableResultHash !== windows.portableResultHash) {
  throw new Error("C22 cross-platform result or evidence manifest mismatch.");
}

const result = {
  schemaVersion: "slidewright-public-evidence-verification/v1",
  valid: true,
  verificationScope: "release",
  releaseState: releaseState.state,
  manifestHash: manifest.manifestHash,
  scorecards: verified,
  freshHostReplication: {
    valid: true,
    runId: artifactManifest.runId,
    runUrl: artifactManifest.runUrl,
    sourceCommit: artifactManifest.sourceCommit,
    artifactManifestHash: artifactManifest.manifestHash,
    aggregateHash: aggregate.aggregateHash,
    portableResultHash: aggregate.portableResultHash,
    platforms: aggregate.platforms.map((item) => item.platform),
  },
};
if (out) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
