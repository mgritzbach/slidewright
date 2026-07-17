#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifySemanticMutationEvidence } from "./lib/semantic-mutation-evidence.mjs";

const root = process.cwd();
const published = path.join(root, "outputs", "semantic-mutation");
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

const pointer = JSON.parse((await fs.readFile(path.join(published, "current.json"), "utf8")).replace(/^\uFEFF/u, ""));
if (pointer.schemaVersion !== "slidewright-semantic-current/v1"
  || !/^[a-f0-9]{64}$/u.test(pointer.scorecardHash ?? "")
  || pointer.run !== `runs/${pointer.scorecardHash}`) {
  throw new Error("C18 current pointer is malformed or not content addressed.");
}
const runDirectory = path.resolve(published, ...pointer.run.split("/"));
const expected = path.resolve(published, "runs", pointer.scorecardHash);
if (runDirectory !== expected) throw new Error("C18 current pointer escaped its immutable run directory.");
const slidesTest = await findPresentationTool("slides_test.py");
const result = await verifySemanticMutationEvidence({ root, runDirectory, python, slidesTest, requireCurrentGit: false, requireSourceCurrent: false });
const [pointerAfter, convenienceScorecard, immutableScorecard] = await Promise.all([
  fs.readFile(path.join(published, "current.json"), "utf8"),
  fs.readFile(path.join(published, "scorecard.json")),
  fs.readFile(path.join(runDirectory, "scorecard.json")),
]);
if (pointerAfter.replace(/^\uFEFF/u, "") !== `${JSON.stringify(pointer, null, 2)}\n` || !convenienceScorecard.equals(immutableScorecard)) {
  throw new Error("C18 current pointer or convenience scorecard drifted after verification.");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
