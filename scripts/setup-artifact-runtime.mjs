#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const cacheRoot = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "plugins",
  "cache",
  "openai-primary-runtime",
  "presentations",
);

async function findSetupScript() {
  let versions;
  try {
    versions = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    throw new Error(`Codex presentation runtime was not found under ${cacheRoot}.`);
  }
  const candidates = versions
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of candidates) {
    const candidate = path.join(
      cacheRoot,
      version,
      "skills",
      "presentations",
      "container_tools",
      "setup_artifact_tool_workspace.mjs",
    );
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next installed runtime version.
    }
  }
  throw new Error(`No setup_artifact_tool_workspace.mjs exists under ${cacheRoot}.`);
}

const setupScript = await findSetupScript();
process.stdout.write(`Using Codex presentation runtime: ${setupScript}\n`);
const result = spawnSync(process.execPath, [setupScript, "--workspace", process.cwd()], {
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
