import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_SUITES, assertPublicScorecard, contentHash, rejectMachineSpecificContent, sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "evidence", "scorecards", "v1");
await fs.mkdir(output, { recursive: true });

const entries = [];
for (const suite of PUBLIC_SUITES) {
  const sourcePath = path.join(root, suite.source);
  const scorecard = JSON.parse(await fs.readFile(sourcePath, "utf8"));
  assertPublicScorecard(suite.id, scorecard);
  rejectMachineSpecificContent(suite.id, scorecard);

  const published = {
    schemaVersion: "slidewright-public-scorecard/v1",
    suiteId: suite.id,
    valid: true,
    sourceCommand: suite.command,
    proofScope: suite.proofScope,
    limitations: suite.limitations,
    requiredEnvironment: suite.requires,
    sourceScorecardSha256: sha256(await fs.readFile(sourcePath)),
    scorecard,
  };
  published.publishedHash = contentHash(published, "publishedHash");
  const serialized = `${JSON.stringify(published, null, 2)}\n`;
  await fs.writeFile(path.join(output, suite.file), serialized, "utf8");
  entries.push({
    id: suite.id,
    file: `scorecards/v1/${suite.file}`,
    sourceOutput: suite.source,
    command: suite.command,
    publishedHash: published.publishedHash,
    fileSha256: sha256(serialized),
  });
}

const manifest = {
  schemaVersion: "slidewright-public-evidence-manifest/v1",
  valid: true,
  policy: {
    scorecardsAreCuratedReleaseFixtures: true,
    generatedOutputsRemainIgnored: true,
    exactCommandsRequired: true,
    destructiveControlsRequired: true,
    machineSpecificPathsForbidden: true,
  },
  portableVerificationCommand: "npm run evidence:verify",
  freshHostCommand: "npm run evidence:ci",
  entries,
};
manifest.manifestHash = contentHash(manifest, "manifestHash");
await fs.writeFile(path.join(root, "evidence", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
let replicatedManifestHash = null;
try {
  const aggregate = JSON.parse(await fs.readFile(path.join(root, "evidence", "c22", "v1", "aggregate-scorecard.json"), "utf8"));
  if (aggregate.valid === true) replicatedManifestHash = aggregate.manifestHash;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const releaseState = {
  schemaVersion: "slidewright-public-evidence-release-state/v1",
  state: replicatedManifestHash === manifest.manifestHash ? "replicated" : "candidate",
  manifestHash: manifest.manifestHash,
  priorReplicatedManifestHash: replicatedManifestHash,
};
releaseState.stateHash = contentHash(releaseState, "stateHash");
await fs.writeFile(path.join(root, "evidence", "release-state.json"), `${JSON.stringify(releaseState, null, 2)}\n`, "utf8");
process.stdout.write(`Published ${entries.length} versioned scorecards with manifest ${manifest.manifestHash}\n`);
