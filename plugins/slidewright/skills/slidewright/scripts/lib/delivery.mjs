import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findPython(env, platform) {
  if (env.SLIDEWRIGHT_PYTHON) return env.SLIDEWRIGHT_PYTHON;
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", platform === "win32" ? "python.exe" : "bin/python");
  return await exists(bundled) ? bundled : "python";
}

async function inspectPptx(filePath, env, platform) {
  const script = [
    "import json,sys,zipfile",
    "p=sys.argv[1]",
    "required={'[Content_Types].xml','ppt/presentation.xml'}",
    "with zipfile.ZipFile(p) as z:",
    " names=set(z.namelist())",
    " bad=z.testzip()",
    " slides=sorted(n for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml'))",
    " print(json.dumps({'zipIntegrity': bad is None, 'badMember': bad, 'requiredParts': required.issubset(names), 'slideCount': len(slides), 'hasSlides': len(slides)>0}))",
  ].join("\n");
  const result = spawnSync(await findPython(env, platform), ["-c", script, filePath], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    return { zipIntegrity: false, requiredParts: false, hasSlides: false, slideCount: 0, error: (result.stderr || result.error?.message || "PPTX inspection failed").trim() };
  }
  return JSON.parse(result.stdout);
}

export function buildDeliveryManifest({ filePath, canonicalPath, size, sha256, inspection, previews = [], montagePath = null, handoffPath = null, requireBundle = false }) {
  const checks = {
    exists: Boolean(canonicalPath),
    nonzeroSize: size > 0,
    pptxExtension: path.extname(filePath).toLowerCase() === ".pptx",
    zipIntegrity: inspection.zipIntegrity === true,
    requiredParts: inspection.requiredParts === true,
    hasSlides: inspection.hasSlides === true,
  };
  const bundleChecks = {
    perSlidePreviews: previews.length === (inspection.slideCount ?? 0) && previews.length > 0,
    montage: Boolean(montagePath),
    handoffInstructions: Boolean(handoffPath),
  };
  const deckValid = Object.values(checks).every(Boolean);
  return {
    valid: deckValid && (!requireBundle || Object.values(bundleChecks).every(Boolean)),
    deckValid,
    bundleValid: Object.values(bundleChecks).every(Boolean),
    requireBundle,
    generatedAt: new Date().toISOString(),
    file: {
      requestedPath: filePath,
      canonicalPath,
      sizeBytes: size,
      sha256,
      slideCount: inspection.slideCount ?? 0,
    },
    checks,
    bundleChecks,
    previews,
    montagePath,
    handoffPath,
    markdownLink: canonicalPath ? `[Open the verified PowerPoint](<${canonicalPath.replaceAll("\\", "/")}>)` : null,
    inspectionError: inspection.error ?? null,
  };
}

export async function verifyDelivery(filePath, { previewDir, montage, handoff, requireBundle = false, env = process.env, platform = process.platform } = {}) {
  const absolute = path.resolve(filePath);
  let stat = { size: 0 };
  let canonicalPath = null;
  let bytes = Buffer.alloc(0);
  try {
    stat = await fs.stat(absolute);
    canonicalPath = await fs.realpath(absolute);
    bytes = await fs.readFile(absolute);
  } catch {
    // The manifest reports each failed condition without claiming delivery.
  }
  const inspection = canonicalPath ? await inspectPptx(canonicalPath, env, platform) : { zipIntegrity: false, requiredParts: false, hasSlides: false, slideCount: 0, error: "File does not exist." };
  let previews = [];
  if (previewDir && await exists(previewDir)) {
    previews = (await fs.readdir(previewDir))
      .filter((name) => /^slide[-_]\d+\.(png|webp)$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => path.resolve(previewDir, name));
  }
  const montagePath = montage && await exists(montage) ? await fs.realpath(montage) : null;
  let handoffPath = null;
  if (handoff && canonicalPath) {
    const absoluteHandoff = path.resolve(handoff);
    const openCommand = platform === "win32"
      ? `Start-Process -LiteralPath '${canonicalPath.replaceAll("'", "''")}'`
      : platform === "darwin"
        ? `open '${canonicalPath.replaceAll("'", "'\\''")}'`
        : `xdg-open '${canonicalPath.replaceAll("'", "'\\''")}'`;
    const instructions = [
      "# Slidewright verified delivery",
      "",
      `Deck: ${canonicalPath}`,
      `SHA-256: ${bytes.length ? crypto.createHash("sha256").update(bytes).digest("hex") : "unavailable"}`,
      `Slides: ${inspection.slideCount ?? 0}`,
      "",
      "Open the deck in your system file manager or presentation application. Verified command for this build host:",
      "",
      `    ${openCommand}`,
      "",
      `Rendered slides: ${previewDir ? path.resolve(previewDir) : "not supplied"}`,
      `Montage: ${montagePath ?? "not supplied"}`,
      "",
    ].join("\n");
    await fs.mkdir(path.dirname(absoluteHandoff), { recursive: true });
    await fs.writeFile(absoluteHandoff, instructions, "utf8");
    handoffPath = await fs.realpath(absoluteHandoff);
  }
  return buildDeliveryManifest({
    filePath,
    canonicalPath,
    size: stat.size,
    sha256: bytes.length ? crypto.createHash("sha256").update(bytes).digest("hex") : null,
    inspection,
    previews,
    montagePath,
    handoffPath,
    requireBundle,
  });
}
