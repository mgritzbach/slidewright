import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertClientSessionProof } from "./lib/c02-client-session-evidence.mjs";

const target = process.argv[2];
if (!target) throw new Error("Usage: node scripts/verify-c02-client-session-evidence.mjs <proof.json>");
const proof = JSON.parse(await fs.readFile(path.resolve(target), "utf8"));
assertClientSessionProof(proof);
console.log(JSON.stringify({ proof: path.resolve(target), discoveryValid: proof.discoveryValid, installedReadValid: proof.installedReadValid, clientInvocationValid: proof.clientInvocationValid, nonceProofValid: proof.nonceProofValid, surfaceComplete: proof.surfaceComplete, c02Complete: proof.c02Complete }, null, 2));
