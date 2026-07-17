#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { compileDeck } from "./lib/compiler.mjs";
import { lintPlan } from "./lib/linter.mjs";
import { renderPlan } from "./lib/renderer.mjs";
import { collectPreflight } from "./lib/preflight.mjs";
import { verifyDelivery } from "./lib/delivery.mjs";
import { inspectPlanFonts } from "./lib/font-audit.mjs";
import { renderObservedDesign } from "./benchmark/render_observed_design.mjs";
import { bootstrapArtifactWorkspace } from "./lib/artifact-runtime.mjs";
import { applyNamedEditManifest } from "./lib/named-edits.mjs";
import { adaptExtractedProfile } from "./lib/design-profile.mjs";
import { compileProfileContentSpec } from "./lib/compile_profile_derivation.mjs";
import { runRequestBuild, verifyRequestRun } from "./lib/request-build.mjs";
import { adaptDeckCopyToFit } from "./lib/copy-adaptation.mjs";

function usage() {
  return `Slidewright

Usage:
  slidewright bootstrap
  slidewright request <request.json> --out <run-directory>
  slidewright request-verify <run-directory> --out <report.json>
  slidewright adapt <spec.json> --out <adapted-spec.json> --manifest <adaptation.json>
  slidewright compile <spec.json> --out <plan.json>
  slidewright iterate <plan.json> --manifest <edit.json> --out <updated-plan.json>
  slidewright profile <source.pptx> --out <profile.json> [--asymmetry-manifest <manifest.json>]
  slidewright derive <profile.json> --intent <design-intent.json> --content <content-spec.json> --out <edit-plan.json>
  slidewright lint <plan.json> --out <report.json>
  slidewright fonts <plan.json> --out <report.json>
  slidewright render <plan.json> --out <deck.pptx> [--preview-dir <dir>]
  slidewright reconstruct <observed-design.json> --out <deck.pptx> [--preview-dir <dir>]
  slidewright preflight --out <report.json>
  slidewright verify <deck.pptx> --out <manifest.json> [--preview-dir <dir>] [--montage <image>] [--handoff <file>] [--require-bundle]
`;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function main(args = process.argv.slice(2)) {
  const [command, input] = args;
  if (!command || ["-h", "--help"].includes(command)) {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "bootstrap") {
    const report = await bootstrapArtifactWorkspace();
    process.stdout.write(`Linked Codex presentation runtime ${report.runtimeVersion} into ${report.cwd}\n`);
    return 0;
  }
  const out = option(args, "--out");
  if (!out) throw new Error("--out is required.");

  if (command === "preflight") {
    const report = await collectPreflight();
    await writeJson(out, report);
    process.stdout.write(`Preflight ${report.valid ? "passed" : "failed"}: ${report.checks.filter((check) => check.required && !check.ok).length} required capability failure(s)\n`);
    return report.valid ? 0 : 2;
  }
  if (!input) throw new Error(`An input file is required for '${command}'.`);
  if (command === "request") {
    const result = await runRequestBuild({ requestPath: input, outputDir: out });
    process.stdout.write(`Request ${result.run.outcome}: ${result.run.requestId ?? "<invalid>"} -> ${result.outputDir}\n`);
    return result.run.valid ? 0 : 2;
  }
  if (command === "request-verify") {
    const report = await verifyRequestRun(input);
    await writeJson(out, report);
    process.stdout.write(`Request-run verification ${report.valid ? "passed" : "failed"}: ${report.outcome ?? "unknown"}\n`);
    return report.valid ? 0 : 2;
  }
  if (command === "verify") {
    const manifest = await verifyDelivery(input, {
      previewDir: option(args, "--preview-dir"),
      montage: option(args, "--montage"),
      handoff: option(args, "--handoff"),
      requireBundle: args.includes("--require-bundle"),
    });
    await writeJson(out, manifest);
    process.stdout.write(`Delivery verification ${manifest.valid ? "passed" : "failed"}: ${manifest.file.canonicalPath ?? input}\n`);
    return manifest.valid ? 0 : 2;
  }

  if (command === "fonts") {
    const report = inspectPlanFonts(await readJson(input));
    await writeJson(out, report);
    process.stdout.write(`Font audit ${report.valid ? "passed" : "failed"}: ${report.diagnostics.length} error(s), ${report.availableFontCount} installed families detected\n`);
    return report.valid ? 0 : 2;
  }

  if (command === "compile") {
    const plan = compileDeck(await readJson(input));
    await writeJson(out, plan);
    process.stdout.write(`Compiled ${plan.slides.length} slides to ${out}\n`);
    return 0;
  }
  if (command === "adapt") {
    const manifestPath = option(args, "--manifest");
    if (!manifestPath) throw new Error("--manifest is required for copy adaptation.");
    const result = adaptDeckCopyToFit(await readJson(input));
    await writeJson(out, result.spec);
    await writeJson(manifestPath, result.manifest);
    process.stdout.write(`Adapted ${result.manifest.sourceSlideCount} source slides to ${result.manifest.adaptedSlideCount} slides with ${result.manifest.continuationSlideCount} continuation(s).\n`);
    return 0;
  }
  if (command === "profile") {
    const extractor = path.join(path.dirname(fileURLToPath(import.meta.url)), "design_profile", "extract_design_profile.py");
    const extractorArgs = [extractor, input, "--out", out, "--quiet"];
    const asymmetryManifest = option(args, "--asymmetry-manifest");
    if (asymmetryManifest) extractorArgs.push("--asymmetry-manifest", asymmetryManifest);
    const result = spawnSync(process.env.SLIDEWRIGHT_PYTHON || "python", extractorArgs, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("Design-profile extraction failed with status " + result.status + ".");
    process.stdout.write("Extracted source-bound design profile to " + out + ".\n");
    return 0;
  }
  if (command === "derive") {
    const intentPath = option(args, "--intent");
    const contentPath = option(args, "--content");
    if (!intentPath || !contentPath) throw new Error("--intent and --content are required for profile derivation.");
    const reuseProfile = adaptExtractedProfile(await readJson(input), await readJson(intentPath));
    const plan = compileProfileContentSpec(reuseProfile, await readJson(contentPath));
    await writeJson(out, plan);
    process.stdout.write("Compiled source-bound edit plan for slide " + plan.targetSlide + " with " + plan.edits.length + " edit(s).\n");
    return 0;
  }
  if (command === "iterate") {
    const manifestPath = option(args, "--manifest");
    if (!manifestPath) throw new Error("--manifest is required for named iteration.");
    const result = applyNamedEditManifest(await readJson(input), await readJson(manifestPath));
    await writeJson(out, result.plan);
    process.stdout.write(`Applied named edit '${result.manifestId}' to ${result.changedIds.length} object(s): ${result.changedIds.join(", ")}\n`);
    return 0;
  }
  if (command === "lint") {
    const report = lintPlan(await readJson(input));
    await writeJson(out, report);
    process.stdout.write(`Lint ${report.valid ? "passed" : "failed"}: ${report.counts.error} error(s), ${report.counts.warning} warning(s)\n`);
    return report.valid ? 0 : 2;
  }
  if (command === "render") {
    const result = await renderPlan(await readJson(input), {
      out,
      previewDir: option(args, "--preview-dir"),
    });
    process.stdout.write(`Rendered ${result.slideCount} editable slides to ${result.out}\n`);
    return 0;
  }
  if (command === "reconstruct") {
    const previewDir = option(args, "--preview-dir");
    const result = await renderObservedDesign({
      input,
      out,
      preview: previewDir ? path.join(previewDir, "slide-1.png") : undefined,
    });
    process.stdout.write(`Reconstructed ${result.design.objects.length} editable objects to ${result.out}\n`);
    return 0;
  }
  throw new Error(`Unknown command '${command}'.\n${usage()}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
