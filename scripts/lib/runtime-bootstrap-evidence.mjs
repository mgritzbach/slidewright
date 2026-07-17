import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RUNTIME_SCORECARD_SCHEMA = "slidewright-runtime-bootstrap-scorecard-v1";
export const RUNTIME_AGGREGATE_SCHEMA = "slidewright-runtime-bootstrap-aggregate-v1";

export function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

export async function buildPathReplacements(groups, realpathImpl = fs.realpath) {
  const expanded = [];
  for (const [value, replacement] of groups) {
    if (!value) continue;
    expanded.push([String(value), replacement]);
    const real = await realpathImpl(value).catch(() => null);
    if (real) expanded.push([String(real), replacement]);
  }
  const unique = expanded.filter(([value], index, values) => values.findIndex(([candidate]) => candidate === value) === index);
  return unique.sort(([left], [right]) => right.length - left.length);
}

export function normalizeEvidenceText(text, replacements) {
  let normalized = String(text || "").replaceAll("\r\n", "\n");
  for (const [value, replacement] of replacements) {
    normalized = normalized.replaceAll(value, replacement);
    normalized = normalized.replaceAll(JSON.stringify(value).slice(1, -1), replacement);
  }
  return normalized;
}

const RELEASE_SCORECARD_URL = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+)\/runtime-bootstrap-scorecard\.json$/;
const RELEASE_COMMAND_LOG_URL = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+)\/runtime-bootstrap-command-log\.json$/;

export async function fetchAndVerifyRuntimeReleaseAssets({
  scorecardUrl,
  commandLogUrl,
  expectedScorecardBytes,
  expectedCommandLogBytes,
  fetchImpl = globalThis.fetch,
}) {
  const scorecardMatch = String(scorecardUrl ?? "").match(RELEASE_SCORECARD_URL);
  const commandLogMatch = String(commandLogUrl ?? "").match(RELEASE_COMMAND_LOG_URL);
  if (!scorecardMatch || !commandLogMatch || scorecardMatch[1] !== commandLogMatch[1]) {
    throw new Error("WSL release evidence must use matching public GitHub scorecard and command-log asset URLs.");
  }
  if (typeof fetchImpl !== "function") throw new Error("No fetch implementation is available for public WSL evidence verification.");
  const [scorecardResponse, commandLogResponse] = await Promise.all([
    fetchImpl(scorecardUrl, { redirect: "follow" }),
    fetchImpl(commandLogUrl, { redirect: "follow" }),
  ]);
  if (!scorecardResponse?.ok) throw new Error(`Unable to fetch public WSL scorecard (${scorecardResponse?.status ?? "no response"}).`);
  if (!commandLogResponse?.ok) throw new Error(`Unable to fetch public WSL command log (${commandLogResponse?.status ?? "no response"}).`);
  const publicScorecardBytes = Buffer.from(await scorecardResponse.arrayBuffer());
  const publicCommandLogBytes = Buffer.from(await commandLogResponse.arrayBuffer());
  const localScorecardBytes = Buffer.from(expectedScorecardBytes);
  const localCommandLogBytes = Buffer.from(expectedCommandLogBytes);
  if (!publicScorecardBytes.equals(localScorecardBytes)) throw new Error("Public WSL scorecard bytes do not match the aggregate input.");
  if (!publicCommandLogBytes.equals(localCommandLogBytes)) throw new Error("Public WSL command-log bytes do not match the aggregate input.");
  return {
    scorecardUrl,
    scorecardSha256: sha256Bytes(publicScorecardBytes),
    scorecardBytes: publicScorecardBytes.length,
    commandLogUrl,
    commandLogSha256: sha256Bytes(publicCommandLogBytes),
    commandLogBytes: publicCommandLogBytes.length,
    byteMatched: true,
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function hashImplementation(root, files) {
  const records = [];
  for (const relativePath of [...files].sort()) {
    const bytes = await fs.readFile(path.join(root, relativePath));
    records.push({ path: relativePath.replaceAll("\\", "/"), sha256: sha256Bytes(Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n"), "utf8")) });
  }
  return { files: records, sha256: sha256Bytes(stableJson(records)) };
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function semverAtLeast(value, minimum) {
  const parse = (candidate) => {
    const match = String(candidate ?? "").match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) return null;
    const prerelease = match[4]?.split(".") ?? null;
    if (prerelease?.some((identifier) => !identifier || /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) return null;
    return { core: match.slice(1, 4).map(Number), prerelease };
  };
  const left = parse(value);
  const right = parse(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index];
  }
  if (left.prerelease && !right.prerelease) return false;
  return true;
}

function deriveFailureReceipt(command, code) {
  const lines = String(command?.stderr ?? "").trim().split("\n");
  return {
    exitCode: command?.exitCode,
    code,
    codeOccurrences: [...String(command?.stderr ?? "").matchAll(new RegExp(code, "g"))].length,
    stderrLineCount: lines.length,
    stderrSha256: sha256Bytes(String(command?.stderr ?? "")),
    stdoutEmpty: command?.stdout === "",
    workspaceUntouched: command?.workspace?.existedBefore === false && command?.workspace?.existsAfter === false,
    recoveryPresent: lines.some((line) => line.startsWith("Recovery:")),
    localOnlyPolicyPresent: lines.includes("Policy: Slidewright made no network request, downloaded nothing, and did not switch renderers."),
  };
}

function failureRecordMatchesReceipt(record, command, code) {
  const derived = deriveFailureReceipt(command, code);
  return ["exitCode", "code", "codeOccurrences", "stderrLineCount", "stderrSha256", "stdoutEmpty", "workspaceUntouched", "recoveryPresent", "localOnlyPolicyPresent"]
    .every((key) => record?.[key] === derived[key]);
}

function validateTree(tree) {
  if (!tree || !Array.isArray(tree.files) || tree.fileCount !== tree.files.length || tree.files.length < 2 || !isSha256(tree.sha256)) return false;
  if (tree.files.some((entry) => !entry.path || path.isAbsolute(entry.path) || entry.path.startsWith("..") || !Number.isInteger(entry.size) || entry.size < 0 || !isSha256(entry.sha256))) return false;
  if (new Set(tree.files.map((entry) => entry.path)).size !== tree.files.length) return false;
  return tree.sha256 === sha256Bytes(stableJson(tree.files));
}

function pathContains(parent, candidate) {
  const normalize = (value) => String(value ?? "").replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
  const base = normalize(parent);
  const child = normalize(candidate);
  return Boolean(base) && child.startsWith(`${base}/`);
}

function validActionableFailure(record, code, expectedLines) {
  return record?.exitCode === 1
    && record?.code === code
    && record?.codeOccurrences === 1
    && record?.stderrLineCount === expectedLines
    && isSha256(record?.stderrSha256)
    && record?.stdoutEmpty === true
    && record?.workspaceUntouched === true
    && record?.recoveryPresent === true
    && record?.localOnlyPolicyPresent === true;
}

export function validateRuntimeScorecard(scorecard, contract, commandLog) {
  const errors = [];
  if (scorecard?.schemaVersion !== RUNTIME_SCORECARD_SCHEMA) errors.push("schemaVersion");
  if (!contract.requiredProfiles.includes(scorecard?.host?.profile)) errors.push("host.profile");
  if (!isSha256(scorecard?.contractSha256)) errors.push("contractSha256");
  const implementationFiles = (scorecard?.implementation?.files ?? []).map((entry) => entry.path);
  if (!isSha256(scorecard?.implementation?.sha256) || !Array.isArray(scorecard?.implementation?.files) || scorecard.implementation.files.some((entry) => !isSha256(entry.sha256)) || JSON.stringify(implementationFiles) !== JSON.stringify([...contract.implementationFiles].sort())) errors.push("implementation");
  if (!/^[a-f0-9]{40}$/.test(scorecard?.git?.commit ?? "")) errors.push("git.commit");
  const actionUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/;
  const releaseUrl = RELEASE_SCORECARD_URL;
  if (scorecard?.git?.evidenceKind === "github-actions" && (!actionUrl.test(scorecard.git.evidenceUrl ?? "") || scorecard.git.runUrl !== scorecard.git.evidenceUrl)) errors.push("git.actionsProvenance");
  else if (scorecard?.git?.evidenceKind === "github-release" && (!releaseUrl.test(scorecard.git.evidenceUrl ?? "") || !RELEASE_COMMAND_LOG_URL.test(scorecard.git.commandLogUrl ?? "") || scorecard.git.commandLogUrl !== scorecard.git.evidenceUrl.replace(/runtime-bootstrap-scorecard\.json$/, "runtime-bootstrap-command-log.json") || scorecard.git.runUrl !== null)) errors.push("git.releaseProvenance");
  else if (scorecard?.git?.evidenceKind === "local" && (scorecard.git.evidenceUrl !== null || scorecard.git.commandLogUrl !== null || scorecard.git.runUrl !== null)) errors.push("git.localProvenance");
  else if (!["github-actions", "github-release", "local"].includes(scorecard?.git?.evidenceKind)) errors.push("git.evidenceKind");
  if (scorecard?.git?.evidenceKind === "github-actions" && scorecard.git.commandLogUrl !== null) errors.push("git.actionsCommandLogUrl");
  if (scorecard?.policy?.network !== contract.networkPolicy || scorecard?.policy?.renderer !== contract.rendererPolicy) errors.push("policy");
  const expectedPlatform = { windows: "win32", macos: "darwin", linux: "linux", wsl: "linux" }[scorecard?.host?.profile];
  if (scorecard?.host?.platform !== expectedPlatform || !scorecard?.host?.architecture || !scorecard?.host?.release) errors.push("host.binding");
  if (scorecard?.host?.profileDetectedWithoutOverride !== true) errors.push("host.detection");
  if (scorecard?.host?.profile === "wsl" && (!scorecard.host.procVersionContainsMicrosoft || !isSha256(scorecard.host.procVersionSha256) || !scorecard.host.wslDistro || !scorecard.host.tempFilesystemType)) errors.push("host.wslEvidence");
  if (scorecard?.fixture?.syntheticContractFixture !== true || scorecard?.fixture?.source !== "explicit-runtime-root" || scorecard?.fixture?.hostProfile !== scorecard?.host?.profile || scorecard?.fixture?.artifactToolVersion !== contract.minimumArtifactToolVersion || scorecard?.fixture?.linkedPackageIdentityPreserved !== true || scorecard?.fixture?.sourcePackageTree?.fileCount < 2 || !isSha256(scorecard?.fixture?.sourcePackageTree?.sha256)) errors.push("fixture.runtime");
  if (scorecard?.fixture?.downloaded !== false || scorecard?.fixture?.rendererSwitched !== false || scorecard?.fixture?.importSmokePassed !== true || scorecard?.fixture?.commandExitCode !== 0 || !isSha256(scorecard?.fixture?.commandStdoutSha256) || !isSha256(scorecard?.fixture?.commandStderrSha256)) errors.push("fixture.policy");
  if (!validActionableFailure(scorecard?.failure, contract.failureCodes.unavailable, 4)) errors.push("failure");
  if (!validActionableFailure(scorecard?.invalidOverride, contract.failureCodes.invalidOverride, 5) || scorecard?.invalidOverride?.fellThrough !== false) errors.push("invalidOverride");
  if (scorecard?.hostOutcome?.hostProfile !== scorecard?.host?.profile) errors.push("hostOutcome.profile");
  if (scorecard?.hostOutcome?.kind === "runtime-resolved") {
    if (scorecard.hostOutcome.source !== "codex-bundled-runtime" || !semverAtLeast(scorecard.hostOutcome.artifactToolVersion, contract.minimumArtifactToolVersion) || scorecard.hostOutcome.downloaded !== false || scorecard.hostOutcome.rendererSwitched !== false || scorecard.hostOutcome.importSmokePassed !== true || scorecard.hostOutcome.packageTree?.fileCount < 3 || !isSha256(scorecard.hostOutcome.packageTree?.sha256) || scorecard.hostOutcome.commandExitCode !== 0 || !isSha256(scorecard.hostOutcome.commandStdoutSha256) || !isSha256(scorecard.hostOutcome.commandStderrSha256)) errors.push("hostOutcome.runtime");
  } else if (scorecard?.hostOutcome?.kind === "actionable-failure") {
    if (!validActionableFailure(scorecard.hostOutcome, contract.failureCodes.unavailable, 4) || !isSha256(scorecard.hostOutcome.commandStdoutSha256)) errors.push("hostOutcome.failure");
  } else {
    errors.push("hostOutcome.kind");
  }
  const sourceAuditFiles = (scorecard?.sourceAudit?.files ?? []).map((entry) => entry.path);
  if (!Array.isArray(scorecard?.sourceAudit?.files) || scorecard.sourceAudit.files.some((entry) => !isSha256(entry.sha256)) || JSON.stringify(sourceAuditFiles) !== JSON.stringify(contract.sourceAuditFiles) || scorecard?.sourceAudit?.networkPrimitiveMatches?.length !== 0) errors.push("sourceAudit");
  const implementationByPath = new Map((scorecard?.implementation?.files ?? []).map((entry) => [entry.path, entry.sha256]));
  if ((scorecard?.sourceAudit?.files ?? []).some((entry) => implementationByPath.get(entry.path) !== entry.sha256)) errors.push("sourceAudit.binding");
  if (scorecard?.commandLog?.path !== "runtime-bootstrap-command-log.json" || !isSha256(scorecard?.commandLog?.sha256)) errors.push("commandLog.binding");
  const expectedIds = ["resolver-contract-fixture", "clean-host-actionable-failure", "invalid-override-fails-closed", "actual-host-outcome"];
  if (commandLog?.schemaVersion !== "slidewright-runtime-bootstrap-command-log-v2" || commandLog?.profile !== scorecard?.host?.profile || JSON.stringify((commandLog?.commands ?? []).map((entry) => entry.id)) !== JSON.stringify(expectedIds)) {
    errors.push("commandLog.schema");
  } else {
    if (/([A-Za-z]:\\\\Users\\\\|\/home\/|\/Users\/|\/mnt\/)/.test(JSON.stringify(commandLog))) errors.push("commandLog.machinePath");
    const expectedArgv = ["node", "<repo>/scripts/setup-artifact-runtime.mjs", "--workspace", "<target-workspace>", "--json"];
    for (const command of commandLog.commands) {
      if (JSON.stringify(command.argv) !== JSON.stringify(expectedArgv) || command.stdoutSha256 !== sha256Bytes(command.stdout) || command.stderrSha256 !== sha256Bytes(command.stderr) || !Number.isInteger(command.exitCode) || typeof command.workspace?.existedBefore !== "boolean" || typeof command.workspace?.existsAfter !== "boolean") errors.push(`commandLog.receipt:${command.id}`);
    }
    const [fixtureCommand, failureCommand, overrideCommand, actualCommand] = commandLog.commands;
    if (!validateTree(commandLog.trees?.fixture) || (commandLog.trees?.actual !== null && !validateTree(commandLog.trees.actual))) errors.push("commandLog.trees");
    let fixtureReport = null;
    try { fixtureReport = JSON.parse(fixtureCommand.stdout); } catch { errors.push("commandLog.fixtureJson"); }
    const fixtureCandidate = fixtureReport?.attempts?.find((attempt) => attempt.source === "explicit-runtime-root" && attempt.valid === true)?.candidate;
    const fixtureImportDerived = pathContains(fixtureCandidate, fixtureReport?.resolvedEntrypoint);
    if (fixtureCommand.workspace.existedBefore !== false || fixtureCommand.workspace.existsAfter !== true || fixtureCommand.exitCode !== scorecard?.fixture?.commandExitCode || fixtureCommand.stdoutSha256 !== scorecard?.fixture?.commandStdoutSha256 || fixtureCommand.stderrSha256 !== scorecard?.fixture?.commandStderrSha256 || fixtureCommand.stderr !== "" || fixtureReport?.source !== scorecard?.fixture?.source || fixtureReport?.hostProfile !== scorecard?.fixture?.hostProfile || fixtureReport?.artifactToolVersion !== scorecard?.fixture?.artifactToolVersion || fixtureReport?.downloaded !== false || fixtureReport?.rendererSwitched !== false || fixtureImportDerived !== scorecard?.fixture?.importSmokePassed || fixtureImportDerived !== scorecard?.fixture?.linkedPackageIdentityPreserved || commandLog.trees.fixture.fileCount !== scorecard?.fixture?.sourcePackageTree?.fileCount || commandLog.trees.fixture.sha256 !== scorecard?.fixture?.sourcePackageTree?.sha256) errors.push("commandLog.fixtureBinding");
    if (!failureRecordMatchesReceipt(scorecard?.failure, failureCommand, contract.failureCodes.unavailable)) errors.push("commandLog.failureBinding");
    if (!failureRecordMatchesReceipt(scorecard?.invalidOverride, overrideCommand, contract.failureCodes.invalidOverride) || scorecard?.invalidOverride?.fellThrough !== overrideCommand.workspace.existsAfter) errors.push("commandLog.overrideBinding");
    if (scorecard?.hostOutcome?.kind === "runtime-resolved") {
      let actualReport = null;
      try { actualReport = JSON.parse(actualCommand.stdout); } catch { errors.push("commandLog.actualJson"); }
      const actualCandidate = actualReport?.attempts?.find((attempt) => attempt.source === "codex-bundled-runtime" && attempt.valid === true)?.candidate;
      const actualImportDerived = pathContains(actualCandidate, actualReport?.resolvedEntrypoint);
      if (actualCommand.workspace.existedBefore !== false || actualCommand.workspace.existsAfter !== true || actualCommand.exitCode !== 0 || actualCommand.stdoutSha256 !== scorecard.hostOutcome.commandStdoutSha256 || actualCommand.stderrSha256 !== scorecard.hostOutcome.commandStderrSha256 || actualCommand.stderr !== "" || actualReport?.source !== "codex-bundled-runtime" || actualReport?.hostProfile !== scorecard.hostOutcome.hostProfile || actualReport?.artifactToolVersion !== scorecard.hostOutcome.artifactToolVersion || actualReport?.downloaded !== false || actualReport?.rendererSwitched !== false || actualImportDerived !== scorecard.hostOutcome.importSmokePassed || !validateTree(commandLog.trees.actual) || commandLog.trees.actual.fileCount !== scorecard.hostOutcome.packageTree.fileCount || commandLog.trees.actual.sha256 !== scorecard.hostOutcome.packageTree.sha256) errors.push("commandLog.actualRuntimeBinding");
    } else if (!failureRecordMatchesReceipt(scorecard?.hostOutcome, actualCommand, contract.failureCodes.unavailable) || actualCommand.stdoutSha256 !== scorecard?.hostOutcome?.commandStdoutSha256 || commandLog.trees.actual !== null) {
      errors.push("commandLog.actualFailureBinding");
    }
  }
  const passingControls = (scorecard?.controls ?? []).filter((control) => control.passed === true);
  const controlIds = new Set(passingControls.map((control) => control.id));
  if (passingControls.length !== contract.requiredControls.length || controlIds.size !== contract.requiredControls.length) errors.push("controls");
  for (const id of contract.requiredControls) if (!controlIds.has(id)) errors.push(`control:${id}`);
  if (scorecard?.valid !== true) errors.push("valid");
  return { valid: errors.length === 0, errors };
}

export function validateRuntimeAggregate(aggregate, contract) {
  const errors = [];
  if (aggregate?.schemaVersion !== RUNTIME_AGGREGATE_SCHEMA) errors.push("schemaVersion");
  const profiles = (aggregate?.profiles ?? []).map((entry) => entry.profile);
  const expectedProfiles = aggregate?.scope === "native" ? contract.nativeCiProfiles : aggregate?.scope === "complete" ? contract.requiredProfiles : [];
  if (JSON.stringify([...profiles].sort()) !== JSON.stringify([...expectedProfiles].sort())) errors.push("profiles");
  if (aggregate?.complete !== (aggregate?.scope === "complete")) errors.push("complete");
  if (aggregate?.creditEligible !== (aggregate?.scope === "complete")) errors.push("creditEligible");
  const expectedPending = contract.requiredProfiles.filter((profile) => !expectedProfiles.includes(profile));
  if (JSON.stringify(aggregate?.pendingProfiles ?? []) !== JSON.stringify(expectedPending)) errors.push("pendingProfiles");
  if (!isSha256(aggregate?.contractSha256) || !isSha256(aggregate?.implementationSha256) || !isSha256(aggregate?.aggregateSha256)) errors.push("hashes");
  if (!/^[a-f0-9]{40}$/.test(aggregate?.git?.commit ?? "")) errors.push("git.commit");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(aggregate?.git?.runUrl ?? "")) errors.push("git.runUrl");
  if (aggregate?.provenance?.nativeRunUrl !== aggregate?.git?.runUrl) errors.push("provenance.native");
  const profileRecords = aggregate?.profiles ?? [];
  if (profileRecords.some((entry) => !isSha256(entry.scorecardSha256) || !isSha256(entry.commandLogSha256))) errors.push("profile.hashes");
  if (aggregate?.scope === "complete") {
    const scorecardMatch = String(aggregate?.provenance?.wslReleaseUrl ?? "").match(RELEASE_SCORECARD_URL);
    const commandLogMatch = String(aggregate?.provenance?.wslCommandLogUrl ?? "").match(RELEASE_COMMAND_LOG_URL);
    const receipt = aggregate?.provenance?.wslPublicFetch;
    const wsl = profileRecords.find((entry) => entry.profile === "wsl");
    if (!scorecardMatch || !commandLogMatch || scorecardMatch[1] !== commandLogMatch[1]) errors.push("provenance.wsl");
    if (receipt?.scorecardUrl !== aggregate?.provenance?.wslReleaseUrl || receipt?.commandLogUrl !== aggregate?.provenance?.wslCommandLogUrl || receipt?.byteMatched !== true || !Number.isInteger(receipt?.scorecardBytes) || receipt.scorecardBytes <= 0 || !Number.isInteger(receipt?.commandLogBytes) || receipt.commandLogBytes <= 0 || receipt?.scorecardSha256 !== wsl?.scorecardSha256 || receipt?.commandLogSha256 !== wsl?.commandLogSha256) errors.push("provenance.wslFetch");
  }
  if (aggregate?.scope === "native" && (aggregate?.provenance?.wslReleaseUrl !== null || aggregate?.provenance?.wslCommandLogUrl !== null || aggregate?.provenance?.wslPublicFetch !== null)) errors.push("provenance.nativeWsl");
  const repoFrom = (value) => String(value ?? "").match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\//)?.[1] ?? null;
  if (aggregate?.scope === "complete" && (repoFrom(aggregate.provenance.wslReleaseUrl) !== repoFrom(aggregate.git.runUrl) || repoFrom(aggregate.provenance.wslCommandLogUrl) !== repoFrom(aggregate.git.runUrl))) errors.push("provenance.repo");
  const { aggregateSha256, valid, ...core } = aggregate ?? {};
  if (aggregateSha256 !== sha256Bytes(stableJson(core))) errors.push("aggregateSha256");
  if (aggregate?.valid !== true) errors.push("valid");
  return { valid: errors.length === 0, errors };
}

export function assertOwnedOutput(root, outputPath) {
  const outputsRoot = path.resolve(root, "outputs");
  const resolved = path.resolve(outputPath);
  const relative = path.relative(outputsRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing output outside the repository outputs directory: ${resolved}`);
  }
  return resolved;
}
