import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

async function exists(candidate) {
  try { await fs.access(candidate); return true; } catch { return false; }
}

export async function findArtifactSetupScript(env = process.env) {
  const cacheRoot = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  let entries = [];
  try { entries = await fs.readdir(cacheRoot, { withFileTypes: true }); } catch { return null; }
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const script = path.join(cacheRoot, version, "skills", "presentations", "container_tools", "setup_artifact_tool_workspace.mjs");
    if (await exists(script)) return { version, script };
  }
  return null;
}

export async function bootstrapArtifactWorkspace({ cwd = process.cwd(), env = process.env } = {}) {
  const setup = await findArtifactSetupScript(env);
  if (!setup) throw new Error("Codex's bundled presentation runtime is unavailable; install or repair the Presentations runtime before rendering.");
  const result = spawnSync(process.execPath, [setup.script, "--workspace", cwd], { cwd, env, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Presentation runtime bootstrap failed with status ${result.status}.`);
  return { cwd: path.resolve(cwd), runtimeVersion: setup.version, setupScript: setup.script };
}

export async function loadArtifactTool() {
  const targetRequire = createRequire(path.join(process.cwd(), "package.json"));
  try {
    const resolved = targetRequire.resolve("@oai/artifact-tool");
    return await import(pathToFileURL(resolved).href);
  } catch (error) {
    throw new Error("@oai/artifact-tool is not linked in this workspace. Run 'node <slidewright-skill>/scripts/slidewright.mjs bootstrap', then rerun preflight.", { cause: error });
  }
}
