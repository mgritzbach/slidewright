import { spawnSync } from "node:child_process";

function normalizeFont(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function addFont(target, value) {
  for (const name of String(value ?? "").split(",")) {
    const trimmed = name.trim();
    if (trimmed) target.add(trimmed);
  }
}

function collectMacFontNames(value, target) {
  if (Array.isArray(value)) {
    for (const item of value) collectMacFontNames(item, target);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && ["_name", "family", "family_name"].includes(key)) addFont(target, child);
    else collectMacFontNames(child, target);
  }
}

export function auditFonts(plan, availableFonts, collectionError = null) {
  const available = new Map(availableFonts.map((name) => [normalizeFont(name), name]));
  const requested = new Set();
  if (plan.theme?.fontFamily) requested.add(plan.theme.fontFamily);
  for (const slide of plan.slides ?? []) {
    for (const shape of slide.shapes ?? []) {
      if (shape.type === "text" && shape.style?.typeface) requested.add(shape.style.typeface);
      for (const run of shape.text?.runs ?? []) if (run.typeface) requested.add(run.typeface);
    }
  }
  const fallback = plan.theme?.fallbackFontFamily ?? null;
  const fallbackAvailable = fallback ? available.has(normalizeFont(fallback)) : false;
  const checks = [...requested].sort().map((fontFamily) => ({
    fontFamily,
    available: available.has(normalizeFont(fontFamily)),
    resolvedFamily: available.get(normalizeFont(fontFamily)) ?? null,
  }));
  const diagnostics = [];
  if (collectionError) {
    diagnostics.push({
      ruleId: "SWF000",
      severity: "error",
      fontFamily: null,
      message: `Installed fonts could not be enumerated: ${collectionError}`,
      remediation: "Repair the operating-system font service or run the build on a supported host; Slidewright will not guess font availability.",
    });
  }
  for (const check of checks.filter((item) => !item.available)) {
    diagnostics.push({
      ruleId: "SWF001",
      severity: "error",
      fontFamily: check.fontFamily,
      message: `Required font '${check.fontFamily}' is not installed. Rendering is blocked to prevent silent substitution.`,
      remediation: fallbackAvailable
        ? `Install '${check.fontFamily}', or explicitly set theme.fontFamily to the installed fallback '${fallback}' and recompile.`
        : `Install '${check.fontFamily}', or explicitly choose an installed theme.fontFamily and recompile.`,
    });
  }
  return {
    valid: diagnostics.length === 0,
    generatedAt: new Date().toISOString(),
    requestedFonts: checks,
    fallback: { fontFamily: fallback, available: fallbackAvailable },
    availableFontCount: available.size,
    diagnostics,
    suggestedThemePatch: diagnostics.some((item) => item.ruleId === "SWF001") && fallbackAvailable ? { fontFamily: fallback } : null,
    substitutionApplied: false,
  };
}

export function collectInstalledFonts({ platform = process.platform } = {}) {
  const fonts = new Set();
  let result;
  if (platform === "win32") {
    result = spawnSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) for (const line of result.stdout.split(/\r?\n/u)) addFont(fonts, line);
  } else if (platform === "darwin") {
    result = spawnSync("system_profiler", ["SPFontsDataType", "-json"], { encoding: "utf8" });
    if (!result.error && result.status === 0) {
      try { collectMacFontNames(JSON.parse(result.stdout), fonts); } catch { /* reported below */ }
    }
  } else {
    result = spawnSync("fc-list", ["-f", "%{family}\n"], { encoding: "utf8" });
    if (!result.error && result.status === 0) for (const line of result.stdout.split(/\r?\n/u)) addFont(fonts, line);
  }
  const error = result?.error?.message || (result?.status === 0 && fonts.size > 0 ? null : (result?.stderr || `font enumeration returned status ${result?.status ?? "unknown"}`).trim());
  return { fonts: [...fonts].sort((a, b) => a.localeCompare(b)), error };
}

export function inspectPlanFonts(plan, options = {}) {
  const inventory = collectInstalledFonts(options);
  return auditFonts(plan, inventory.fonts, inventory.error);
}
