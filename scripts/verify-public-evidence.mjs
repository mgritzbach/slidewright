import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicScorecard, contentHash, rejectMachineSpecificContent, sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outIndex = process.argv.indexOf("--out");
const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : null;
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

const result = {
  schemaVersion: "slidewright-public-evidence-verification/v1",
  valid: true,
  manifestHash: manifest.manifestHash,
  scorecards: verified,
};
if (out) {
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
