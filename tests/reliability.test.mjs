import assert from "node:assert/strict";
import test from "node:test";
import { buildDeliveryManifest } from "../plugins/slidewright/skills/slidewright/scripts/lib/delivery.mjs";
import { buildPreflightReport, evaluateCachedPluginIdentity } from "../plugins/slidewright/skills/slidewright/scripts/lib/preflight.mjs";

function healthyProbes() {
  return {
    skill: true,
    skillPath: "C:/slidewright/SKILL.md",
    nodeVersion: "20.18.0",
    python: { available: true, detail: "Python 3.11" },
    artifactTool: { path: "C:/slidewright/node_modules/@oai/artifact-tool/package.json", version: "2.8.22" },
    presentationRuntime: { version: "26.709.11516", tools: "C:/codex/presentations/container_tools" },
    fonts: { Arial: true, Georgia: true },
    powerPoint: { available: true, detail: "C:/Program Files/Microsoft Office/POWERPNT.EXE" },
    libreOffice: { available: false, detail: null },
  };
}

test("preflight passes when all required capabilities are available", () => {
  const report = buildPreflightReport(healthyProbes());
  assert.equal(report.valid, true);
  assert.equal(report.buildEnvironment.selectedRenderer, "codex-presentation-runtime");
  assert.equal(report.buildEnvironment.artifactToolVersion, "2.8.22");
  assert.equal(report.checks.filter((check) => check.required && !check.ok).length, 0);
});

test("preflight fails each required capability with actionable remediation", () => {
  const mutations = {
    skill: (probes) => { probes.skill = false; },
    node: (probes) => { probes.nodeVersion = "18.20.0"; },
    python: (probes) => { probes.python = { available: false, detail: null }; },
    "artifact-tool": (probes) => { probes.artifactTool = null; },
    "presentation-renderer": (probes) => { probes.presentationRuntime = null; },
    fonts: (probes) => { probes.fonts.Georgia = false; },
  };
  for (const [id, mutate] of Object.entries(mutations)) {
    const probes = healthyProbes();
    mutate(probes);
    const report = buildPreflightReport(probes);
    const failed = report.checks.find((check) => check.id === id);
    assert.equal(report.valid, false, `${id} should fail the report`);
    assert.equal(failed.ok, false, `${id} should be marked unavailable`);
    assert.match(failed.remediation, /\S+/, `${id} should include remediation`);
  }
});

test("preflight reports optional PowerPoint absence without blocking generation", () => {
  const probes = healthyProbes();
  probes.powerPoint = { available: false, detail: null };
  const report = buildPreflightReport(probes);
  assert.equal(report.valid, true);
  assert.equal(report.checks.find((check) => check.id === "powerpoint").ok, false);
  assert.match(report.checks.find((check) => check.id === "powerpoint").remediation, /PowerPoint/);
});

test("preflight exposes loaded plugin identity and warns on same-version cache drift", () => {
  const probes = healthyProbes();
  probes.pluginIdentity = {
    loaded: { skillPath: "C:/cache/slidewright/SKILL.md", version: "0.2.1", skillSha256: "a".repeat(64) },
    repository: { skillPath: "C:/repo/plugins/slidewright/skills/slidewright/SKILL.md", version: "0.2.1", skillSha256: "b".repeat(64), commit: "c".repeat(40) },
    cacheMismatch: true,
    versionCollision: true,
    buildIdentifier: "c".repeat(40),
    warning: "Loaded cache differs while both claim the same version.",
  };
  const report = buildPreflightReport(probes);
  assert.equal(report.valid, true);
  assert.equal(report.pluginIdentity.versionCollision, true);
  assert.equal(report.checks.find((check) => check.id === "plugin-identity").ok, false);
  assert.equal(report.warnings.length, 1);
});

test("preflight cache identity accepts a matching current package alongside retained older versions", () => {
  const currentHash = "a".repeat(64);
  const evaluation = evaluateCachedPluginIdentity([
    { version: "0.2.1", skillSha256: "b".repeat(64), pluginRoot: "C:/cache/0.2.1" },
    { version: "0.3.0", skillSha256: currentHash, pluginRoot: "C:/cache/0.3.0" },
  ], "0.3.0", currentHash);
  assert.equal(evaluation.installedCacheMismatch, false);
  assert.equal(evaluation.versionCollision, false);
  assert.equal(evaluation.matchingCachedPackages.length, 1);
  assert.deepEqual(evaluation.staleCachedPackages, []);
});

test("delivery manifest requires a real nonempty PowerPoint package", () => {
  const manifest = buildDeliveryManifest({
    filePath: "deck.pptx",
    canonicalPath: "C:/outputs/deck.pptx",
    size: 2048,
    sha256: "abc123",
    inspection: { zipIntegrity: true, requiredParts: true, hasSlides: true, slideCount: 3 },
    previews: ["C:/outputs/previews/slide-1.png", "C:/outputs/previews/slide-2.png", "C:/outputs/previews/slide-3.png"],
    montagePath: "C:/outputs/montage.png",
    handoffPath: "C:/outputs/DELIVERY.md",
    requireBundle: true,
  });
  assert.equal(manifest.valid, true);
  assert.equal(manifest.file.slideCount, 3);
  assert.equal(manifest.bundleValid, true);
  assert.match(manifest.markdownLink, /deck\.pptx/);
});

test("delivery manifest does not claim a complete bundle without matching previews, montage, and handoff", () => {
  const manifest = buildDeliveryManifest({
    filePath: "deck.pptx",
    canonicalPath: "C:/outputs/deck.pptx",
    size: 2048,
    sha256: "abc123",
    inspection: { zipIntegrity: true, requiredParts: true, hasSlides: true, slideCount: 3 },
    previews: ["C:/outputs/previews/slide-1.png"],
    requireBundle: true,
  });
  assert.equal(manifest.deckValid, true);
  assert.equal(manifest.bundleValid, false);
  assert.equal(manifest.valid, false);
});

test("delivery manifest rejects missing, empty, corrupt, and non-PPTX outputs", () => {
  const failures = [
    { filePath: "deck.pptx", canonicalPath: null, size: 0, inspection: {} },
    { filePath: "deck.pptx", canonicalPath: "C:/deck.pptx", size: 0, inspection: { zipIntegrity: true, requiredParts: true, hasSlides: true } },
    { filePath: "deck.pptx", canonicalPath: "C:/deck.pptx", size: 1, inspection: { zipIntegrity: false, requiredParts: true, hasSlides: true } },
    { filePath: "deck.zip", canonicalPath: "C:/deck.zip", size: 1, inspection: { zipIntegrity: true, requiredParts: true, hasSlides: true } },
  ];
  for (const fixture of failures) {
    const manifest = buildDeliveryManifest({ ...fixture, sha256: null });
    assert.equal(manifest.valid, false);
  }
});
