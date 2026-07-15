#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compileDeck } from "./lib/compiler.mjs";
import { lintPlan } from "./lib/linter.mjs";
import { renderPlan } from "./lib/renderer.mjs";
import { collectPreflight } from "./lib/preflight.mjs";
import { verifyDelivery } from "./lib/delivery.mjs";
import { inspectPlanFonts } from "./lib/font-audit.mjs";

function usage() {
  return `Slidewright

Usage:
  slidewright compile <spec.json> --out <plan.json>
  slidewright lint <plan.json> --out <report.json>
  slidewright fonts <plan.json> --out <report.json>
  slidewright render <plan.json> --out <deck.pptx> [--preview-dir <dir>]
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
  const out = option(args, "--out");
  if (!out) throw new Error("--out is required.");

  if (command === "preflight") {
    const report = await collectPreflight();
    await writeJson(out, report);
    process.stdout.write(`Preflight ${report.valid ? "passed" : "failed"}: ${report.checks.filter((check) => check.required && !check.ok).length} required capability failure(s)\n`);
    return report.valid ? 0 : 2;
  }
  if (!input) throw new Error(`An input file is required for '${command}'.`);
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
