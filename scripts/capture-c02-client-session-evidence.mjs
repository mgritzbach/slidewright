import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { captureClientSessionProof, normalizeText, sha256 } from "./lib/c02-client-session-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));

for (const required of ["rollout", "installed-skill", "surface", "source-commit", "out"]) {
  if (!args[required]) throw new Error(`Missing --${required}.`);
}

const repositorySkill = path.join(root, "plugins", "slidewright", "skills", "slidewright", "SKILL.md");
const { execFileSync } = await import("node:child_process");
const publicSkill = execFileSync("git", ["show", `${args["source-commit"]}:plugins/slidewright/skills/slidewright/SKILL.md`], {
  cwd: root,
  encoding: "utf8",
});
const currentRepositorySkill = await fs.readFile(repositorySkill, "utf8");
const publicSourceNormalizedSha256 = sha256(normalizeText(publicSkill));

const proof = await captureClientSessionProof({
  rolloutPath: path.resolve(args.rollout),
  installedSkillPath: path.resolve(args["installed-skill"]),
  publicSourceNormalizedSha256,
  publicSourceCommit: args["source-commit"],
  surface: args.surface,
});

proof.skill.currentWorktreeNormalizedSha256 = sha256(normalizeText(currentRepositorySkill));
proof.skill.currentWorktreeMatchesCapturedInstall = proof.skill.currentWorktreeNormalizedSha256 === proof.skill.installedNormalizedSha256;
const copy = structuredClone(proof);
delete copy.proofHash;
proof.proofHash = sha256(JSON.stringify(copy));

const output = path.resolve(args.out);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, discoveryUseValid: proof.discoveryUseValid, nonceProofValid: proof.nonceProofValid, surfaceComplete: proof.surfaceComplete, proofHash: proof.proofHash }, null, 2));
