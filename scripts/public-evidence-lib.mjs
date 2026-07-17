import crypto from "node:crypto";

export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

export function contentHash(value, hashField) {
  const copy = structuredClone(value);
  delete copy[hashField];
  return sha256(stable(copy));
}

export function parseNodeTestSummary(log) {
  const count = (label) => Number(String(log).match(new RegExp(`^(?:#|ℹ)\\s+${label}\\s+(\\d+)\\s*$`, "mu"))?.[1] || 0);
  return {
    total: count("tests"),
    passed: count("pass"),
    failed: count("fail"),
    cancelled: count("cancelled"),
    skipped: count("skipped"),
  };
}

export const PUBLIC_SUITES = [
  {
    id: "c14-geometric-readability",
    command: "npm run defects",
    source: "outputs/defects/scorecard.json",
    file: "c14-geometric-readability.json",
    proofScope: "Plan, realized-layout, rendered, and PowerPoint-bounds defect controls.",
    limitations: "Native Office charts and arbitrary third-party decks are outside this scorecard.",
    requires: ["Codex presentation runtime", "Python", "PowerPoint for the final bounds control"],
  },
  {
    id: "g22-g23-design-profile",
    command: "npm run design-profile",
    source: "outputs/design-profile/scorecard.json",
    file: "g22-g23-design-profile.json",
    proofScope: "Source-bound design-profile extraction, clone-only reuse, exact rim symmetry, and PowerPoint round trip.",
    limitations: "This is clone-only source reuse, not arbitrary structural import.",
    requires: ["Codex presentation runtime", "Python", "PowerPoint"],
  },
  {
    id: "g24-g28-feedback-contracts",
    command: "npm run feedback-contract",
    source: "outputs/feedback-contract/scorecard.json",
    file: "g24-g28-feedback-contracts.json",
    proofScope: "Text separation, headline safe width, backing growth, exact topic coverage, and inherited-bullet hygiene.",
    limitations: "The suite proves the frozen 34-slide contract and source fixture, not universal layout quality.",
    requires: ["Codex presentation runtime", "Python", "PowerPoint"],
  },
];

export function assertPublicScorecard(id, scorecard) {
  if (!scorecard || scorecard.valid !== true) throw new Error(`${id}: source scorecard is not valid.`);
  if (id === "c14-geometric-readability") {
    if (scorecard.negativeProofs?.length !== 14) throw new Error(`${id}: expected exactly 14 negative proofs.`);
    if (scorecard.deterministicRepetitions !== 3) throw new Error(`${id}: deterministic repetition proof is missing.`);
  } else if (id === "g22-g23-design-profile") {
    if (scorecard.negativeControls?.length !== 8 || !scorecard.negativeControls.every((item) => item.rejected)) {
      throw new Error(`${id}: all eight destructive controls must be rejected.`);
    }
    if (!scorecard.powerpointRoundtripValid || !scorecard.powerpointVisualAuditValid) {
      throw new Error(`${id}: PowerPoint round-trip evidence is incomplete.`);
    }
  } else if (id === "g24-g28-feedback-contracts") {
    if (scorecard.planLint?.negativeControls?.length !== 9) throw new Error(`${id}: expected nine plan controls.`);
    if (scorecard.ooxml?.negativeControls?.length !== 5) throw new Error(`${id}: expected five OOXML controls.`);
    if (!scorecard.powerPoint?.exactStatePreserved || !scorecard.powerPoint?.renderExact) {
      throw new Error(`${id}: exact PowerPoint state/render proof is incomplete.`);
    }
  } else {
    throw new Error(`Unknown public scorecard ${id}.`);
  }
}

export function rejectMachineSpecificContent(label, value) {
  const text = JSON.stringify(value);
  const forbidden = [/[A-Za-z]:\\\\Users\\\\/i, /\/home\/runner\//i, /\/Users\//i, /OneDrive/i, /micgr/i];
  const match = forbidden.find((pattern) => pattern.test(text));
  if (match) throw new Error(`${label}: machine-specific content matched ${match}.`);
}
