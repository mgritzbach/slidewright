import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function matchesOwnedPowerPoint(record, live) {
  return Boolean(record && live
    && Number.isInteger(record.processId)
    && record.processId > 0
    && record.processId === live.processId
    && record.processName === "POWERPNT"
    && live.processName === "POWERPNT"
    && typeof record.processStartTime === "string"
    && record.processStartTime.length > 0
    && record.processStartTime === live.processStartTime);
}

export function cleanupOwnedPowerPoint(recordPath, { root = process.cwd(), platform = process.platform } = {}) {
  if (platform !== "win32") return { valid: true, cleaned: false, reason: "non-windows" };
  if (!recordPath || !fs.existsSync(recordPath)) return { valid: true, cleaned: false, reason: "ownership-record-missing" };
  let record;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    return { valid: false, cleaned: false, reason: `invalid-ownership-record: ${error.message}` };
  }
  if (!Number.isInteger(record.processId) || record.processId < 1 || record.processName !== "POWERPNT" || typeof record.processStartTime !== "string") {
    return { valid: false, cleaned: false, reason: "ownership-record-fields-invalid" };
  }
  const script = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "semantic_surface", "cleanup_owned_powerpoint.ps1");
  const result = spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
    "-OwnershipRecordJson", recordPath,
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
  if (result.error) return { valid: false, cleaned: false, reason: result.error.message };
  try {
    const report = JSON.parse((result.stdout || "").replace(/^\uFEFF/u, "").trim());
    return { ...report, exitCode: result.status };
  } catch {
    return { valid: false, cleaned: false, reason: `cleanup-worker-failed-${result.status}`, stderr: (result.stderr || "").trim() };
  }
}
