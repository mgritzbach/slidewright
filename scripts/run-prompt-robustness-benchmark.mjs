#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRequestRun, stableJson } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-build.mjs";
import { IMMUTABLE_REQUEST_STAGES, REQUEST_SCHEMA_VERSION } from "../plugins/slidewright/skills/slidewright/scripts/lib/request-policy.mjs";
import { publishVersionedEvidence } from "./lib/versioned-evidence-publish.mjs";

const root = process.cwd();
const fixtureDir = path.join(root, "fixtures", "prompt-robustness", "v1");
const published = path.join(root, "outputs", "prompt-robustness");
const staging = path.join(root, "outputs", `.prompt-robustness-staging-${process.pid}-${Date.now()}`);
const cli = path.join(root, "packages", "cli", "src", "cli.mjs");
const manifest = JSON.parse(await fs.readFile(path.join(fixtureDir, "fixture-manifest.json"), "utf8"));
const sentinel = path.join(root, "c12-shell-sentinel.txt");
const suiteFiles = [
  fileURLToPath(import.meta.url),
  path.join(fixtureDir, "fixture-manifest.json"),
  path.join(fixtureDir, "decision-spec.json"),
  path.join(fixtureDir, "literal-copy-spec.json"),
  path.join(root, "examples", "demo", "deck-spec.json"),
];

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listFiles(rootDir, directory = rootDir) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(rootDir, absolute));
    else if (entry.isFile()) files.push(path.relative(rootDir, absolute).split(path.sep).join("/"));
    else throw new Error(`Unsupported evidence entry: ${absolute}`);
  }
  return files;
}

async function refreshRunArtifacts(runDir, mutateRun = () => {}) {
  const runPath = path.join(runDir, "run.json");
  const run = JSON.parse(await fs.readFile(runPath, "utf8"));
  mutateRun(run);
  const files = (await listFiles(runDir)).filter((file) => file !== "run.json");
  run.artifacts = await Promise.all(files.map(async (file) => {
    const bytes = await fs.readFile(path.join(runDir, ...file.split("/")));
    return { path: file, bytes: bytes.length, sha256: sha256Bytes(bytes) };
  }));
  await writeJson(runPath, run);
}

async function cleanOwnedRetryOutput(args) {
  const outputIndex = args.indexOf("--out");
  if (outputIndex < 0 || !args[outputIndex + 1]) return;
  const output = path.resolve(args[outputIndex + 1]);
  const relative = path.relative(staging, output);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Refusing retry cleanup outside C12 staging: ${output}`);
  await fs.rm(output, { recursive: true, force: true });
  const parent = path.dirname(output);
  const prefix = `${path.basename(output)}.staging-`;
  if (!await exists(parent)) return;
  for (const entry of await fs.readdir(parent)) if (entry.startsWith(prefix)) await fs.rm(path.join(parent, entry), { recursive: true, force: true });
}

async function runCli(args, expectedStatus, env = process.env) {
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env,
    });
    if (result.error) throw result.error;
    const transientNativeCrash = expectedStatus === 0 && [3221225477, -1073741819].includes(result.status);
    if (result.status === expectedStatus || !transientNativeCrash || attempt === 1) break;
    await cleanOwnedRetryOutput(args);
    process.stdout.write(`C12 bounded retry after native renderer status ${result.status}.\n`);
  }
  if (result.status !== expectedStatus) {
    const outIndex = args.indexOf("--out");
    const runPath = outIndex >= 0 && args[outIndex + 1] ? path.join(args[outIndex + 1], "run.json") : null;
    let failedRun = null;
    if (runPath) {
      try { failedRun = JSON.parse(await fs.readFile(runPath, "utf8")); } catch { /* no published request-run evidence */ }
    }
    const failedStage = failedRun?.stages?.findLast((stage) => stage.status === "failed");
    const evidence = failedStage
      ? `\nPublished failed-run evidence: stage=${failedStage.name}; error=${failedStage.error}`
      : "";
    throw new Error(`slidewright ${args.join(" ")} returned ${result.status}; expected ${expectedStatus}.${evidence}\n${result.stderr || result.stdout}`);
  }
  return { exitCode: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

async function buildRequest(fixture, repeat) {
  const spec = JSON.parse(await fs.readFile(path.resolve(fixtureDir, fixture.spec), "utf8"));
  const request = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    id: fixture.id,
    prompt: fixture.prompt,
    spec,
    ...(fixture.requestPatch ?? {}),
  };
  const requestPath = path.join(staging, "requests", `${fixture.id}-${repeat}.json`);
  const runDir = path.join(staging, "matrix", fixture.id, `repeat-${repeat}`);
  await writeJson(requestPath, request);
  const command = await runCli(["request", requestPath, "--out", runDir], fixture.expectedOutcome === "built" ? 0 : 2);
  const verification = await verifyRequestRun(runDir);
  if (!verification.valid) throw new Error(`Verification failed for ${fixture.id} repeat ${repeat}: ${verification.diagnostics.join("; ")}`);
  const run = JSON.parse(await fs.readFile(path.join(runDir, "run.json"), "utf8"));
  if (run.outcome !== fixture.expectedOutcome) throw new Error(`${fixture.id} produced ${run.outcome}; expected ${fixture.expectedOutcome}.`);
  const policy = JSON.parse(await fs.readFile(path.join(runDir, "policy.json"), "utf8"));
  const ruleIds = [...new Set(policy.diagnostics.map((item) => item.ruleId))].sort();
  for (const ruleId of fixture.expectedRuleIds ?? []) if (!ruleIds.includes(ruleId)) throw new Error(`${fixture.id} did not emit ${ruleId}.`);
  const result = {
    caseId: fixture.id,
    category: fixture.category,
    repeat,
    expectedOutcome: fixture.expectedOutcome,
    outcome: run.outcome,
    cliExitCode: command.exitCode,
    requestSha256: run.requestSha256,
    promptSha256: run.promptSha256,
    specSha256: run.specSha256,
    contractSha256: run.contractSha256,
    implementationSha256: run.implementationSha256,
    stageNames: run.stages.map((stage) => stage.name),
    ruleIds,
    verificationValid: verification.valid,
    verificationDiagnostics: verification.diagnostics,
    runArtifactHash: sha256Bytes(Buffer.from(stableJson(run.artifacts), "utf8")),
  };
  if (run.outcome === "built") {
    result.planSha256 = await sha256File(path.join(runDir, "plan.json"));
    result.deckSha256 = await sha256File(path.join(runDir, "deck.pptx"));
    result.previewHashes = run.artifacts.filter((item) => /^previews\/slide-\d+\.png$/u.test(item.path)).map((item) => ({ path: item.path, sha256: item.sha256 }));
  }
  return { runDir, result };
}

async function controlCopy(source, id) {
  const target = path.join(staging, "control-work", id);
  await fs.cp(source, target, { recursive: true, errorOnExist: true });
  return target;
}

async function runDestructiveControls(positiveRun, rejectedRun, alternateRun) {
  const controls = [];
  async function check(id, mutate, expectedPattern) {
    const directory = await controlCopy(positiveRun, id);
    await mutate(directory);
    const result = await verifyRequestRun(directory);
    const matched = !result.valid && (!expectedPattern || result.diagnostics.some((item) => expectedPattern.test(item)));
    controls.push({ id, rejected: !result.valid, expectedDiagnosticMatched: matched, diagnostics: result.diagnostics });
    if (!matched) throw new Error(`Destructive control '${id}' did not fail as intended: ${result.diagnostics.join("; ")}`);
  }

  await check("missing-audit-stage", async (directory) => {
    await refreshRunArtifacts(directory, (run) => { run.stages = run.stages.filter((stage) => stage.name !== "audit"); });
  }, /stage sequence/iu);
  await check("reordered-stages", async (directory) => {
    await refreshRunArtifacts(directory, (run) => { [run.stages[2], run.stages[3]] = [run.stages[3], run.stages[2]]; });
  }, /stage sequence/iu);
  await check("forged-lint-warning", async (directory) => {
    const reportPath = path.join(directory, "lint-report.json");
    const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
    report.valid = true;
    report.counts.warning = 1;
    await writeJson(reportPath, report);
    const hash = await sha256File(reportPath);
    await refreshRunArtifacts(directory, (run) => { run.stages.find((stage) => stage.name === "lint").outputSha256 = hash; });
  }, /lint/iu);
  await check("relaxed-plan-policy", async (directory) => {
    const planPath = path.join(directory, "plan.json");
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    plan.layout.geometryTolerance = 100;
    plan.layout.approvedFontSizesPt.push(7);
    plan.slides[0].quality = { maximumOccupancyRatio: 1, maximumTopLevelObjects: 999, minimumPeerGapPx: 0 };
    const shape = plan.slides[0].shapes.find((item) => item.type === "text" && item.role === "body");
    shape.fit.minSizePt = 1;
    shape.style.fontSizePt = 7;
    await writeJson(planPath, plan);
    const hash = await sha256File(planPath);
    await refreshRunArtifacts(directory, (run) => {
      run.stages.find((stage) => stage.name === "compile").outputSha256 = hash;
      for (const name of ["fonts", "lint", "render"]) run.stages.find((stage) => stage.name === name).inputSha256 = hash;
    });
  }, /plan|quality|compiled/iu);
  await check("fractional-type", async (directory) => {
    const planPath = path.join(directory, "plan.json");
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    plan.slides[0].shapes.find((item) => item.type === "text").style.fontSizePt = 11.5;
    await writeJson(planPath, plan);
    const hash = await sha256File(planPath);
    await refreshRunArtifacts(directory, (run) => {
      run.stages.find((stage) => stage.name === "compile").outputSha256 = hash;
      for (const name of ["fonts", "lint", "render"]) run.stages.find((stage) => stage.name === name).inputSha256 = hash;
    });
  }, /plan|quality|compiled/iu);
  await check("text-overlap", async (directory) => {
    const planPath = path.join(directory, "plan.json");
    const plan = JSON.parse(await fs.readFile(planPath, "utf8"));
    const text = plan.slides[0].shapes.filter((item) => item.type === "text");
    text[1].position = { ...text[0].position };
    text[1].allowOverlapWith = [text[0].id];
    await writeJson(planPath, plan);
    const hash = await sha256File(planPath);
    await refreshRunArtifacts(directory, (run) => {
      run.stages.find((stage) => stage.name === "compile").outputSha256 = hash;
      for (const name of ["fonts", "lint", "render"]) run.stages.find((stage) => stage.name === name).inputSha256 = hash;
    });
  }, /plan|lint|compiled/iu);
  await check("forged-generic-audit", async (directory) => {
    const auditPath = path.join(directory, "audit.json");
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8"));
    audit.valid = true;
    audit.summary.pictures = 1;
    await writeJson(auditPath, audit);
    const hash = await sha256File(auditPath);
    await refreshRunArtifacts(directory, (run) => { run.stages.find((stage) => stage.name === "audit").genericAuditSha256 = hash; });
  }, /audit/iu);
  await check("forged-plan-audit", async (directory) => {
    const auditPath = path.join(directory, "plan-audit.json");
    const audit = JSON.parse(await fs.readFile(auditPath, "utf8"));
    audit.valid = true;
    audit.expectedTextObjects += 1;
    await writeJson(auditPath, audit);
    const hash = await sha256File(auditPath);
    await refreshRunArtifacts(directory, (run) => { run.stages.find((stage) => stage.name === "audit").planAuditSha256 = hash; });
  }, /audit/iu);
  await check("substituted-deck", async (directory) => {
    await fs.copyFile(path.join(alternateRun, "deck.pptx"), path.join(directory, "deck.pptx"));
    const hash = await sha256File(path.join(directory, "deck.pptx"));
    const bytes = (await fs.stat(path.join(directory, "deck.pptx"))).size;
    const deliveryPath = path.join(directory, "delivery.json");
    const delivery = JSON.parse(await fs.readFile(deliveryPath, "utf8"));
    delivery.deck.sha256 = hash;
    delivery.deck.bytes = bytes;
    await writeJson(deliveryPath, delivery);
    const deliveryHash = await sha256File(deliveryPath);
    await refreshRunArtifacts(directory, (run) => {
      run.stages.find((stage) => stage.name === "render").outputSha256 = hash;
      run.stages.find((stage) => stage.name === "audit").inputSha256 = hash;
      const stage = run.stages.find((item) => item.name === "delivery");
      stage.inputSha256 = hash;
      stage.outputSha256 = deliveryHash;
    });
  }, /audit|delivery/iu);
  await check("prompt-tamper", async (directory) => {
    const requestPath = path.join(directory, "request.json");
    const request = JSON.parse(await fs.readFile(requestPath, "utf8"));
    request.prompt += " changed after policy";
    await writeJson(requestPath, request);
    const bytes = await fs.readFile(requestPath);
    await refreshRunArtifacts(directory, (run) => {
      run.requestSha256 = sha256Bytes(bytes);
      run.promptSha256 = sha256Bytes(Buffer.from(request.prompt, "utf8"));
      run.stages.find((stage) => stage.name === "policy").inputSha256 = run.requestSha256;
    });
  }, /policy/iu);
  await check("extra-artifact", async (directory) => {
    await fs.writeFile(path.join(directory, "unbound.txt"), "unbound", "utf8");
  }, /inventory/iu);
  await check("missing-plan-audit", async (directory) => {
    await fs.rm(path.join(directory, "plan-audit.json"));
    await refreshRunArtifacts(directory);
  }, /missing/iu);
  await check("delivery-hash-forgery", async (directory) => {
    const deliveryPath = path.join(directory, "delivery.json");
    const delivery = JSON.parse(await fs.readFile(deliveryPath, "utf8"));
    delivery.deck.sha256 = "0".repeat(64);
    await writeJson(deliveryPath, delivery);
    const hash = await sha256File(deliveryPath);
    await refreshRunArtifacts(directory, (run) => { run.stages.find((stage) => stage.name === "delivery").outputSha256 = hash; });
  }, /delivery/iu);

  const rejectedControl = await controlCopy(rejectedRun, "rejected-run-deck-injection");
  await fs.writeFile(path.join(rejectedControl, "deck.pptx"), "forged deck", "utf8");
  await refreshRunArtifacts(rejectedControl);
  const rejectedResult = await verifyRequestRun(rejectedControl);
  const rejectedMatched = !rejectedResult.valid && rejectedResult.diagnostics.some((item) => /forbidden artifact/u.test(item));
  controls.push({ id: "rejected-run-deck-injection", rejected: !rejectedResult.valid, expectedDiagnosticMatched: rejectedMatched, diagnostics: rejectedResult.diagnostics });
  if (!rejectedMatched) throw new Error("Rejected-run deck injection was not refused.");
  await fs.rm(path.join(staging, "control-work"), { recursive: true, force: true });
  return controls;
}

async function runFaultControls(requestPath) {
  const controls = [];
  for (const stage of [...IMMUTABLE_REQUEST_STAGES, "before-publication"]) {
    const output = path.join(staging, "fault-work", stage);
    const command = await runCli(["request", requestPath, "--out", output], 2, { ...process.env, SLIDEWRIGHT_REQUEST_FAULT_AFTER: stage });
    const forbidden = [
      "deck.pptx",
      "previews",
      "audit.json",
      "plan-audit.json",
      "executive-review.json",
      "executive-review-clean-audit.json",
      "deck.executive-review.pptx",
      "executive-review-deck-audit.json",
      "executive-review-overlay-audit.json",
      "executive-review-previews",
      "delivery.json",
      "DELIVERY.md",
    ];
    const absent = (await Promise.all(forbidden.map((item) => exists(path.join(output, item))))).every((value) => !value);
    const run = JSON.parse(await fs.readFile(path.join(output, "run.json"), "utf8"));
    const passed = command.exitCode === 2 && run.outcome === "failed" && run.valid === false && absent;
    controls.push({ stage, passed, noDeliverableArtifacts: absent, outcome: run.outcome });
    if (!passed) throw new Error(`Fault injection after ${stage} left a deliverable artifact or success claim.`);
  }
  await fs.rm(path.join(staging, "fault-work"), { recursive: true, force: true });
  return controls;
}

await fs.rm(staging, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });
await fs.rm(sentinel, { force: true });

try {
  const runs = [];
  const runDirs = new Map();
  for (const fixture of manifest.cases) {
    for (let repeat = 1; repeat <= manifest.repeatRuns; repeat += 1) {
      const built = await buildRequest(fixture, repeat);
      runs.push(built.result);
      runDirs.set(`${fixture.id}:${repeat}`, built.runDir);
      process.stdout.write(`C12 ${fixture.id} ${repeat}/${manifest.repeatRuns}: ${built.result.outcome}\n`);
    }
  }

  const repeatDeterminism = manifest.cases.filter((fixture) => fixture.expectedOutcome === "built").map((fixture) => {
    const selected = runs.filter((run) => run.caseId === fixture.id);
    const planHashes = [...new Set(selected.map((run) => run.planSha256))];
    const deckHashes = [...new Set(selected.map((run) => run.deckSha256))];
    return { caseId: fixture.id, valid: planHashes.length === 1 && deckHashes.length === 1, planHashes, deckHashes };
  });
  const equivalence = Object.entries(Object.groupBy(manifest.cases.filter((fixture) => fixture.expectedOutcome === "built"), (fixture) => fixture.equivalenceGroup)).map(([group, fixtures]) => {
    const selected = runs.filter((run) => fixtures.some((fixture) => fixture.id === run.caseId));
    const planHashes = [...new Set(selected.map((run) => run.planSha256))];
    const deckHashes = [...new Set(selected.map((run) => run.deckSha256))];
    return { group, cases: fixtures.map((fixture) => fixture.id).sort(), valid: planHashes.length === 1 && deckHashes.length === 1, planHashes, deckHashes };
  });
  if (repeatDeterminism.some((item) => !item.valid) || equivalence.some((item) => !item.valid)) throw new Error("Prompt matrix did not produce deterministic or semantically equivalent paired outputs.");

  const positiveRun = runDirs.get("minimal-demo:1");
  const rejectedRun = runDirs.get("conflict-stage-bypass:1");
  const alternateRun = runDirs.get("minimal-decision:1");
  const destructiveControls = await runDestructiveControls(positiveRun, rejectedRun, alternateRun);
  const faultControls = await runFaultControls(path.join(staging, "requests", "minimal-demo-1.json"));
  const uniquePositiveOutputs = equivalence.map((item) => {
    const run = runs.find((candidate) => item.cases.includes(candidate.caseId));
    return { group: item.group, deckSha256: run.deckSha256, planSha256: run.planSha256, previewHashes: run.previewHashes, representativeRun: path.relative(staging, runDirs.get(`${run.caseId}:1`)).split(path.sep).join("/") };
  });
  const categoryCounts = Object.fromEntries(Object.entries(Object.groupBy(manifest.cases, (fixture) => fixture.category)).map(([category, fixtures]) => [category, fixtures.length]));
  const fixtureAndRunnerHashes = await Promise.all(suiteFiles.sort().map(async (filePath) => ({
    path: path.relative(root, filePath).split(path.sep).join("/"),
    sha256: await sha256File(filePath),
  })));
  const suiteImplementationSha256 = sha256Bytes(Buffer.from(stableJson(fixtureAndRunnerHashes), "utf8"));
  const scorecardCore = {
    schemaVersion: "slidewright-prompt-robust-scorecard/v1",
    suiteId: manifest.suiteId,
    repeatRuns: manifest.repeatRuns,
    caseCount: manifest.cases.length,
    executedRunCount: runs.length,
    categoryCounts,
    suiteImplementationSha256,
    fixtureAndRunnerHashes,
    builtRunCount: runs.filter((run) => run.outcome === "built").length,
    rejectedRunCount: runs.filter((run) => run.outcome === "rejected").length,
    allRunVerificationsPassed: runs.every((run) => run.verificationValid),
    allExpectedOutcomesMatched: runs.every((run) => run.outcome === run.expectedOutcome),
    immutableRequestStages: [...IMMUTABLE_REQUEST_STAGES],
    exactStageClosure: runs.filter((run) => run.outcome === "built").every((run) => stableJson(run.stageNames) === stableJson(IMMUTABLE_REQUEST_STAGES)),
    repeatDeterminism,
    semanticPairEquivalence: equivalence,
    destructiveControls,
    faultControls,
    shellSentinelAbsent: !await exists(sentinel),
    uniquePositiveOutputs,
    reviewArtifactsReady: uniquePositiveOutputs.every((item) => item.previewHashes.length === 3),
    limitations: [
      "This bounded suite proves the guarded request/build boundary, not universal natural-language understanding.",
      "Prompt classification is defense in depth; safety comes from strict data/control separation and code-owned gates.",
      "Human full-size review is recorded separately and is required before C12 can be credited.",
    ],
    runs,
  };
  scorecardCore.valid = scorecardCore.caseCount === 12
    && scorecardCore.executedRunCount === 36
    && scorecardCore.allRunVerificationsPassed
    && scorecardCore.allExpectedOutcomesMatched
    && scorecardCore.exactStageClosure
    && scorecardCore.repeatDeterminism.every((item) => item.valid)
    && scorecardCore.semanticPairEquivalence.every((item) => item.valid)
    && scorecardCore.destructiveControls.every((item) => item.rejected && item.expectedDiagnosticMatched)
    && scorecardCore.faultControls.every((item) => item.passed)
    && scorecardCore.shellSentinelAbsent
    && scorecardCore.reviewArtifactsReady;
  if (!scorecardCore.valid) throw new Error("C12 prompt-robustness machine scorecard did not close.");
  const scorecardHash = sha256Bytes(Buffer.from(stableJson(scorecardCore), "utf8"));
  const scorecard = { ...scorecardCore, scorecardHash };
  await writeJson(path.join(staging, "scorecard.json"), scorecard);
  const finalRun = await publishVersionedEvidence(staging, published, scorecardHash, { currentSchemaVersion: "slidewright-prompt-current/v1" });
  process.stdout.write(`C12 machine benchmark passed: ${runs.length} runs, ${destructiveControls.length} destructive controls, ${faultControls.length} fault controls.\n`);
  process.stdout.write(`Scorecard ${scorecardHash} published at ${finalRun}.\n`);
} catch (error) {
  await fs.rm(staging, { recursive: true, force: true });
  throw error;
} finally {
  await fs.rm(sentinel, { force: true });
}
