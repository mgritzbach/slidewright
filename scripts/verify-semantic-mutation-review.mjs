#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifySemanticMutationReview } from "./lib/semantic-mutation-evidence.mjs";

const root = process.cwd();
const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
let python = process.env.SLIDEWRIGHT_PYTHON || "python";
try { await fs.access(bundledPython); if (!process.env.SLIDEWRIGHT_PYTHON) python = bundledPython; } catch { /* PATH fallback */ }

async function findPresentationTool(name) {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const candidate = path.join(cacheRoot, version, "skills", "presentations", "container_tools", name);
    try { await fs.access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error(`Could not locate presentation tool ${name}.`);
}

const result = await verifySemanticMutationReview({ root, python, slidesTest: await findPresentationTool("slides_test.py") });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
