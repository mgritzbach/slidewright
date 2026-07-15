import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function commandProbe(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return {
    available: !result.error && result.status === 0,
    detail: (result.stdout || result.stderr || result.error?.message || "").trim().split(/\r?\n/)[0] || null,
  };
}

async function findPresentationRuntime(env) {
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const root = path.join(codexHome, "plugins", "cache", "openai-primary-runtime", "presentations");
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) {
    const tools = path.join(root, version, "skills", "presentations", "container_tools");
    if (await exists(path.join(tools, "render_slides.py")) && await exists(path.join(tools, "slides_test.py"))) {
      return { version, tools };
    }
  }
  return null;
}

async function findArtifactTool(cwd) {
  const candidate = path.join(cwd, "node_modules", "@oai", "artifact-tool", "package.json");
  if (!await exists(candidate)) return null;
  const pkg = JSON.parse(await fs.readFile(candidate, "utf8"));
  return { path: candidate, version: pkg.version ?? "unknown" };
}

async function fontProbe(platform) {
  if (platform === "win32") {
    const fonts = {
      Arial: ["arial.ttf", "ARIAL.TTF"],
      Georgia: ["georgia.ttf", "GEORGIA.TTF"],
    };
    const root = path.join(process.env.SystemRoot || "C:\\Windows", "Fonts");
    const results = {};
    for (const [name, files] of Object.entries(fonts)) {
      results[name] = false;
      for (const file of files) {
        if (await exists(path.join(root, file))) {
          results[name] = true;
          break;
        }
      }
    }
    return results;
  }
  const results = {};
  for (const name of ["Arial", "Georgia"]) {
    const probe = spawnSync("fc-match", [name], { encoding: "utf8" });
    results[name] = !probe.error && probe.status === 0 && Boolean(probe.stdout.trim());
  }
  return results;
}

export function buildPreflightReport(probes) {
  const checks = [
    { id: "skill", required: true, ok: probes.skill, detail: probes.skillPath, remediation: "Install the Slidewright plugin or run from its repository root." },
    { id: "node", required: true, ok: Number.parseInt(probes.nodeVersion.split(".")[0], 10) >= 20, detail: `Node ${probes.nodeVersion}`, remediation: "Install Node.js 20 or newer." },
    { id: "python", required: true, ok: probes.python.available, detail: probes.python.detail, remediation: "Install Python 3.11+ or set SLIDEWRIGHT_PYTHON to a working executable." },
    { id: "artifact-tool", required: true, ok: Boolean(probes.artifactTool), detail: probes.artifactTool, remediation: "Run npm run setup:runtime from a Codex environment with the presentation runtime installed." },
    { id: "presentation-renderer", required: true, ok: Boolean(probes.presentationRuntime), detail: probes.presentationRuntime, remediation: "Install or repair the bundled Codex presentations runtime; render_slides.py and slides_test.py are required." },
    { id: "fonts", required: true, ok: Object.values(probes.fonts).every(Boolean), detail: probes.fonts, remediation: `Install the missing required fonts: ${Object.entries(probes.fonts).filter(([, ok]) => !ok).map(([name]) => name).join(", ") || "none"}.` },
    { id: "powerpoint", required: false, ok: probes.powerPoint.available, detail: probes.powerPoint.detail, remediation: "Optional: install Microsoft PowerPoint for application-level round-trip tests." },
    { id: "libreoffice", required: false, ok: probes.libreOffice.available, detail: probes.libreOffice.detail, remediation: "Optional: install LibreOffice only if you explicitly choose its renderer." },
  ];
  return {
    valid: checks.filter((check) => check.required).every((check) => check.ok),
    generatedAt: new Date().toISOString(),
    buildEnvironment: {
      platform: probes.platform ?? process.platform,
      architecture: probes.architecture ?? process.arch,
      selectedRenderer: probes.presentationRuntime ? "codex-presentation-runtime" : null,
      rendererVersion: probes.presentationRuntime?.version ?? null,
      artifactToolVersion: probes.artifactTool?.version ?? null,
      requiredFonts: Object.keys(probes.fonts),
    },
    checks,
  };
}

export async function collectPreflight({ cwd = process.cwd(), env = process.env, platform = process.platform } = {}) {
  const skillPath = path.resolve(moduleDir, "..", "..", "SKILL.md");
  const bundledPython = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", platform === "win32" ? "python.exe" : "bin/python");
  const pythonCommand = env.SLIDEWRIGHT_PYTHON || (await exists(bundledPython) ? bundledPython : "python");
  const commonPowerPoint = platform === "win32" ? "C:\\Program Files\\Microsoft Office\\root\\Office16\\POWERPNT.EXE" : "";
  return buildPreflightReport({
    skill: await exists(skillPath),
    skillPath,
    nodeVersion: process.versions.node,
    python: commandProbe(pythonCommand),
    artifactTool: await findArtifactTool(cwd),
    presentationRuntime: await findPresentationRuntime(env),
    fonts: await fontProbe(platform),
    powerPoint: platform === "win32" && await exists(commonPowerPoint) ? { available: true, detail: commonPowerPoint } : { available: false, detail: null },
    libreOffice: commandProbe(platform === "win32" ? "soffice.exe" : "soffice"),
    platform,
    architecture: process.arch,
  });
}
