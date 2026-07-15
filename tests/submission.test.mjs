import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assetBundleFailures, externalFailures } from "../submission/check-submission.mjs";

test("submission checker keeps every external requirement red when metadata is empty", () => {
  const failures = externalFailures({ youtube: {} });
  assert.deepEqual(failures, [
    "verified GitHub repository URL is missing",
    "public YouTube URL is missing",
    "video duration must be verified below 180 seconds",
    "video audio is not confirmed",
    "primary /feedback session ID is missing",
    "GPT-5.6 usage statement is not verified",
    "Devpost participation is not confirmed",
    "judge repository access is not confirmed",
  ]);
});

test("submission checker accepts a fully verified external record", () => {
  const failures = externalFailures({
    repositoryUrl: "https://github.com/example/slidewright",
    youtube: { url: "https://youtu.be/example", durationSeconds: 165, audioConfirmed: true },
    feedbackSessionId: "session_12345678",
    gpt56UsageVerified: true,
    gpt56UsageStatement: "GPT-5.6 was verified in the primary Codex build session.",
    joinedDevpost: true,
    judgeAccessConfirmed: true,
  });
  assert.deepEqual(failures, []);
});

test("submission checker verifies all six screenshot bytes and hashes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slidewright-submission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const screenshots = path.join(root, "outputs", "submission", "screenshots");
  fs.mkdirSync(screenshots, { recursive: true });
  const names = [
    "01-independent-reference.png",
    "02-editable-reconstruction.png",
    "03-horizontal-native-design.png",
    "04-template-before.png",
    "05-template-after.png",
    "06-powerpoint-roundtrip.png",
  ];
  const assets = names.map((name, index) => {
    const content = Buffer.from(`fixture-${index}`);
    fs.writeFileSync(path.join(screenshots, name), content);
    return {
      file: `screenshots/${name}`,
      bytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    };
  });
  fs.writeFileSync(path.join(root, "outputs", "submission", "asset-manifest.json"), JSON.stringify({ valid: true, assets }));
  assert.deepEqual(assetBundleFailures(root), []);
  fs.writeFileSync(path.join(screenshots, names[0]), "corrupted");
  assert.match(assetBundleFailures(root).join("\n"), /SHA-256 changed|byte count changed/);
  fs.writeFileSync(path.join(screenshots, names[0]), "fixture-0");
  assets[0].file = `other/${names[0]}`;
  fs.mkdirSync(path.join(root, "outputs", "submission", "other"));
  fs.writeFileSync(path.join(root, "outputs", "submission", "other", names[0]), "fixture-0");
  fs.writeFileSync(path.join(root, "outputs", "submission", "asset-manifest.json"), JSON.stringify({ valid: true, assets }));
  assert.match(assetBundleFailures(root).join("\n"), /exact six screenshot paths/);
});
