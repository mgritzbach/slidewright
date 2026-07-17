import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveArtifactRuntime } from "./artifact-runtime.mjs";

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
  const runtimeDetail = probes.presentationRuntime ? {
    source: probes.presentationRuntime.source,
    hostProfile: probes.presentationRuntime.hostProfile,
    version: probes.presentationRuntime.artifactTool?.version ?? probes.presentationRuntime.setup?.version ?? null,
    package: probes.presentationRuntime.artifactTool?.packageDir ?? null,
    setupScript: probes.presentationRuntime.setup?.script ?? null,
    downloaded: false,
    rendererSwitched: false,
  } : probes.runtimeFailure ?? null;
  const checks = [
    { id: "skill", required: true, ok: probes.skill, detail: probes.skillPath, remediation: "Install the Slidewright plugin or run from its repository root." },
    { id: "node", required: true, ok: Number.parseInt(probes.nodeVersion.split(".")[0], 10) >= 20, detail: `Node ${probes.nodeVersion}`, remediation: "Install Node.js 20 or newer." },
    { id: "python", required: true, ok: probes.python.available, detail: probes.python.detail, remediation: "Install Python 3.11+ or set SLIDEWRIGHT_PYTHON to a working executable." },
    { id: "artifact-tool", required: true, ok: Boolean(probes.artifactTool), detail: probes.artifactTool, remediation: probes.presentationRuntime ? "Run 'node <slidewright-skill>/scripts/slidewright.mjs bootstrap' in the target workspace, then rerun preflight." : "Install or repair Codex's bundled Presentations runtime, or set SLIDEWRIGHT_CODEX_RUNTIME_ROOT / SLIDEWRIGHT_ARTIFACT_TOOL_PATH to an existing local runtime." },
    { id: "presentation-renderer", required: true, ok: Boolean(probes.presentationRuntime), detail: runtimeDetail, remediation: "Install or repair Codex's bundled Presentations runtime; Slidewright will not download or silently switch renderers." },
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
      hostProfile: probes.presentationRuntime?.hostProfile ?? probes.hostProfile ?? null,
      rendererSource: probes.presentationRuntime?.source ?? null,
      rendererVersion: probes.presentationRuntime?.artifactTool?.version ?? probes.presentationRuntime?.setup?.version ?? null,
      artifactToolVersion: probes.artifactTool?.version ?? null,
      runtimeDownloaded: false,
      rendererSwitched: false,
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
  let presentationRuntime = null;
  let runtimeFailure = null;
  let artifactTool = null;
  try {
    presentationRuntime = await resolveArtifactRuntime({ cwd, env, platform });
    if (presentationRuntime.source === "workspace") {
      artifactTool = { path: presentationRuntime.artifactTool.packagePath, version: presentationRuntime.artifactTool.version };
    }
  } catch (error) {
    presentationRuntime = null;
    runtimeFailure = { code: error.code ?? "SW_RUNTIME_PROBE_FAILED", message: error.message };
  }
  return buildPreflightReport({
    skill: await exists(skillPath),
    skillPath,
    nodeVersion: process.versions.node,
    python: commandProbe(pythonCommand),
    artifactTool,
    presentationRuntime,
    runtimeFailure,
    fonts: await fontProbe(platform),
    powerPoint: platform === "win32" && await exists(commonPowerPoint) ? { available: true, detail: commonPowerPoint } : { available: false, detail: null },
    libreOffice: commandProbe(platform === "win32" ? "soffice.exe" : "soffice"),
    platform,
    architecture: process.arch,
    hostProfile: presentationRuntime?.hostProfile ?? null,
  });
}
