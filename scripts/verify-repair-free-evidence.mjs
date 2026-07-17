#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRepairFreeEvidence } from "./lib/repair-free-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realRoot = await fs.realpath(root);
const development = process.argv.includes("--development");
const output = path.resolve(root, "outputs", "repair-free", ...(development ? ["development"] : []));
const outputStat = await fs.lstat(output);
if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("C04 evidence root is not a regular repository directory.");
const realOutputCandidate = await fs.realpath(output);
const outputRelative = path.relative(realRoot, realOutputCandidate);
if (!outputRelative || outputRelative === ".." || outputRelative.startsWith(`..${path.sep}`) || path.isAbsolute(outputRelative)) throw new Error("C04 evidence root escapes the repository.");
const pointerPath = path.join(output, "current.json");
const pointerStat = await fs.lstat(pointerPath);
if (!pointerStat.isFile() || pointerStat.isSymbolicLink()) throw new Error("C04 current pointer is not a regular file.");
const pointer = JSON.parse((await fs.readFile(pointerPath, "utf8")).replace(/^\uFEFF/u, ""));
const expectedPointerSchema = development ? "slidewright-repair-free-development-current/v1" : "slidewright-repair-free-current/v2";
if (pointer.schemaVersion !== expectedPointerSchema || !/^[0-9a-f]{64}$/u.test(pointer.scorecardHash) || !/^[0-9a-f]{64}$/u.test(pointer.evidenceTreeSha256) || pointer.run !== `runs/${pointer.scorecardHash}`) {
  throw new Error("C04 current pointer is invalid.");
}
const run = path.resolve(output, ...pointer.run.split("/"));
const relative = path.relative(output, run);
if (!relative.startsWith(`runs${path.sep}`) || relative.includes(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("C04 current pointer escapes its output root.");
const runStat = await fs.lstat(run);
if (!runStat.isDirectory() || runStat.isSymbolicLink()) throw new Error("C04 selected run is not a regular directory.");
const realOutput = await fs.realpath(output);
const realRun = await fs.realpath(run);
const realRelative = path.relative(realOutput, realRun);
if (!realRelative.startsWith(`runs${path.sep}`) || realRelative.includes(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error("C04 selected run realpath escapes its output root.");
const scorecard = await verifyRepairFreeEvidence({ root, runDirectory: realRun, requireCurrentGit: !development && !process.argv.includes("--historical"), requireRelease: !development });
if (scorecard.scorecardHash !== pointer.scorecardHash) throw new Error("C04 pointer and scorecard hashes differ.");
if (scorecard.evidence.treeSha256 !== pointer.evidenceTreeSha256) throw new Error("C04 pointer and raw evidence tree differ.");
process.stdout.write(`C04 evidence verified: ${scorecard.fixtureCount}/${scorecard.fixtureCount} fixtures, ${scorecard.negativeControls.length} controls, ${scorecard.scorecardHash}\n`);
