import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptDeckCopyToFit } from "./copy-adaptation.mjs";
import { inspectPlanFonts } from "./font-audit.mjs";
import { lintPlan } from "./linter.mjs";
import { renderPlan } from "./renderer.mjs";
import { lintRenderedLayouts } from "./rendered-linter.mjs";
import { evaluateRequestPolicy, IMMUTABLE_REQUEST_STAGES, REQUEST_QUALITY_CONTRACT } from "./request-policy.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { buildExecutiveReview, REVIEW_MODE_OFF, REVIEW_MODE_OVERLAY } from "./executive-review.mjs";
import { groundPlanWithReference, validateDesignProvenance } from "./reference-grounding.mjs";

const RUN_SCHEMA_VERSION = "slidewright-request-run/v1";
const AUDIT_PATH = fileURLToPath(new URL("../audit_pptx.py", import.meta.url));
const PLAN_AUDIT_PATH = fileURLToPath(new URL("../audit_request_plan.py", import.meta.url));
const EXECUTIVE_REVIEW_AUDIT_PATH = fileURLToPath(new URL("../audit_executive_review.py", import.meta.url));
const IMPLEMENTATION_PATHS = Object.freeze([
  fileURLToPath(import.meta.url),
  fileURLToPath(new URL("./request-policy.mjs", import.meta.url)),
  fileURLToPath(new URL("./strict-json.mjs", import.meta.url)),
  fileURLToPath(new URL("./compiler.mjs", import.meta.url)),
  fileURLToPath(new URL("./copy-adaptation.mjs", import.meta.url)),
  fileURLToPath(new URL("./linter.mjs", import.meta.url)),
  fileURLToPath(new URL("./rendered-linter.mjs", import.meta.url)),
  fileURLToPath(new URL("./renderer.mjs", import.meta.url)),
  fileURLToPath(new URL("./executive-review.mjs", import.meta.url)),
  fileURLToPath(new URL("./reference-grounding.mjs", import.meta.url)),
  fileURLToPath(new URL("./delivery.mjs", import.meta.url)),
  AUDIT_PATH,
  PLAN_AUDIT_PATH,
  EXECUTIVE_REVIEW_AUDIT_PATH,
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

async function implementationSha256() {
  const hash = createHash("sha256");
  for (const filePath of [...IMPLEMENTATION_PATHS].sort()) {
    hash.update(path.basename(filePath));
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function guardedDeliveryManifest({ deckSha256, deckBytes, slideCount, previewHashes }) {
  return {
    schemaVersion: "slidewright-request-delivery/v1",
    valid: deckBytes > 0 && slideCount > 0 && previewHashes.length === slideCount,
    canonicalWithinRun: true,
    deck: { path: "deck.pptx", sha256: deckSha256, bytes: deckBytes, slideCount, zipIntegrity: true, requiredParts: true },
    previews: previewHashes.map((item) => ({ path: `previews/${item.file}`, sha256: item.sha256 })),
    montage: { path: "previews/deck-montage.webp" },
    handoff: { path: "DELIVERY.md" },
  };
}

async function pathExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function listFiles(root, directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Unsupported request-run filesystem entry: ${absolute}`);
  }
  return files;
}

async function artifactInventory(root) {
  const files = (await listFiles(root)).filter((file) => file !== "run.json");
  return Promise.all(files.map(async (file) => {
    const bytes = await fs.readFile(path.join(root, ...file.split("/")));
    return { path: file, bytes: bytes.length, sha256: sha256Bytes(bytes) };
  }));
}

async function resolvePython() {
  if (process.env.SLIDEWRIGHT_PYTHON) return process.env.SLIDEWRIGHT_PYTHON;
  const bundled = path.join(os.homedir(), ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", process.platform === "win32" ? "python.exe" : "bin/python");
  if (await pathExists(bundled)) return bundled;
  return "python";
}

function planQuality(plan) {
  const text = plan.slides.flatMap((slide) => slide.shapes).filter((shape) => shape.type === "text");
  const roleMinimaValid = text.every((shape) => {
    const contractMinimum = REQUEST_QUALITY_CONTRACT.minimumFontSizeByRolePt[shape.role];
    return contractMinimum == null || (shape.fit?.minSizePt >= contractMinimum && shape.style?.fontSizePt >= contractMinimum);
  });
  const immutableLayoutPolicy = plan.layout?.geometryTolerance === REQUEST_QUALITY_CONTRACT.geometryTolerancePx
    && stableJson(plan.layout?.approvedFontSizesPt) === stableJson(REQUEST_QUALITY_CONTRACT.approvedFontSizesPt)
    && stableJson(plan.designSystem?.insetTokensPx) === stableJson(REQUEST_QUALITY_CONTRACT.insetTokensPx)
    && plan.designSystem?.maximumInsetPx === REQUEST_QUALITY_CONTRACT.maximumInsetPx
    && stableJson(plan.designSystem?.paragraphSpacingPt) === stableJson(REQUEST_QUALITY_CONTRACT.paragraphSpacingPt)
    && plan.designSystem?.logicalMaster?.nativePowerPointMasterClaimed === false
    && plan.slides.every((slide) => slide.quality == null
      && typeof slide.archetypeId === "string"
      && slide.designMasterId === plan.designSystem?.logicalMaster?.id
      && Array.isArray(slide.typedExceptions)
      && slide.typedExceptions.length === 0);
  return {
    slideCount: plan.slides.length,
    textShapeCount: text.length,
    allTextFits: text.every((shape) => shape.fit?.fits === true),
    allWholePoint: text.every((shape) => Number.isInteger(shape.style?.fontSizePt)),
    noSubminimumType: text.every((shape) => shape.style?.fontSizePt >= shape.fit?.minSizePt),
    nativeEditableText: text.every((shape) => shape.editable === true),
    roleMinimaValid,
    immutableLayoutPolicy,
  };
}

function failedStage(name, error) {
  return { name, status: "failed", error: error instanceof Error ? error.message : String(error) };
}

function faultAfter(stage) {
  if (process.env.SLIDEWRIGHT_REQUEST_FAULT_AFTER === stage) throw new Error(`Injected request-run fault after ${stage}.`);
}

async function finalizeRun(staging, outputDir, run) {
  run.artifacts = await artifactInventory(staging);
  await writeJson(path.join(staging, "run.json"), run);
  let renamed = false;
  let lastError;
  for (let attempt = 0; attempt < 30 && !renamed; attempt += 1) {
    try {
      await fs.rename(staging, outputDir);
      renamed = true;
    } catch (error) {
      lastError = error;
      if (!(["EPERM", "EBUSY", "EACCES"].includes(error.code)) || await pathExists(outputDir)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!renamed) throw lastError ?? new Error(`Atomic request-run publication failed for ${outputDir}.`);
  return { outputDir, run };
}

export async function runRequestBuild({ requestPath, outputDir, referenceProfilePath = null }) {
  const absoluteOutput = path.resolve(outputDir);
  if (await pathExists(absoluteOutput)) throw new Error(`Request output already exists: ${absoluteOutput}`);
  await fs.mkdir(path.dirname(absoluteOutput), { recursive: true });
  const staging = `${absoluteOutput}.staging-${process.pid}-${Date.now()}`;
  await fs.mkdir(staging, { recursive: false });
  const requestBytes = await fs.readFile(requestPath);
  let request;
  try { request = parseStrictJson(requestBytes); } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw new Error(`Request envelope is not valid JSON: ${error.message}`, { cause: error });
  }
  await fs.writeFile(path.join(staging, "request.json"), requestBytes);
  const requestSha256 = sha256Bytes(requestBytes);
  const promptSha256 = sha256Bytes(Buffer.from(typeof request.prompt === "string" ? request.prompt : "", "utf8"));
  const specSha256 = sha256Bytes(Buffer.from(stableJson(request.spec ?? null), "utf8"));
  const policy = evaluateRequestPolicy(request);
  let referenceProfile = null;
  let referenceProfileBytes = null;
  if (referenceProfilePath) {
    referenceProfileBytes = await fs.readFile(referenceProfilePath);
    if (referenceProfileBytes.length > 100 * 1024 * 1024) {
      await fs.rm(staging, { recursive: true, force: true });
      throw new Error("Reference profile exceeds the 100 MiB artifact limit.");
    }
    try { referenceProfile = parseStrictJson(referenceProfileBytes, { maxBytes: 100 * 1024 * 1024 }); } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw new Error(`Reference profile is not valid JSON: ${error.message}`, { cause: error });
    }
  }
  const implementationHash = await implementationSha256();
  const contractSha256 = sha256Bytes(Buffer.from(stableJson(REQUEST_QUALITY_CONTRACT), "utf8"));
  await writeJson(path.join(staging, "policy.json"), policy);
  const policySha256 = await sha256File(path.join(staging, "policy.json"));
  const run = {
    schemaVersion: RUN_SCHEMA_VERSION,
    requestId: typeof request.id === "string" ? request.id : null,
    outcome: policy.valid ? "building" : "rejected",
    valid: false,
    promptTreatedAsData: true,
    promptExecuted: false,
    requestSha256,
    promptSha256,
    specSha256,
    contractSha256,
    implementationSha256: implementationHash,
    immutableStages: [...IMMUTABLE_REQUEST_STAGES],
    referenceGrounding: {
      enabled: Boolean(referenceProfile),
      profileFileSha256: referenceProfileBytes ? sha256Bytes(referenceProfileBytes) : null,
      profileSha256: referenceProfile?.profileSha256 ?? null,
    },
    stages: [{
      name: "policy",
      status: policy.valid ? "passed" : "rejected",
      inputSha256: requestSha256,
      outputSha256: policySha256,
      diagnosticRuleIds: policy.diagnostics.map((item) => item.ruleId),
    }],
    quality: null,
    artifacts: [],
  };
  if (!policy.valid) return finalizeRun(staging, absoluteOutput, run);

  try {
    faultAfter("policy");
    const adaptation = adaptDeckCopyToFit(request.spec);
    let plan = adaptation.plan;
    let provenance = null;
    if (referenceProfile) {
      const grounded = groundPlanWithReference(plan, referenceProfile);
      plan = grounded.plan;
      provenance = grounded.provenance;
      await fs.writeFile(path.join(staging, "reference-profile.json"), referenceProfileBytes);
      await writeJson(path.join(staging, "design-provenance.json"), provenance);
    }
    await writeJson(path.join(staging, "adapted-spec.json"), adaptation.spec);
    await writeJson(path.join(staging, "adaptation.json"), adaptation.manifest);
    await writeJson(path.join(staging, "plan.json"), plan);
    const adaptedSpecSha256 = await sha256File(path.join(staging, "adapted-spec.json"));
    const adaptationSha256 = await sha256File(path.join(staging, "adaptation.json"));
    const planSha256 = await sha256File(path.join(staging, "plan.json"));
    run.stages.push({
      name: "compile",
      status: "passed",
      inputSha256: specSha256,
      adaptedSpecSha256,
      adaptationSha256,
      outputSha256: planSha256,
      referenceProfileSha256: referenceProfile ? await sha256File(path.join(staging, "reference-profile.json")) : null,
      designProvenanceSha256: provenance ? await sha256File(path.join(staging, "design-provenance.json")) : null,
    });
    faultAfter("compile");

    const fonts = inspectPlanFonts(plan);
    await writeJson(path.join(staging, "font-report.json"), fonts);
    const fontSha256 = await sha256File(path.join(staging, "font-report.json"));
    run.stages.push({ name: "fonts", status: fonts.valid ? "passed" : "failed", inputSha256: planSha256, outputSha256: fontSha256 });
    if (!fonts.valid) throw new Error("Font audit rejected the request plan.");
    faultAfter("fonts");

    const lint = lintPlan(plan);
    await writeJson(path.join(staging, "lint-report.json"), lint);
    const lintSha256 = await sha256File(path.join(staging, "lint-report.json"));
    run.stages.push({ name: "lint", status: lint.valid && lint.counts.warning === 0 ? "passed" : "failed", inputSha256: planSha256, outputSha256: lintSha256 });
    if (!lint.valid || lint.counts.warning !== 0) throw new Error("Plan lint rejected the request plan.");
    faultAfter("lint");

    const deckPath = path.join(staging, "deck.pptx");
    const previewDir = path.join(staging, "previews");
    const rendered = await renderPlan(plan, { out: deckPath, previewDir });
    const deckSha256 = await sha256File(deckPath);
    const renderedLintPath = path.join(previewDir, "rendered-lint-report.json");
    const renderedLintSha256 = await sha256File(renderedLintPath);
    const previewFiles = (await fs.readdir(previewDir)).filter((file) => /^slide-\d+\.png$/u.test(file)).sort();
    const previewHashes = await Promise.all(previewFiles.map(async (file) => ({ file, sha256: await sha256File(path.join(previewDir, file)) })));
    run.stages.push({
      name: "render",
      status: rendered.renderedLint.valid && rendered.renderedLint.counts.warning === 0 ? "passed" : "failed",
      inputSha256: planSha256,
      outputSha256: deckSha256,
      renderedLintSha256,
      previewHashes,
    });
    if (!rendered.renderedLint.valid || rendered.renderedLint.counts.warning !== 0) throw new Error("Rendered-layout lint rejected the request deck.");
    faultAfter("render");

    const auditPath = path.join(staging, "audit.json");
    const planAuditPath = path.join(staging, "plan-audit.json");
    const python = await resolvePython();
    const auditRun = spawnSync(python, [AUDIT_PATH, deckPath, "--json", auditPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    if (auditRun.error || auditRun.status !== 0) throw auditRun.error ?? new Error(`OOXML audit failed: ${(auditRun.stderr || auditRun.stdout || "").trim()}`);
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8"));
    const auditSha256 = await sha256File(auditPath);
    const planAuditRun = spawnSync(python, [PLAN_AUDIT_PATH, deckPath, path.join(staging, "plan.json"), "--json", planAuditPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    if (planAuditRun.error || planAuditRun.status !== 0) throw planAuditRun.error ?? new Error(`Plan-bound OOXML audit failed: ${(planAuditRun.stderr || planAuditRun.stdout || "").trim()}`);
    const planAudit = JSON.parse(await fs.readFile(planAuditPath, "utf8"));
    const planAuditSha256 = await sha256File(planAuditPath);
    run.stages.push({
      name: "audit",
      status: audit.valid && planAudit.valid ? "passed" : "failed",
      inputSha256: deckSha256,
      genericAuditSha256: auditSha256,
      planAuditSha256,
    });
    if (!audit.valid || !planAudit.valid) throw new Error("OOXML audit rejected the request deck.");
    faultAfter("audit");

    const reviewMode = request.reviewMode ?? REVIEW_MODE_OFF;
    const executiveReview = buildExecutiveReview(plan, reviewMode);
    const executiveReviewPath = path.join(staging, "executive-review.json");
    const cleanReviewAuditPath = path.join(staging, "executive-review-clean-audit.json");
    await writeJson(executiveReviewPath, executiveReview);
    const cleanReviewAuditRun = spawnSync(python, [EXECUTIVE_REVIEW_AUDIT_PATH, deckPath, "--expect-clean", "--json", cleanReviewAuditPath], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true,
    });
    if (cleanReviewAuditRun.error || cleanReviewAuditRun.status !== 0) throw cleanReviewAuditRun.error ?? new Error(`Canonical-deck E6 audit failed: ${(cleanReviewAuditRun.stderr || cleanReviewAuditRun.stdout || "").trim()}`);
    const cleanReviewAudit = await readJson(cleanReviewAuditPath);
    if (!cleanReviewAudit.valid || cleanReviewAudit.actualOverlayCount !== 0) throw new Error("Canonical deck contains executive-review overlays.");

    let reviewDeck = null;
    let reviewDeckAudit = null;
    let reviewOverlayAudit = null;
    let reviewRendered = null;
    let reviewPreviewHashes = [];
    if (reviewMode === REVIEW_MODE_OVERLAY) {
      const reviewDeckPath = path.join(staging, "deck.executive-review.pptx");
      const reviewPreviewDir = path.join(staging, "executive-review-previews");
      reviewRendered = await renderPlan(plan, { out: reviewDeckPath, previewDir: reviewPreviewDir, executiveReview });
      const reviewDeckAuditPath = path.join(staging, "executive-review-deck-audit.json");
      const reviewDeckAuditRun = spawnSync(python, [AUDIT_PATH, reviewDeckPath, "--json", reviewDeckAuditPath], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
      });
      if (reviewDeckAuditRun.error || reviewDeckAuditRun.status !== 0) throw reviewDeckAuditRun.error ?? new Error(`Executive-review deck audit failed: ${(reviewDeckAuditRun.stderr || reviewDeckAuditRun.stdout || "").trim()}`);
      reviewDeckAudit = await readJson(reviewDeckAuditPath);
      const reviewOverlayAuditPath = path.join(staging, "executive-review-overlay-audit.json");
      const reviewOverlayAuditRun = spawnSync(python, [EXECUTIVE_REVIEW_AUDIT_PATH, reviewDeckPath, "--manifest", executiveReviewPath, "--json", reviewOverlayAuditPath], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
      });
      if (reviewOverlayAuditRun.error || reviewOverlayAuditRun.status !== 0) throw reviewOverlayAuditRun.error ?? new Error(`Executive-review overlay audit failed: ${(reviewOverlayAuditRun.stderr || reviewOverlayAuditRun.stdout || "").trim()}`);
      reviewOverlayAudit = await readJson(reviewOverlayAuditPath);
      const reviewPreviewFiles = (await fs.readdir(reviewPreviewDir)).filter((file) => /^slide-\d+\.png$/u.test(file)).sort();
      reviewPreviewHashes = await Promise.all(reviewPreviewFiles.map(async (file) => ({ file, sha256: await sha256File(path.join(reviewPreviewDir, file)) })));
      reviewDeck = {
        path: "deck.executive-review.pptx",
        sha256: await sha256File(reviewDeckPath),
        bytes: (await fs.stat(reviewDeckPath)).size,
      };
      if (!reviewRendered.renderedLint.valid || reviewRendered.renderedLint.counts.warning !== 0 || !reviewDeckAudit.valid || !reviewOverlayAudit.valid) {
        throw new Error("Executive-review copy failed render or OOXML quality closure.");
      }
    }
    const executiveReviewSha256 = await sha256File(executiveReviewPath);
    const cleanReviewAuditSha256 = await sha256File(cleanReviewAuditPath);
    run.stages.push({
      name: "executive-review",
      status: "passed",
      mode: reviewMode,
      inputSha256: deckSha256,
      manifestSha256: executiveReviewSha256,
      cleanAuditSha256: cleanReviewAuditSha256,
      canonicalDeckModified: false,
      findingCount: executiveReview.counts.findings,
      reviewDeck,
      reviewPreviewHashes,
      ...(reviewMode === REVIEW_MODE_OVERLAY ? {
        reviewDeckAuditSha256: await sha256File(path.join(staging, "executive-review-deck-audit.json")),
        reviewOverlayAuditSha256: await sha256File(path.join(staging, "executive-review-overlay-audit.json")),
      } : {}),
    });
    faultAfter("executive-review");

    const deliveryPath = path.join(staging, "delivery.json");
    const deckBytes = (await fs.stat(deckPath)).size;
    const delivery = guardedDeliveryManifest({ deckSha256, deckBytes, slideCount: plan.slides.length, previewHashes });
    const handoffText = [
      "# Slidewright guarded request delivery",
      "",
      "Deck: deck.pptx",
      `SHA-256: ${deckSha256}`,
      `Slides: ${plan.slides.length}`,
      "Previews: previews/slide-XX.png",
      "Montage: previews/deck-montage.webp",
      "Receipt: run.json",
      `Executive review: ${reviewMode === REVIEW_MODE_OVERLAY ? "deck.executive-review.pptx (editable yellow partner checks; canonical deck remains clean)" : "off (no annotated copy created)"}`,
      "",
      "Open deck.pptx in PowerPoint or another presentation application after request-verify passes.",
      "",
    ].join("\n");
    await fs.writeFile(path.join(staging, "DELIVERY.md"), handoffText, "utf8");
    await writeJson(deliveryPath, delivery);
    const deliverySha256 = await sha256File(deliveryPath);
    run.stages.push({ name: "delivery", status: delivery.valid ? "passed" : "failed", inputSha256: deckSha256, outputSha256: deliverySha256 });
    if (!delivery.valid) throw new Error("Delivery verification rejected the request deck.");
    faultAfter("delivery");

    const quality = planQuality(plan);
    const designProvenanceValid = !referenceProfile || validateDesignProvenance(provenance, plan, referenceProfile).valid;
    run.quality = {
      ...quality,
      zeroWarnings: lint.counts.warning === 0 && rendered.renderedLint.counts.warning === 0,
      nativeTextNodes: audit.summary.nativeTextNodes,
      pictureCount: audit.summary.pictures,
      previewCount: previewFiles.length,
      expectedPreviewCount: plan.slides.length,
      ooxmlChecks: audit.checks,
      planAuditValid: planAudit.valid,
      matchedTextObjects: planAudit.matchedTextObjects,
      expectedTextObjects: planAudit.expectedTextObjects,
      deliveryValid: delivery.valid,
      executiveReviewMode: reviewMode,
      executiveReviewFindingCount: executiveReview.counts.findings,
      canonicalExecutiveReviewOverlayCount: cleanReviewAudit.actualOverlayCount,
      executiveReviewCopyValid: reviewMode === REVIEW_MODE_OFF || Boolean(reviewDeckAudit?.valid && reviewOverlayAudit?.valid && reviewRendered?.renderedLint?.valid),
      referenceGroundingEnabled: Boolean(referenceProfile),
      designProvenanceValid,
    };
    run.valid = Object.values(quality).every((value) => typeof value !== "boolean" || value)
      && run.quality.zeroWarnings
      && run.quality.pictureCount === 0
      && run.quality.previewCount === run.quality.expectedPreviewCount
      && Object.values(audit.checks).every(Boolean)
      && planAudit.valid
      && delivery.valid
      && run.quality.canonicalExecutiveReviewOverlayCount === 0
      && run.quality.executiveReviewCopyValid
      && run.quality.designProvenanceValid
      && run.stages.map((stage) => stage.name).join("|") === IMMUTABLE_REQUEST_STAGES.join("|")
      && run.stages.every((stage) => stage.status === "passed");
    run.outcome = run.valid ? "built" : "failed";
    if (!run.valid) throw new Error("The request build completed stages but failed the final quality closure.");
    faultAfter("before-publication");
  } catch (error) {
    const completed = new Set(run.stages.map((stage) => stage.name));
    const current = IMMUTABLE_REQUEST_STAGES.find((stage) => !completed.has(stage));
    if (current) run.stages.push(failedStage(current, error));
    else if (run.stages.at(-1)?.status === "passed") run.stages.push(failedStage("quality", error));
    run.valid = false;
    run.outcome = "failed";
    run.quality = null;
    await Promise.all([
      fs.rm(path.join(staging, "deck.pptx"), { force: true }),
      fs.rm(path.join(staging, "previews"), { recursive: true, force: true }),
      fs.rm(path.join(staging, "audit.json"), { force: true }),
      fs.rm(path.join(staging, "plan-audit.json"), { force: true }),
      fs.rm(path.join(staging, "delivery.json"), { force: true }),
      fs.rm(path.join(staging, "DELIVERY.md"), { force: true }),
      fs.rm(path.join(staging, "executive-review.json"), { force: true }),
      fs.rm(path.join(staging, "executive-review-clean-audit.json"), { force: true }),
      fs.rm(path.join(staging, "deck.executive-review.pptx"), { force: true }),
      fs.rm(path.join(staging, "executive-review-deck-audit.json"), { force: true }),
      fs.rm(path.join(staging, "executive-review-overlay-audit.json"), { force: true }),
      fs.rm(path.join(staging, "executive-review-previews"), { recursive: true, force: true }),
    ]);
  }
  return finalizeRun(staging, absoluteOutput, run);
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

export async function verifyRequestRun(runDir) {
  const diagnostics = [];
  let run;
  try { run = await readJson(path.join(runDir, "run.json")); } catch (error) {
    return { valid: false, outcome: null, diagnostics: [`Unreadable run.json: ${error.message}`] };
  }
  if (run.schemaVersion !== RUN_SCHEMA_VERSION) diagnostics.push("Unexpected run schema version.");
  if (run.contractSha256 !== sha256Bytes(Buffer.from(stableJson(REQUEST_QUALITY_CONTRACT), "utf8"))) diagnostics.push("Request quality contract hash drift.");
  if (run.implementationSha256 !== await implementationSha256()) diagnostics.push("Request implementation hash drift.");
  const files = await listFiles(runDir);
  const actualArtifacts = await artifactInventory(runDir);
  if (!sameJson(actualArtifacts, run.artifacts)) diagnostics.push("Artifact inventory or content hash drift.");
  if (files.length !== actualArtifacts.length + 1 || !files.includes("run.json")) diagnostics.push("Run file inventory is not closed.");
  const requestPath = path.join(runDir, "request.json");
  const policyPath = path.join(runDir, "policy.json");
  if (!await pathExists(requestPath) || !await pathExists(policyPath)) diagnostics.push("Request or policy artifact is missing.");
  let request;
  let policy;
  if (!diagnostics.length) {
    request = await readJson(requestPath);
    policy = await readJson(policyPath);
    const requestBytes = await fs.readFile(requestPath);
    if (sha256Bytes(requestBytes) !== run.requestSha256) diagnostics.push("Request hash mismatch.");
    if (sha256Bytes(Buffer.from(request.prompt ?? "", "utf8")) !== run.promptSha256) diagnostics.push("Prompt hash mismatch.");
    if (sha256Bytes(Buffer.from(stableJson(request.spec ?? null), "utf8")) !== run.specSha256) diagnostics.push("Specification hash mismatch.");
    const recomputedPolicy = evaluateRequestPolicy(request);
    if (!sameJson(recomputedPolicy, policy)) diagnostics.push("Policy report does not match the bound request.");
    if (run.promptTreatedAsData !== true || run.promptExecuted !== false || policy.promptExecuted !== false) diagnostics.push("Prompt execution boundary is not proven.");
    if (!sameJson(run.immutableStages, IMMUTABLE_REQUEST_STAGES)) diagnostics.push("Immutable stage declaration drift.");
  }

  if (run.outcome === "rejected") {
    if (policy?.valid !== false || !policy?.diagnostics?.length) diagnostics.push("Rejected run lacks policy diagnostics.");
    if (!sameJson(run.stages.map((stage) => stage.name), ["policy"]) || run.stages[0]?.status !== "rejected") diagnostics.push("Rejected run executed or claimed extra stages.");
    const forbidden = ["adapted-spec.json", "adaptation.json", "plan.json", "reference-profile.json", "design-provenance.json", "font-report.json", "lint-report.json", "deck.pptx", "audit.json", "plan-audit.json", "executive-review.json", "executive-review-clean-audit.json", "deck.executive-review.pptx", "executive-review-deck-audit.json", "executive-review-overlay-audit.json", "executive-review-previews", "delivery.json", "DELIVERY.md", "previews"];
    for (const item of forbidden) if (files.some((file) => file === item || file.startsWith(`${item}/`))) diagnostics.push(`Rejected run published forbidden artifact '${item}'.`);
    if (run.valid !== false) diagnostics.push("Rejected run cannot be marked valid.");
    return { valid: diagnostics.length === 0, outcome: run.outcome, diagnostics };
  }

  if (run.outcome !== "built" || run.valid !== true || policy?.valid !== true) diagnostics.push("Accepted run is not a valid built run.");
  if (!sameJson(run.stages.map((stage) => stage.name), IMMUTABLE_REQUEST_STAGES)) diagnostics.push("Accepted run did not execute the exact immutable stage sequence.");
  if (!run.stages?.every((stage) => stage.status === "passed")) diagnostics.push("One or more mandatory stages did not pass.");
  const required = ["adapted-spec.json", "adaptation.json", "plan.json", "font-report.json", "lint-report.json", "deck.pptx", "audit.json", "plan-audit.json", "executive-review.json", "executive-review-clean-audit.json", "delivery.json", "DELIVERY.md", "previews/rendered-lint-report.json"];
  if (run.referenceGrounding?.enabled) required.push("reference-profile.json", "design-provenance.json");
  else if (files.includes("reference-profile.json") || files.includes("design-provenance.json")) diagnostics.push("Reference artifacts exist while reference grounding is disabled.");
  for (const item of required) if (!files.includes(item)) diagnostics.push(`Accepted run is missing '${item}'.`);
  if (!diagnostics.length) {
    const [adaptedSpec, adaptationManifest, plan, fonts, lint, audit, planAudit, executiveReview, cleanReviewAudit, delivery, renderedLint] = await Promise.all([
      readJson(path.join(runDir, "adapted-spec.json")),
      readJson(path.join(runDir, "adaptation.json")),
      readJson(path.join(runDir, "plan.json")),
      readJson(path.join(runDir, "font-report.json")),
      readJson(path.join(runDir, "lint-report.json")),
      readJson(path.join(runDir, "audit.json")),
      readJson(path.join(runDir, "plan-audit.json")),
      readJson(path.join(runDir, "executive-review.json")),
      readJson(path.join(runDir, "executive-review-clean-audit.json")),
      readJson(path.join(runDir, "delivery.json")),
      readJson(path.join(runDir, "previews", "rendered-lint-report.json")),
    ]);
    const recomputedAdaptation = adaptDeckCopyToFit(request.spec);
    let recomputedPlan = recomputedAdaptation.plan;
    let provenance = null;
    if (run.referenceGrounding?.enabled) {
      const referenceProfilePath = path.join(runDir, "reference-profile.json");
      const referenceProfile = await readJson(referenceProfilePath);
      provenance = await readJson(path.join(runDir, "design-provenance.json"));
      const grounded = groundPlanWithReference(recomputedPlan, referenceProfile);
      recomputedPlan = grounded.plan;
      if (!sameJson(provenance, grounded.provenance)) diagnostics.push("Design provenance does not match an independent reference-grounding recomputation.");
      const provenanceValidation = validateDesignProvenance(provenance, plan, referenceProfile);
      if (!provenanceValidation.valid) diagnostics.push(`Design provenance validation failed: ${provenanceValidation.diagnostics.join(", ")}.`);
      if (run.referenceGrounding.profileFileSha256 !== await sha256File(referenceProfilePath) || run.referenceGrounding.profileSha256 !== referenceProfile.profileSha256) diagnostics.push("Reference-profile run binding mismatch.");
    } else if (run.referenceGrounding?.profileFileSha256 != null || run.referenceGrounding?.profileSha256 != null) diagnostics.push("Disabled reference grounding claims profile hashes.");
    const reviewMode = request.reviewMode ?? REVIEW_MODE_OFF;
    const recomputedExecutiveReview = buildExecutiveReview(recomputedPlan, reviewMode);
    if (!sameJson(adaptedSpec, recomputedAdaptation.spec)) diagnostics.push("Adapted specification does not match the bound request specification.");
    if (!sameJson(adaptationManifest, recomputedAdaptation.manifest)) diagnostics.push("Copy-adaptation evidence does not match the bound request specification.");
    if (!sameJson(plan, recomputedPlan)) diagnostics.push("Compiled plan does not match the bound request specification.");
    if (!sameJson(executiveReview, recomputedExecutiveReview)) diagnostics.push("Executive-review manifest does not match the bound request and compiled plan.");
    if (!cleanReviewAudit.valid || cleanReviewAudit.actualOverlayCount !== 0) diagnostics.push("Canonical deck contains executive-review overlays.");
    const recomputedLint = lintPlan(plan);
    if (!sameJson(lint, recomputedLint)) diagnostics.push("Plan lint report does not match an independent recomputation.");
    const layoutFiles = files.filter((file) => /^previews\/slide-\d+\.layout\.json$/u.test(file)).sort();
    const layouts = await Promise.all(layoutFiles.map((file) => readJson(path.join(runDir, ...file.split("/")))));
    const recomputedRenderedLint = lintRenderedLayouts(plan, layouts);
    if (!sameJson(renderedLint, recomputedRenderedLint)) diagnostics.push("Rendered lint report does not match an independent recomputation.");
    const auditTemp = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-request-verify-"));
    try {
      const python = await resolvePython();
      const genericPath = path.join(auditTemp, "audit.json");
      const boundPath = path.join(auditTemp, "plan-audit.json");
      const cleanReviewPath = path.join(auditTemp, "executive-review-clean-audit.json");
      const genericRun = spawnSync(python, [AUDIT_PATH, path.join(runDir, "deck.pptx"), "--json", genericPath], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
      const boundRun = spawnSync(python, [PLAN_AUDIT_PATH, path.join(runDir, "deck.pptx"), path.join(runDir, "plan.json"), "--json", boundPath], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
      const cleanReviewRun = spawnSync(python, [EXECUTIVE_REVIEW_AUDIT_PATH, path.join(runDir, "deck.pptx"), "--expect-clean", "--json", cleanReviewPath], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
      if (genericRun.error || genericRun.status !== 0 || boundRun.error || boundRun.status !== 0 || cleanReviewRun.error || cleanReviewRun.status !== 0) diagnostics.push("Independent OOXML re-audit failed.");
      else {
        const [recomputedAudit, recomputedPlanAudit, recomputedCleanReviewAudit] = await Promise.all([readJson(genericPath), readJson(boundPath), readJson(cleanReviewPath)]);
        if (!sameJson(audit, recomputedAudit)) diagnostics.push("Generic OOXML audit does not match an independent recomputation.");
        if (!sameJson(planAudit, recomputedPlanAudit)) diagnostics.push("Plan-bound OOXML audit does not match an independent recomputation.");
        if (!sameJson(cleanReviewAudit, recomputedCleanReviewAudit)) diagnostics.push("Canonical-deck executive-review audit does not match an independent recomputation.");
      }

      if (reviewMode === REVIEW_MODE_OVERLAY) {
        const reviewRequired = ["deck.executive-review.pptx", "executive-review-deck-audit.json", "executive-review-overlay-audit.json", "executive-review-previews/rendered-lint-report.json"];
        for (const item of reviewRequired) if (!files.includes(item)) diagnostics.push(`Executive-review mode is missing '${item}'.`);
        if (reviewRequired.every((item) => files.includes(item))) {
          const reviewGenericPath = path.join(auditTemp, "review-generic.json");
          const reviewOverlayPath = path.join(auditTemp, "review-overlay.json");
          const reviewGenericRun = spawnSync(python, [AUDIT_PATH, path.join(runDir, "deck.executive-review.pptx"), "--json", reviewGenericPath], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
          const reviewOverlayRun = spawnSync(python, [EXECUTIVE_REVIEW_AUDIT_PATH, path.join(runDir, "deck.executive-review.pptx"), "--manifest", path.join(runDir, "executive-review.json"), "--json", reviewOverlayPath], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
          if (reviewGenericRun.error || reviewGenericRun.status !== 0 || reviewOverlayRun.error || reviewOverlayRun.status !== 0) diagnostics.push("Independent executive-review copy audit failed.");
          else {
            const [recordedReviewAudit, recordedOverlayAudit, recomputedReviewAudit, recomputedOverlayAudit] = await Promise.all([
              readJson(path.join(runDir, "executive-review-deck-audit.json")),
              readJson(path.join(runDir, "executive-review-overlay-audit.json")),
              readJson(reviewGenericPath),
              readJson(reviewOverlayPath),
            ]);
            if (!sameJson(recordedReviewAudit, recomputedReviewAudit)) diagnostics.push("Executive-review generic audit does not match an independent recomputation.");
            if (!sameJson(recordedOverlayAudit, recomputedOverlayAudit)) diagnostics.push("Executive-review overlay audit does not match an independent recomputation.");
          }
        }
      } else if (files.some((file) => file === "deck.executive-review.pptx" || file.startsWith("executive-review-previews/") || file === "executive-review-deck-audit.json" || file === "executive-review-overlay-audit.json")) {
        diagnostics.push("Review mode is off but annotated review-copy artifacts were published.");
      }
    } finally {
      await fs.rm(auditTemp, { recursive: true, force: true });
    }
    const quality = planQuality(plan);
    let designProvenanceValid = true;
    if (run.referenceGrounding?.enabled) {
      const referenceProfile = await readJson(path.join(runDir, "reference-profile.json"));
      designProvenanceValid = validateDesignProvenance(provenance, plan, referenceProfile).valid;
      if (!designProvenanceValid) diagnostics.push("Design-provenance quality closure failed.");
    }
    if (!fonts.valid || fonts.substitutionApplied !== false || fonts.diagnostics.length) diagnostics.push("Font audit quality closure failed.");
    if (!lint.valid || lint.counts.error !== 0 || lint.counts.warning !== 0) diagnostics.push("Plan lint quality closure failed.");
    if (!renderedLint.valid || renderedLint.counts.error !== 0 || renderedLint.counts.warning !== 0) diagnostics.push("Rendered lint quality closure failed.");
    if (!audit.valid || !Object.values(audit.checks).every(Boolean) || audit.summary.pictures !== 0) diagnostics.push("OOXML audit quality closure failed.");
    if (!planAudit.valid || planAudit.expectedTextObjects !== planAudit.matchedTextObjects || planAudit.pictures !== 0 || planAudit.failures.length) diagnostics.push("Plan-bound OOXML audit quality closure failed.");
    const slidePngs = files.filter((file) => /^previews\/slide-\d+\.png$/u.test(file));
    const deckArtifact = run.artifacts.find((item) => item.path === "deck.pptx");
    const expectedDelivery = guardedDeliveryManifest({
      deckSha256: deckArtifact?.sha256,
      deckBytes: deckArtifact?.bytes,
      slideCount: plan.slides.length,
      previewHashes: slidePngs.sort().map((file) => ({ file: path.basename(file), sha256: run.artifacts.find((item) => item.path === file)?.sha256 })),
    });
    if (!sameJson(delivery, expectedDelivery) || !delivery.valid) diagnostics.push("Delivery verification quality closure failed.");
    if (Object.values(quality).some((value) => typeof value === "boolean" && !value)) diagnostics.push("Plan contains non-fitting, fractional, sub-minimum, or non-editable text.");
    if (slidePngs.length !== plan.slides.length) diagnostics.push("Per-slide preview count does not match the deck.");
    if (!sameJson(run.quality, {
      ...quality,
      zeroWarnings: true,
      nativeTextNodes: audit.summary.nativeTextNodes,
      pictureCount: audit.summary.pictures,
      previewCount: slidePngs.length,
      expectedPreviewCount: plan.slides.length,
      ooxmlChecks: audit.checks,
      planAuditValid: planAudit.valid,
      matchedTextObjects: planAudit.matchedTextObjects,
      expectedTextObjects: planAudit.expectedTextObjects,
      deliveryValid: delivery.valid,
      executiveReviewMode: reviewMode,
      executiveReviewFindingCount: executiveReview.counts.findings,
      canonicalExecutiveReviewOverlayCount: cleanReviewAudit.actualOverlayCount,
      executiveReviewCopyValid: reviewMode === REVIEW_MODE_OFF || files.includes("deck.executive-review.pptx"),
      referenceGroundingEnabled: Boolean(run.referenceGrounding?.enabled),
      designProvenanceValid,
    })) diagnostics.push("Recorded quality closure does not match artifacts.");

    const stage = Object.fromEntries(run.stages.map((item) => [item.name, item]));
    const hashes = Object.fromEntries(run.artifacts.map((item) => [item.path, item.sha256]));
    if (stage.policy.inputSha256 !== run.requestSha256 || stage.policy.outputSha256 !== hashes["policy.json"]) diagnostics.push("Policy stage binding mismatch.");
    if (stage.compile.inputSha256 !== run.specSha256 || stage.compile.adaptedSpecSha256 !== hashes["adapted-spec.json"] || stage.compile.adaptationSha256 !== hashes["adaptation.json"] || stage.compile.outputSha256 !== hashes["plan.json"]
      || stage.compile.referenceProfileSha256 !== (run.referenceGrounding?.enabled ? hashes["reference-profile.json"] : null)
      || stage.compile.designProvenanceSha256 !== (run.referenceGrounding?.enabled ? hashes["design-provenance.json"] : null)) diagnostics.push("Compile stage binding mismatch.");
    if (stage.fonts.inputSha256 !== hashes["plan.json"] || stage.fonts.outputSha256 !== hashes["font-report.json"]) diagnostics.push("Font stage binding mismatch.");
    if (stage.lint.inputSha256 !== hashes["plan.json"] || stage.lint.outputSha256 !== hashes["lint-report.json"]) diagnostics.push("Lint stage binding mismatch.");
    if (stage.render.inputSha256 !== hashes["plan.json"] || stage.render.outputSha256 !== hashes["deck.pptx"] || stage.render.renderedLintSha256 !== hashes["previews/rendered-lint-report.json"]) diagnostics.push("Render stage binding mismatch.");
    if (stage.audit.inputSha256 !== hashes["deck.pptx"] || stage.audit.genericAuditSha256 !== hashes["audit.json"] || stage.audit.planAuditSha256 !== hashes["plan-audit.json"]) diagnostics.push("Audit stage binding mismatch.");
    if (stage["executive-review"].inputSha256 !== hashes["deck.pptx"]
      || stage["executive-review"].manifestSha256 !== hashes["executive-review.json"]
      || stage["executive-review"].cleanAuditSha256 !== hashes["executive-review-clean-audit.json"]
      || stage["executive-review"].mode !== reviewMode
      || stage["executive-review"].canonicalDeckModified !== false
      || stage["executive-review"].findingCount !== executiveReview.counts.findings) diagnostics.push("Executive-review stage binding mismatch.");
    if (reviewMode === REVIEW_MODE_OVERLAY) {
      const reviewSlidePngs = files.filter((file) => /^executive-review-previews\/slide-\d+\.png$/u.test(file)).sort();
      const expectedReviewPreviewHashes = reviewSlidePngs.map((file) => ({ file: path.basename(file), sha256: hashes[file] }));
      if (stage["executive-review"].reviewDeck?.sha256 !== hashes["deck.executive-review.pptx"]
        || stage["executive-review"].reviewDeck?.bytes !== run.artifacts.find((item) => item.path === "deck.executive-review.pptx")?.bytes
        || stage["executive-review"].reviewDeckAuditSha256 !== hashes["executive-review-deck-audit.json"]
        || stage["executive-review"].reviewOverlayAuditSha256 !== hashes["executive-review-overlay-audit.json"]
        || !sameJson(stage["executive-review"].reviewPreviewHashes, expectedReviewPreviewHashes)) diagnostics.push("Executive-review copy binding mismatch.");
    } else if (stage["executive-review"].reviewDeck !== null || !sameJson(stage["executive-review"].reviewPreviewHashes, [])) diagnostics.push("Disabled executive-review stage claims review-copy outputs.");
    if (stage.delivery.inputSha256 !== hashes["deck.pptx"] || stage.delivery.outputSha256 !== hashes["delivery.json"]) diagnostics.push("Delivery stage binding mismatch.");
    const previewHashes = slidePngs.sort().map((file) => ({ file: path.basename(file), sha256: hashes[file] }));
    if (!sameJson(stage.render.previewHashes, previewHashes)) diagnostics.push("Render preview hash binding mismatch.");
  }
  return { valid: diagnostics.length === 0, outcome: run.outcome, diagnostics };
}

export { RUN_SCHEMA_VERSION };
