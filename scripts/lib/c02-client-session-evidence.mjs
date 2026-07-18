import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CLIENT_ORIGINATORS = Object.freeze({
  "codex-desktop": "Codex Desktop",
});

const NONCE_PATTERN = /SLIDEWRIGHT_C02_NONCE=([A-Za-z0-9_-]{16,64})/u;
const SKILL_ENTRY_PATTERN = /^- slidewright: .+\(file: r0\/slidewright\/SKILL\.md\)$/mu;
const SHA256_PATTERN = /\b[a-f0-9]{64}\b/giu;

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const normalizeText = (value) => value.replace(/\r\n?/gu, "\n");

function eventText(event) {
  const payload = event?.payload ?? {};
  if (payload.type === "message") {
    return (payload.content ?? []).map((part) => part?.text ?? "").join("\n");
  }
  if (payload.type === "custom_tool_call") return String(payload.input ?? "");
  if (payload.type === "custom_tool_call_output") {
    if (typeof payload.output === "string") return payload.output;
    return (payload.output ?? []).map((part) => part?.text ?? "").join("\n");
  }
  if (event?.type === "world_state") return String(payload?.state?.host_skills?.body ?? "");
  if (event?.type === "event_msg" && payload.type === "agent_message") return String(payload.message ?? "");
  return "";
}

function receipt(record, kind) {
  return {
    kind,
    line: record.line,
    timestamp: record.event.timestamp,
    rawLineSha256: sha256(record.raw),
  };
}

function resolvedSkillPathFromRegistry(body) {
  const root = body.match(/^- `r0` = `([^`]+)`$/mu)?.[1];
  if (!root || !SKILL_ENTRY_PATTERN.test(body)) return null;
  return path.normalize(path.join(root, "slidewright", "SKILL.md"));
}

function isInstalledSkillRead(input, installedSkillPath) {
  const normalizePathText = (value) => value.replaceAll("\\", "/").replace(/\/{2,}/gu, "/").toLowerCase();
  const normalizedInput = normalizePathText(input);
  const normalizedPath = normalizePathText(installedSkillPath);
  return normalizedInput.includes(normalizedPath)
    && /(?:get-content|readfile|\bcat\b|\btype\b)/iu.test(input);
}

function finalize(proof) {
  const copy = structuredClone(proof);
  delete copy.proofHash;
  proof.proofHash = sha256(JSON.stringify(copy));
  return proof;
}

export function assertClientSessionProof(proof) {
  const failures = [];
  if (proof?.schemaVersion !== "slidewright-c02-client-session-proof/v1") failures.push("unsupported schema");
  if (!Object.hasOwn(CLIENT_ORIGINATORS, proof?.surface)) failures.push("unsupported or unverified client surface");
  if (proof?.client?.originator !== CLIENT_ORIGINATORS[proof?.surface]) failures.push("client originator mismatch");
  if (!/^[0-9a-f-]{36}$/u.test(proof?.client?.sessionId ?? "")) failures.push("missing session id");
  if (proof?.client?.callerSuppliedIdentity === true) failures.push("caller-supplied client identity is non-credit");
  if (proof?.skill?.name !== "slidewright" || proof?.skill?.registryPath !== "${CODEX_HOME}/skills/slidewright/SKILL.md") failures.push("skill registry binding mismatch");
  if (!/^[a-f0-9]{64}$/u.test(proof?.skill?.installedNormalizedSha256 ?? "")) failures.push("missing installed skill hash");
  if (proof?.skill?.installedNormalizedSha256 !== proof?.skill?.publicSourceNormalizedSha256) failures.push("installed skill does not match public source");
  const requiredReceipts = ["session-meta", "skill-injection", "host-skill-registry", "skill-selection", "installed-skill-read", "installed-skill-read-result"];
  const receipts = proof?.receipts ?? [];
  for (const kind of requiredReceipts) if (!receipts.some((item) => item.kind === kind)) failures.push(`missing ${kind} receipt`);
  if (receipts.some((item) => !Number.isInteger(item.line) || item.line < 1 || !/^[a-f0-9]{64}$/u.test(item.rawLineSha256 ?? ""))) failures.push("malformed event receipt");
  if (proof?.discoveryUseValid !== (failures.length === 0)) failures.push("discovery/use validity flag mismatch");
  const nonceValid = Boolean(
    proof?.nonce?.present
    && /^[A-Za-z0-9_-]{16,64}$/u.test(proof?.nonce?.value ?? "")
    && receipts.some((item) => item.kind === "client-nonce-request")
    && receipts.some((item) => item.kind === "client-nonce-response"),
  );
  if (proof?.nonceProofValid !== nonceValid) failures.push("nonce validity flag mismatch");
  if (proof?.surfaceComplete !== (proof?.discoveryUseValid === true && nonceValid)) failures.push("surface completion flag mismatch");
  if (proof?.c02Complete !== false) failures.push("one surface proof cannot complete C02");
  const copy = structuredClone(proof);
  delete copy.proofHash;
  if (proof?.proofHash !== sha256(JSON.stringify(copy))) failures.push("proof hash mismatch");
  if (failures.length) throw new Error(`C02 client session proof rejected: ${failures.join("; ")}`);
  return true;
}

export async function captureClientSessionProof({
  rolloutPath,
  installedSkillPath,
  publicSourceNormalizedSha256,
  publicSourceCommit,
  surface,
}) {
  if (!Object.hasOwn(CLIENT_ORIGINATORS, surface)) {
    throw new Error(`No verified originator contract exists for surface: ${surface}. Capture a real client session before adding it.`);
  }
  const installedBytes = await fs.readFile(installedSkillPath, "utf8");
  const installedNormalizedSha256 = sha256(normalizeText(installedBytes));
  if (installedNormalizedSha256 !== publicSourceNormalizedSha256) {
    throw new Error("Installed skill does not match the declared public source hash.");
  }

  const lines = (await fs.readFile(rolloutPath, "utf8")).split(/\r?\n/u).filter(Boolean);
  const records = lines.map((raw, index) => ({ raw, line: index + 1, event: JSON.parse(raw) }));
  const session = records.find((record) => record.event.type === "session_meta");
  if (!session) throw new Error("Rollout has no session_meta event.");
  const meta = session.event.payload ?? {};
  if (meta.originator !== CLIENT_ORIGINATORS[surface]) {
    throw new Error(`Expected ${CLIENT_ORIGINATORS[surface]} originator, received ${meta.originator ?? "<missing>"}.`);
  }

  const injection = records.find((record) => {
    const payload = record.event.payload ?? {};
    return record.event.type === "response_item"
      && payload.type === "message"
      && payload.role === "developer"
      && eventText(record.event).includes("<skills_instructions>")
      && resolvedSkillPathFromRegistry(eventText(record.event)) === path.normalize(installedSkillPath);
  });
  const registry = records.find((record) => record.event.type === "world_state"
    && resolvedSkillPathFromRegistry(eventText(record.event)) === path.normalize(installedSkillPath));
  if (!injection || !registry) throw new Error("Client rollout did not inject Slidewright into the host skill registry.");

  const selection = records.find((record) => record.line > injection.line
    && /\b(?:use|using)\b[^.\n]{0,80}\bSlidewright\b|\bSlidewright\b[^.\n]{0,80}\b(?:rules|contract|skill)\b/iu.test(eventText(record.event))
    && ((record.event.type === "event_msg" && record.event.payload?.type === "agent_message")
      || (record.event.type === "response_item" && record.event.payload?.type === "message" && record.event.payload?.role === "assistant")));
  if (!selection) throw new Error("No assistant selection of the client-injected Slidewright skill was recorded.");

  const readCall = records.find((record) => record.line > selection.line
    && record.event.type === "response_item"
    && record.event.payload?.type === "custom_tool_call"
    && isInstalledSkillRead(eventText(record.event), path.normalize(installedSkillPath)));
  const readResult = readCall && records.find((record) => record.line > readCall.line
    && record.event.type === "response_item"
    && record.event.payload?.type === "custom_tool_call_output"
    && record.event.payload?.call_id === readCall.event.payload?.call_id);
  const readOutput = readResult ? eventText(readResult.event) : "";
  if (!readCall || !readResult || !/Exit code: 0/iu.test(readOutput) || readOutput.includes("NO_INSTALLED_SKILL")) {
    throw new Error("Installed Slidewright skill read did not complete successfully.");
  }
  const outputHashes = readOutput.match(SHA256_PATTERN)?.map((value) => value.toLowerCase()) ?? [];
  if (!outputHashes.includes(installedNormalizedSha256)) throw new Error("Installed skill read did not emit the bound public skill hash.");

  const nonceRequest = records.find((record) => {
    const payload = record.event.payload ?? {};
    return record.line > injection.line
      && record.event.type === "response_item"
      && payload.type === "message"
      && payload.role === "user"
      && NONCE_PATTERN.test(eventText(record.event))
      && /\$slidewright\b/iu.test(eventText(record.event));
  });
  const nonceValue = nonceRequest ? eventText(nonceRequest.event).match(NONCE_PATTERN)?.[1] : null;
  const nonceResponse = nonceRequest && records.find((record) => record.line > Math.max(nonceRequest.line, readResult.line)
    && ((record.event.type === "event_msg" && record.event.payload?.type === "agent_message")
      || (record.event.type === "response_item" && record.event.payload?.type === "message" && record.event.payload?.role === "assistant"))
    && eventText(record.event).includes(`SLIDEWRIGHT_C02_NONCE=${nonceValue}`));

  const proof = {
    schemaVersion: "slidewright-c02-client-session-proof/v1",
    surface,
    discoveryUseValid: true,
    nonceProofValid: Boolean(nonceRequest && nonceResponse),
    surfaceComplete: Boolean(nonceRequest && nonceResponse),
    c02Complete: false,
    client: {
      sessionId: meta.id,
      originator: meta.originator,
      clientSource: meta.source ?? null,
      cliVersion: meta.cli_version ?? null,
      callerSuppliedIdentity: false,
    },
    skill: {
      name: "slidewright",
      registryPath: "${CODEX_HOME}/skills/slidewright/SKILL.md",
      installedNormalizedSha256,
      publicSourceNormalizedSha256,
      publicSourceCommit,
    },
    nonce: {
      requiredForSurfaceCompletion: true,
      present: Boolean(nonceRequest && nonceResponse),
      value: nonceRequest && nonceResponse ? nonceValue : null,
    },
    source: {
      kind: "client-rollout-jsonl",
      rawRolloutCommitted: false,
      sanitizedEventReceiptsOnly: true,
    },
    receipts: [
      receipt(session, "session-meta"),
      receipt(injection, "skill-injection"),
      receipt(registry, "host-skill-registry"),
      receipt(selection, "skill-selection"),
      receipt(readCall, "installed-skill-read"),
      receipt(readResult, "installed-skill-read-result"),
      ...(nonceRequest && nonceResponse ? [receipt(nonceRequest, "client-nonce-request"), receipt(nonceResponse, "client-nonce-response")] : []),
    ],
    limitations: [
      "The private client rollout is not committed; only sanitized event hashes and non-sensitive metadata are retained.",
      ...(nonceRequest && nonceResponse ? [] : ["No client-originated nonce request/response is present, so this surface remains incomplete."]),
      "A separate genuine VS Code extension proof and the existing CLI proof remain required before C02 can advance to 1.",
    ],
  };
  finalize(proof);
  assertClientSessionProof(proof);
  return proof;
}
