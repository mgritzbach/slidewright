import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function treeBinding(directory) {
  const files = [];
  async function visit(current, prefix = "") {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) {
        const bytes = await fs.readFile(absolute);
        files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
      } else if (entry.isSymbolicLink()) {
        files.push({ path: relative, link: await fs.readlink(absolute) });
      }
    }
  }
  await visit(directory);
  const payload = Buffer.from(JSON.stringify(files), "utf8");
  return {
    fileCount: files.filter((item) => item.sha256).length,
    linkCount: files.filter((item) => item.link).length,
    totalBytes: files.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    treeSha256: sha256(payload),
  };
}

async function latestPresentationRuntime() {
  const cacheRoot = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "cache", "openai-primary-runtime", "presentations");
  const versions = (await fs.readdir(cacheRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  for (const version of versions) {
    const containerTools = path.join(cacheRoot, version, "skills", "presentations", "container_tools");
    if (await exists(path.join(containerTools, "setup_artifact_tool_workspace.mjs"))) return { version, containerTools };
  }
  throw new Error("No supported Codex presentation runtime is installed.");
}

function pythonBinding(python) {
  const code = [
    "import importlib.metadata as m,json,platform,sys",
    "names=['python-pptx','Pillow','numpy','pdf2image','lxml']",
    "versions={}",
    "for name in names:",
    "  try: versions[name]=m.version(name)",
    "  except m.PackageNotFoundError: versions[name]=None",
    "print(json.dumps({'implementation':platform.python_implementation(),'version':platform.python_version(),'packages':versions},sort_keys=True))",
  ].join("\n");
  const result = spawnSync(python, ["-c", code], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Could not bind Python runtime: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout);
}

export async function captureC15RuntimeBindings({ root, python }) {
  const runtime = await latestPresentationRuntime();
  const artifactTool = await fs.realpath(path.join(root, "node_modules", "@oai", "artifact-tool"));
  const artifactPackage = JSON.parse(await fs.readFile(path.join(artifactTool, "package.json"), "utf8"));
  if (artifactPackage.name !== "@oai/artifact-tool" || !artifactPackage.version) throw new Error("Resolved renderer is not a versioned @oai/artifact-tool package.");
  return {
    schemaVersion: "slidewright-c15-runtime-bindings/v1",
    node: { version: process.version, platform: process.platform, arch: process.arch },
    python: pythonBinding(python),
    presentationRuntime: {
      version: runtime.version,
      containerTools: await treeBinding(runtime.containerTools),
    },
    artifactTool: {
      name: artifactPackage.name,
      version: artifactPackage.version,
      tree: await treeBinding(artifactTool),
    },
  };
}
