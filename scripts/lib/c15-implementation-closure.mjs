import fs from "node:fs/promises";
import path from "node:path";

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function collectJavaScriptDependencyClosure(seedFiles) {
  const queue = seedFiles.map((file) => path.resolve(file));
  const visited = new Set();
  const importPattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu;
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const sourceText = await fs.readFile(file, "utf8");
    for (const match of sourceText.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const candidate = path.resolve(path.dirname(file), specifier);
      const resolved = await exists(candidate) ? candidate : await exists(`${candidate}.mjs`) ? `${candidate}.mjs` : null;
      if (!resolved) throw new Error(`Could not close local C15 dependency '${specifier}' from ${file}.`);
      queue.push(resolved);
    }
  }
  return [...visited];
}

export async function collectC15WorkspaceImplementationFiles(root) {
  const skillScripts = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts");
  const seeds = [
    path.join(root, "scripts", "run-copy-resilience-benchmark.mjs"),
    path.join(root, "scripts", "finalize-copy-resilience-review.mjs"),
    path.join(root, "scripts", "verify-copy-resilience-evidence.mjs"),
    path.join(root, "scripts", "setup-artifact-runtime.mjs"),
    path.join(root, "scripts", "lib", "versioned-evidence-publish.mjs"),
    path.join(root, "packages", "cli", "src", "cli.mjs"),
    path.join(skillScripts, "slidewright.mjs"),
    path.join(skillScripts, "lib", "copy-adaptation.mjs"),
    path.join(skillScripts, "lib", "copy-mutation.mjs"),
    path.join(skillScripts, "lib", "request-build.mjs"),
    path.join(skillScripts, "lib", "request-policy.mjs"),
  ];
  const manual = [
    path.join(root, "fixtures", "copy-resilience", "v1", "fixture-manifest.json"),
    path.join(root, "fixtures", "copy-resilience", "v1", "translation-de-spec.json"),
    path.join(root, "examples", "demo", "deck-spec.json"),
    path.join(skillScripts, "audit_pptx.py"),
    path.join(skillScripts, "audit_request_plan.py"),
    path.join(skillScripts, "benchmark", "rasterize_deck_control.py"),
    path.join(skillScripts, "lib", "normalize_pptx.py"),
    path.join(root, "package.json"),
    path.join(root, "package-lock.json"),
  ];
  const files = [...await collectJavaScriptDependencyClosure(seeds), ...manual].map((file) => path.resolve(file));
  for (const file of files) if (!await exists(file)) throw new Error(`Required C15 implementation dependency is missing: ${file}.`);
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}
