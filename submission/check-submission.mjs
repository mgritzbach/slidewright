#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function externalFailures(metadata) {
  const failures = [];
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(metadata.repositoryUrl || "")) failures.push("verified GitHub repository URL is missing");
  if (!/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(metadata.youtube?.url || "")) failures.push("public YouTube URL is missing");
  if (!(Number(metadata.youtube?.durationSeconds) > 0 && Number(metadata.youtube.durationSeconds) < 180)) failures.push("video duration must be verified below 180 seconds");
  if (metadata.youtube?.audioConfirmed !== true) failures.push("video audio is not confirmed");
  if (!/^[A-Za-z0-9_-]{8,}$/.test(metadata.feedbackSessionId || "")) failures.push("primary /feedback session ID is missing");
  if (metadata.gpt56UsageVerified !== true || String(metadata.gpt56UsageStatement || "").trim().length < 20) failures.push("GPT-5.6 usage statement is not verified");
  if (metadata.joinedDevpost !== true) failures.push("Devpost participation is not confirmed");
  if (!/^\d+$/.test(String(metadata.devpostSubmissionId || ""))) failures.push("Devpost submission ID is missing");
  if (metadata.devpostSubmitted !== true) failures.push("Devpost project is not submitted");
  if (!/^https:\/\/devpost\.com\/software\/[^/]+\/?$/.test(metadata.devpostProjectUrl || "")) failures.push("public Devpost project URL is missing");
  if (metadata.judgeAccessConfirmed !== true) failures.push("judge repository access is not confirmed");
  return failures;
}

export function publicationEvidenceFailures(metadata, evidence) {
  const failures = [];
  if (evidence?.schemaVersion !== "slidewright-build-week-publication-evidence/v1") failures.push("publication evidence schema is invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(String(evidence?.verifiedAt || ""))
      || Number.isNaN(Date.parse(evidence?.verifiedAt))) failures.push("publication evidence verification time is invalid");
  if (evidence?.repository?.url !== metadata.repositoryUrl || evidence?.repository?.visibility !== "public") failures.push("publication evidence repository does not match the verified public repository");
  if (evidence?.youtube?.url !== metadata.youtube?.url) failures.push("publication evidence YouTube URL does not match metadata");
  const videoId = /^https:\/\/youtu\.be\/([A-Za-z0-9_-]+)\/?$/.exec(String(evidence?.youtube?.url || ""))?.[1];
  if (!videoId || evidence?.youtube?.videoId !== videoId) failures.push("publication evidence YouTube ID is invalid");
  if (Number(evidence?.youtube?.durationSeconds) !== Number(metadata.youtube?.durationSeconds)) failures.push("publication evidence video duration does not match metadata");
  if (evidence?.youtube?.visibility !== "public" || evidence?.youtube?.publicationConfirmation !== "Video published") failures.push("publication evidence does not confirm a public video");
  if (!/^\d+x\d+$/.test(String(evidence?.youtube?.resolution || "")) || !String(evidence?.youtube?.audio || "").trim()) failures.push("publication evidence video media details are incomplete");
  if (String(evidence?.devpost?.submissionId || "") !== String(metadata.devpostSubmissionId || "")
      || evidence?.devpost?.projectUrl !== metadata.devpostProjectUrl) failures.push("publication evidence Devpost identifiers do not match metadata");
  if (evidence?.devpost?.status !== "submitted" || evidence?.devpost?.confirmation !== "Project submitted!") failures.push("publication evidence does not confirm Devpost submission");
  if (evidence?.feedbackSessionId !== metadata.feedbackSessionId) failures.push("publication evidence feedback session does not match metadata");
  return failures;
}

const expectedScreenshots = [
  "01-independent-reference.png",
  "02-editable-reconstruction.png",
  "03-horizontal-native-design.png",
  "04-template-before.png",
  "05-template-after.png",
  "06-powerpoint-roundtrip.png",
];

export function assetBundleFailures(root) {
  const failures = [];
  const bundleRoot = path.join(root, "outputs", "submission");
  const manifestPath = path.join(bundleRoot, "asset-manifest.json");
  if (!fs.existsSync(manifestPath)) return ["missing local asset: outputs/submission/asset-manifest.json"];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return ["submission asset manifest is not valid JSON"];
  }
  if (manifest.valid !== true || !Array.isArray(manifest.assets)) return ["submission asset manifest structure is invalid"];
  const expectedPaths = expectedScreenshots.map((name) => `screenshots/${name}`).sort();
  const actualPaths = manifest.assets.map((asset) => String(asset.file || "").replaceAll("\\", "/")).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) failures.push("submission asset manifest must contain the exact six screenshot paths");
  for (const asset of manifest.assets) {
    const candidate = path.resolve(bundleRoot, String(asset.file || ""));
    if (!candidate.startsWith(`${path.resolve(bundleRoot)}${path.sep}`)) {
      failures.push(`submission asset path escapes bundle: ${asset.file}`);
      continue;
    }
    if (!fs.existsSync(candidate)) {
      failures.push(`missing submission screenshot: ${asset.file}`);
      continue;
    }
    const content = fs.readFileSync(candidate);
    if (content.length !== Number(asset.bytes)) failures.push(`submission screenshot byte count changed: ${asset.file}`);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (hash !== asset.sha256) failures.push(`submission screenshot SHA-256 changed: ${asset.file}`);
  }
  return failures;
}

export function runSubmissionCheck({ root, localOnly }) {
  const requiredFiles = [
    "README.md",
    "LICENSE",
    "submission/SUBMISSION_COPY.md",
    "submission/DEMO_SCRIPT.md",
    "submission/TESTING.md",
    "submission/ASSET_MANIFEST.md",
  ];
  const failures = [];
  for (const file of requiredFiles) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute) || fs.statSync(absolute).size === 0) failures.push(`missing local asset: ${file}`);
  }
  failures.push(...assetBundleFailures(root));

  const metadata = JSON.parse(fs.readFileSync(path.join(root, "submission", "metadata.json"), "utf8"));
  if (!localOnly) {
    failures.push(...externalFailures(metadata));
    const evidencePath = path.join(root, "submission", "publication-evidence.json");
    if (!fs.existsSync(evidencePath)) {
      failures.push("publication evidence is missing");
    } else {
      try {
        failures.push(...publicationEvidenceFailures(metadata, JSON.parse(fs.readFileSync(evidencePath, "utf8"))));
      } catch {
        failures.push("publication evidence is not valid JSON");
      }
    }
    const copy = fs.readFileSync(path.join(root, "submission", "SUBMISSION_COPY.md"), "utf8");
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const statement = String(metadata.gpt56UsageStatement || "").trim();
    if (copy.includes("[[GPT56_USAGE_STATEMENT]]") || copy.includes("[[FEEDBACK_SESSION_ID]]")) failures.push("submission copy still contains unresolved verification tokens");
    if (statement && !copy.includes(statement)) failures.push("verified GPT-5.6 usage statement is not present in submission copy");
    if (metadata.feedbackSessionId && !copy.includes(metadata.feedbackSessionId)) failures.push("verified /feedback session ID is not present in submission copy");
    if (statement && !readme.includes(statement)) failures.push("verified GPT-5.6 usage statement is not present in README");
    if (metadata.feedbackSessionId && !readme.includes(metadata.feedbackSessionId)) failures.push("verified /feedback session ID is not present in README");
  }
  return { valid: failures.length === 0, mode: localOnly ? "local-only" : "full", failures };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const result = runSubmissionCheck({
    root: path.resolve(path.dirname(scriptPath), ".."),
    localOnly: process.argv.includes("--local-only"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.valid ? 0 : 1;
}
