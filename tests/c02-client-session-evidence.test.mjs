import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureClientSessionProof, normalizeText, sha256 } from "../scripts/lib/c02-client-session-evidence.mjs";

const skillBody = "---\nname: slidewright\n---\nproof fixture\n";
const nonce = "DesktopClientNonce_12345";
const sessionId = "019f6485-a254-7b30-8da7-f26d254bfcb8";

function line(type, payload, timestamp) {
  return JSON.stringify({ timestamp, type, payload });
}

function fixture({ originator = "Codex Desktop", includeNonce = true, readInstalled = true, qualified = false, lateNonce = false, subagent = false } = {}) {
  const registry = [
    "<skills_instructions>",
    "### Skill roots",
    `- \`r0\` = \`SKILL_ROOT\``,
    "### Available skills",
    `- ${qualified ? "slidewright:slidewright" : "slidewright"}: Compile editable decks (file: r0/slidewright/SKILL.md)`,
    "</skills_instructions>",
  ].join("\n");
  const records = [
    line("session_meta", { id: sessionId, originator, source: subagent ? { subagent: { thread_spawn: { parent_thread_id: "parent" } } } : "vscode", cli_version: "test" }, "2026-07-18T00:00:00.000Z"),
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: registry }] }, "2026-07-18T00:00:01.000Z"),
    line("world_state", { state: { host_skills: { body: registry.replace("<skills_instructions>\n", "").replace("\n</skills_instructions>", "") } } }, "2026-07-18T00:00:01.000Z"),
  ];
  if (includeNonce && !lateNonce) records.push(line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `$slidewright ${nonce}`.replace(nonce, `SLIDEWRIGHT_C02_NONCE=${nonce}`) }] }, "2026-07-18T00:00:02.000Z"));
  records.push(line("event_msg", { type: "agent_message", message: "I will use the Slidewright skill contract." }, "2026-07-18T00:00:03.000Z"));
  records.push(
    line("response_item", { type: "custom_tool_call", name: "exec", call_id: "read-1", input: readInstalled ? "Get-Content INSTALLED_SKILL -Raw" : "Get-Content repository/SKILL.md -Raw" }, "2026-07-18T00:00:04.000Z"),
    line("response_item", { type: "custom_tool_call_output", call_id: "read-1", output: [{ type: "input_text", text: `Exit code: 0\n${sha256(normalizeText(skillBody))}` }] }, "2026-07-18T00:00:05.000Z"),
  );
  if (includeNonce && lateNonce) records.push(line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `$slidewright SLIDEWRIGHT_C02_NONCE=${nonce}` }] }, "2026-07-18T00:00:05.500Z"));
  if (includeNonce) records.push(line("event_msg", { type: "agent_message", message: `SLIDEWRIGHT_C02_NONCE=${nonce}` }, "2026-07-18T00:00:06.000Z"));
  return records;
}

async function withFixture(options, callback) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c02-client-"));
  try {
    const skillRoot = path.join(temp, "skills");
    const installed = path.join(skillRoot, "slidewright", "SKILL.md");
    const rollout = path.join(temp, "rollout.jsonl");
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(installed, skillBody, "utf8");
    await fs.utimes(installed, new Date("2026-07-17T00:00:00.000Z"), new Date("2026-07-17T00:00:00.000Z"));
    const content = fixture(options)
      .map((record) => record.replaceAll("SKILL_ROOT", skillRoot.replaceAll("\\", "/")).replaceAll("INSTALLED_SKILL", installed.replaceAll("\\", "/")))
      .join("\n");
    await fs.writeFile(rollout, `${content}\n`, "utf8");
    return await callback({ rollout, installed });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function withRawFixture(records, callback) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c02-raw-"));
  try {
    const skillRoot = path.join(temp, "skills");
    const installed = path.join(skillRoot, "slidewright", "SKILL.md");
    const rollout = path.join(temp, "rollout.jsonl");
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(installed, skillBody, "utf8");
    await fs.utimes(installed, new Date("2026-07-17T00:00:00.000Z"), new Date("2026-07-17T00:00:00.000Z"));
    await fs.writeFile(rollout, `${records.map((record) => record.replaceAll("SKILL_ROOT", skillRoot.replaceAll("\\", "/")).replaceAll("INSTALLED_SKILL", installed.replaceAll("\\", "/"))).join("\n")}\n`, "utf8");
    return await callback({ rollout, installed });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

test("C02 client proof requires real Desktop origin, registry injection, installed-skill read, and nonce", async () => {
  await withFixture({}, async ({ rollout, installed }) => {
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.discoveryValid, true);
    assert.equal(proof.installedReadValid, true);
    assert.equal(proof.clientInvocationValid, true);
    assert.equal(proof.nonceProofValid, true);
    assert.equal(proof.surfaceComplete, true);
    assert.equal(proof.c02Complete, false);
  });
});

test("C02 client proof rejects a caller-label or backend identity in place of Codex Desktop", async () => {
  await withFixture({ originator: "desktop-app" }, async ({ rollout, installed }) => {
    await assert.rejects(() => captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    }), /Expected Codex Desktop originator/u);
  });
});

test("C02 client proof records discovery but refuses use credit for self-report without an installed-skill read", async () => {
  await withFixture({ readInstalled: false }, async ({ rollout, installed }) => {
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.discoveryValid, true);
    assert.equal(proof.installedReadValid, false);
    assert.equal(proof.clientInvocationValid, false);
    assert.equal(proof.surfaceComplete, false);
  });
});

test("C02 genuine discovery/use remains partial when the client nonce is absent", async () => {
  await withFixture({ includeNonce: false }, async ({ rollout, installed }) => {
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.discoveryValid, true);
    assert.equal(proof.installedReadValid, true);
    assert.equal(proof.clientInvocationValid, false);
    assert.equal(proof.nonceProofValid, false);
    assert.equal(proof.surfaceComplete, false);
    assert.equal(proof.c02Complete, false);
  });
});

test("C02 nonce must precede selection and installed-skill use", async () => {
  await withFixture({ lateNonce: true }, async ({ rollout, installed }) => {
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.discoveryValid, true);
    assert.equal(proof.installedReadValid, false);
    assert.equal(proof.nonceProofValid, false);
    assert.equal(proof.surfaceComplete, false);
  });
});

test("C02 accepts the genuine plugin-qualified registry path", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c02-plugin-"));
  try {
    const skillRoot = path.join(temp, "plugins", "cache", "slidewright", "slidewright", "0.3.0", "skills");
    const installed = path.join(skillRoot, "slidewright", "SKILL.md");
    const rollout = path.join(temp, "rollout.jsonl");
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(installed, skillBody, "utf8");
    await fs.utimes(installed, new Date("2026-07-17T00:00:00.000Z"), new Date("2026-07-17T00:00:00.000Z"));
    const content = fixture({ qualified: true })
      .map((record) => record.replaceAll("SKILL_ROOT", skillRoot.replaceAll("\\", "/")).replaceAll("INSTALLED_SKILL", installed.replaceAll("\\", "/")))
      .join("\n");
    await fs.writeFile(rollout, `${content}\n`, "utf8");
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.skill.distribution, "plugin");
    assert.equal(proof.skill.qualifiedName, "slidewright:slidewright");
    assert.equal(proof.surfaceComplete, true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("C02 Desktop-spawned subagents can prove discovery but cannot complete the primary client surface", async () => {
  await withFixture({ subagent: true }, async ({ rollout, installed }) => {
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.discoveryValid, true);
    assert.equal(proof.client.sessionKind, "subagent");
    assert.equal(proof.clientInvocationValid, true);
    assert.equal(proof.surfaceComplete, false);
  });
});

test("C02 refuses to carry an old turn's invocation into the current skill registry injection", async () => {
  const first = fixture({});
  const registryText = JSON.parse(first[1]).payload.content[0].text;
  const later = [
    line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: registryText }] }, "2026-07-18T01:00:00.000Z"),
    line("world_state", { state: { host_skills: { body: registryText.replace("<skills_instructions>\n", "").replace("\n</skills_instructions>", "") } } }, "2026-07-18T01:00:00.000Z"),
  ];
  await withRawFixture([...first, ...later], async ({ rollout, installed }) => {
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.receipts.find((item) => item.kind === "skill-injection").timestamp, "2026-07-18T01:00:00.000Z");
    assert.equal(proof.installedReadValid, false);
    assert.equal(proof.nonceProofValid, false);
    assert.equal(proof.surfaceComplete, false);
  });
});

test("C02 rejects loaded-byte credit when installation happened after registry injection", async () => {
  await withFixture({}, async ({ rollout, installed }) => {
    await fs.utimes(installed, new Date("2026-07-19T00:00:00.000Z"), new Date("2026-07-19T00:00:00.000Z"));
    const proof = await captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "codex-desktop",
    });
    assert.equal(proof.installedReadValid, true);
    assert.equal(proof.nonceProofValid, true);
    assert.equal(proof.skill.clientLoadedPublicBindingValid, false);
    assert.equal(proof.surfaceComplete, false);
  });
});

test("C02 verifier refuses invented VS Code originators until a real extension session defines the contract", async () => {
  await withFixture({}, async ({ rollout, installed }) => {
    await assert.rejects(() => captureClientSessionProof({
      rolloutPath: rollout,
      installedSkillPath: installed,
      publicSourceNormalizedSha256: sha256(normalizeText(skillBody)),
      publicSourceCommit: "4bca20216ccdaaed94d43552dc4248652bd4325f",
      surface: "vscode",
    }), /No verified originator contract exists/u);
  });
});
