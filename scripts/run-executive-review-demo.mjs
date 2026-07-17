import fs from "node:fs/promises";
import path from "node:path";
import { runRequestBuild, sha256Bytes, verifyRequestRun } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";

const root = path.resolve("outputs/executive-review");
const sourceRequest = JSON.parse(await fs.readFile(path.resolve("examples/executive-review/request.json"), "utf8"));

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function build(mode) {
  const id = mode === "off" ? "off" : "on";
  const request = { ...structuredClone(sourceRequest), id: `executive-review-${id}`, reviewMode: mode };
  const requestPath = path.join(root, `${id}-request.json`);
  const outputDir = path.join(root, id);
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
  const result = await runRequestBuild({ requestPath, outputDir });
  const verification = await verifyRequestRun(outputDir);
  if (!result.run.valid || !verification.valid) throw new Error(`E6 ${mode} build did not verify: ${verification.diagnostics.join(" ")}`);
  const canonicalBytes = await fs.readFile(path.join(outputDir, "deck.pptx"));
  return {
    mode,
    outputDir,
    canonicalSha256: sha256Bytes(canonicalBytes),
    reviewCopyExists: await exists(path.join(outputDir, "deck.executive-review.pptx")),
    verification,
  };
}

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(root, { recursive: true });
const off = await build("off");
const on = await build("executive-overlay");
const report = {
  schemaVersion: "slidewright-executive-review-demo/v1",
  valid: off.canonicalSha256 === on.canonicalSha256 && off.reviewCopyExists === false && on.reviewCopyExists === true,
  canonicalDeckIdenticalAcrossToggle: off.canonicalSha256 === on.canonicalSha256,
  cleanModeHasNoReviewCopy: off.reviewCopyExists === false,
  overlayModeHasReviewCopy: on.reviewCopyExists === true,
  runs: [off, on],
};
await fs.writeFile(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (!report.valid) throw new Error("E6 toggle benchmark failed its reversibility contract.");
process.stdout.write(`E6 toggle benchmark passed. Canonical deck: ${off.canonicalSha256}\n`);
