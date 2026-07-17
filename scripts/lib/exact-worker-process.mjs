import { spawnSync } from "node:child_process";

function readWindowsProcessIdentity(processId) {
  const result = spawnSync("powershell", [
    "-NoProfile", "-Command",
    `$p=Get-Process -Id ${Number(processId)} -ErrorAction SilentlyContinue;if($p){[ordered]@{processId=[int]$p.Id;processName=[string]$p.ProcessName;processStartTime=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`,
  ], { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
  try { return JSON.parse(result.stdout.trim()); } catch { return null; }
}

export function captureWorkerIdentity(processId, { platform = process.platform } = {}) {
  if (!Number.isInteger(processId) || processId < 1) return null;
  if (platform === "win32") return readWindowsProcessIdentity(processId);
  return { processId, processName: null, processStartTime: null };
}

export function terminateExactWorker(processId, expected, { platform = process.platform } = {}) {
  if (!Number.isInteger(processId) || processId < 1) return { matched: false, terminated: false, reason: "invalid-worker-pid" };
  if (platform !== "win32") {
    try {
      process.kill(processId, "SIGKILL");
      return { matched: true, terminated: true, reason: "worker-signaled" };
    } catch {
      return { matched: false, terminated: false, reason: "worker-already-exited" };
    }
  }
  if (!expected || expected.processId !== processId || !expected.processName || !expected.processStartTime) {
    return { matched: false, terminated: false, reason: "worker-identity-unavailable-safe-refusal" };
  }
  if (String(expected.processName).toUpperCase() === "POWERPNT") {
    return { matched: false, terminated: false, reason: "powerpoint-is-never-a-worker" };
  }
  const live = readWindowsProcessIdentity(processId);
  if (!live) return { matched: false, terminated: false, reason: "worker-already-exited" };
  if (live.processId !== expected.processId || live.processName !== expected.processName || live.processStartTime !== expected.processStartTime) {
    return { matched: false, terminated: false, reason: "live-worker-does-not-match-captured-identity" };
  }
  const result = spawnSync("taskkill", ["/PID", String(processId), "/F"], { windowsHide: true, stdio: "ignore" });
  return {
    matched: true,
    terminated: result.status === 0,
    reason: result.status === 0 ? "exact-worker-terminated" : `exact-worker-taskkill-failed-${result.status}`,
  };
}
