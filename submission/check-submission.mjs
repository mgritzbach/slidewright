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
  if (metadata.judgeAccessConfirmed !== true) failures.push("judge repository access is not confirmed");
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
    const copy = fs.readFileSync(path.join(root, "submission", "SUBMISSION_COPY.md"), "utf8");
    const statement = String(metadata.gpt56UsageStatement || "").trim();
    if (copy.includes("[[GPT56_USAGE_STATEMENT]]") || copy.includes("[[FEEDBACK_SESSION_ID]]")) failures.push("submission copy still contains unresolved verification tokens");
    if (statement && !copy.includes(statement)) failures.push("verified GPT-5.6 usage statement is not present in submission copy");
    if (metadata.feedbackSessionId && !copy.includes(metadata.feedbackSessionId)) failures.push("verified /feedback session ID is not present in submission copy");
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
