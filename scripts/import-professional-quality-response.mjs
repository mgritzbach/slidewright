#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeProfessionalQualityResponse } from "./verify-professional-quality-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--out-dir", "--packet-root", "--contract"].includes(key)) throw new Error(`Unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`);
    options[key.slice(2)] = value;
    index += 1;
  }
  if (!options.input) throw new Error("Usage: node scripts/import-professional-quality-response.mjs --input <response.json> [--out-dir <directory>] [--packet-root <directory>] [--contract <contract.json>]");
  return options;
}

async function readJson(candidate, label) {
  let value;
  try { value = JSON.parse((await fs.readFile(candidate, "utf8")).replace(/^\uFEFF/u, "")); }
  catch (error) { throw new Error(`${label} is not valid UTF-8 JSON: ${error.message}`); }
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = path.resolve(options.input);
  const packetRoot = path.resolve(options["packet-root"] ?? path.join(root, "outputs", "professional-quality", "reviewer-packet"));
  const contractPath = path.resolve(options.contract ?? path.join(root, "fixtures", "professional-quality", "c13-v1", "contract.json"));
  const outDir = path.resolve(options["out-dir"] ?? path.join(root, "evidence", "c13", "v1", "responses"));
  const contract = await readJson(contractPath, "C13 contract");
  const manifest = await readJson(path.join(packetRoot, "manifest.json"), "C13 blinded manifest");
  const assignmentDocument = await readJson(path.join(packetRoot, "target-user-assignments.json"), "C13 target-user assignments");
  const response = await readJson(input, "C13 response");
  const sanitized = sanitizeProfessionalQualityResponse(response, { contract, candidates: manifest.candidates, assignments: assignmentDocument.assignments });
  const outputName = `${sanitized.participant.role}-${sanitized.participant.id}.json`;
  const output = path.join(outDir, outputName);
  if (path.resolve(output) === input) throw new Error("Raw input and sanitized evidence output must be distinct files.");
  await fs.mkdir(outDir, { recursive: true });
  const serialized = `${JSON.stringify(sanitized, null, 2)}\n`;
  try {
    await fs.writeFile(output, serialized, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(output, "utf8");
    if (existing !== serialized) throw new Error(`A different sanitized response already exists for participant ${sanitized.participant.id}.`);
  }
  process.stdout.write(`Imported sanitized C13 ${sanitized.participant.role} response: ${output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
