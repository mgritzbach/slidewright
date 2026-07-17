import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { aggregateInstallationScorecards, computeInstallImplementationBinding } from "./lib/install-evidence.mjs";
import { sha256 } from "./public-evidence-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const input = path.resolve(option("--input", path.join(root, "outputs", "installation-hosts")));
const output = path.resolve(option("--out", path.join(root, "outputs", "installation-aggregate")));
const contract = JSON.parse(await fs.readFile(path.join(root, "evidence", "install-contract.json"), "utf8"));
const ownedInput = path.resolve(root, "outputs", "installation-hosts");
const ownedOutput = path.resolve(root, "outputs", "installation-aggregate");
const overlaps = input === output || input.startsWith(`${output}${path.sep}`) || output.startsWith(`${input}${path.sep}`);
if (overlaps) throw new Error("Refusing overlapping installation input and output paths.");
if (input !== ownedInput) throw new Error(`Refusing any input except the owned installation host directory ${ownedInput}.`);
if (output !== ownedOutput) throw new Error(`Refusing any output except the owned installation aggregate directory ${ownedOutput}.`);
const gitResult = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const checkoutHead = gitResult.status === 0 ? gitResult.stdout.trim() : null;
if (!/^[a-f0-9]{40}$/.test(checkoutHead ?? "")) throw new Error("Could not resolve the checked-out exact Git commit.");
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== checkoutHead) {
  throw new Error("GITHUB_SHA does not match the checked-out exact Git commit.");
}

async function findScorecards(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findScorecards(absolute));
    else if (entry.isFile() && entry.name === "scorecard.json") found.push(absolute);
  }
  return found;
}

const files = await findScorecards(input);
const scorecards = await Promise.all(files.map(async (file) => {
  const scorecard = JSON.parse(await fs.readFile(file, "utf8"));
  const logs = path.join(path.dirname(file), "logs");
  for (const command of scorecard.commands ?? []) {
    const [stdout, stderr] = await Promise.all([
      fs.readFile(path.join(logs, `${command.id}.stdout.log`), "utf8"),
      fs.readFile(path.join(logs, `${command.id}.stderr.log`), "utf8"),
    ]);
    if (sha256(stdout) !== command.stdoutHash || sha256(stderr) !== command.stderrHash) {
      throw new Error(`${file}: raw command log hash mismatch for ${command.id}.`);
    }
  }
  return scorecard;
}));
const implementation = await computeInstallImplementationBinding(root);
const aggregate = aggregateInstallationScorecards(scorecards, contract, {
  expectedImplementationHash: implementation.implementationHash,
  expectedGitSha: checkoutHead,
});
await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, "aggregate-scorecard.json"), `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");
const report = `# Slidewright installation replication\n\n- Valid: **${aggregate.valid}**\n- Git commit: \`${aggregate.gitSha}\`\n- Codex: \`${aggregate.codex.package}@${aggregate.codex.version}\`\n- Platforms: ${aggregate.platforms.join(", ")}\n- Surfaces: ${aggregate.surfaces.join(", ")}\n- Byte-identical plugin tree: \`${aggregate.pluginTreeHash}\`\n- Aggregate: \`${aggregate.aggregateHash}\`\n`;
await fs.writeFile(path.join(output, "INSTALLATION_REPORT.md"), report, "utf8");
process.stdout.write(report);
