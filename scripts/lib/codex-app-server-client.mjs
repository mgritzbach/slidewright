import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

function windowsProcessTree(rootPid) {
  const script = [
    `$rootPid = [uint32]${Number(rootPid)}`,
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name)",
    "$ids = [System.Collections.Generic.HashSet[uint32]]::new()",
    "[void]$ids.Add($rootPid)",
    "do {",
    "  $changed = $false",
    "  foreach ($process in $all) {",
    "    if ($ids.Contains([uint32]$process.ParentProcessId) -and -not $ids.Contains([uint32]$process.ProcessId)) {",
    "      [void]$ids.Add([uint32]$process.ProcessId)",
    "      $changed = $true",
    "    }",
    "  }",
    "} while ($changed)",
    "$owned = @($all | Where-Object { $ids.Contains([uint32]$_.ProcessId) } | ForEach-Object { [pscustomobject]@{ pid=[uint32]$_.ProcessId; creationDate=[string]$_.CreationDate; name=[string]$_.Name } })",
    "Write-Output (ConvertTo-Json -Compress -InputObject $owned)",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Could not inventory owned app-server process tree: ${result.stderr}`);
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function windowsProcessIdentities(pids) {
  if (pids.length === 0) return [];
  const literal = pids.map((pid) => `[uint32]${Number(pid)}`).join(",");
  const script = [
    `$ids = @(${literal})`,
    "$owned = @(Get-CimInstance Win32_Process | Where-Object { $ids -contains [uint32]$_.ProcessId } | ForEach-Object { [pscustomobject]@{ pid=[uint32]$_.ProcessId; creationDate=[string]$_.CreationDate; name=[string]$_.Name } })",
    "Write-Output (ConvertTo-Json -Compress -InputObject $owned)",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Could not verify owned app-server process identities: ${result.stderr}`);
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function survivingWindowsIdentities(owned) {
  if (owned.length === 0) return [];
  const byPid = new Map(windowsProcessIdentities(owned.map((item) => item.pid)).map((item) => [item.pid, item]));
  return owned.filter((identity) => {
    const current = byPid.get(identity.pid);
    return current && current.creationDate === identity.creationDate && current.name === identity.name;
  });
}

export async function closeAppServerClients(clients) {
  const active = clients.filter(Boolean);
  const results = await Promise.allSettled(active.map((client) => client.close()));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, `Failed to clean up ${errors.length} Codex app-server client(s).`);
}

export class CodexAppServerClient {
  constructor({ node = process.execPath, codexEntrypoint, cwd, env, clientName, timeoutMs = 20_000, gracefulShutdownMs = 5_000, forceShutdownMs = 2_000 }) {
    if (!codexEntrypoint) throw new Error("codexEntrypoint is required.");
    this.timeoutMs = timeoutMs;
    this.gracefulShutdownMs = gracefulShutdownMs;
    this.forceShutdownMs = forceShutdownMs;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(node, [codexEntrypoint, "app-server", "--stdio"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;
    this.exited = false;
    this.exitResult = null;
    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitResult = { code, signal };
        resolve(this.exitResult);
      });
    });
    this.clientName = clientName;
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.child.on("error", (error) => this.#rejectAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        this.#rejectAll(new Error(`Codex app-server exited before replying (code=${code}, signal=${signal}). ${this.stderr}`));
      }
    });
    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.#handleLine(line));
  }

  #rejectAll(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  #handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined || !this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`${message.error.code ?? "APP_SERVER"}: ${message.error.message ?? JSON.stringify(message.error)}`));
    else pending.resolve(message.result);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}. ${this.stderr}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async initialize() {
    return this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        title: `Slidewright ${this.clientName} installation probe`,
        version: "1.0.0",
      },
      capabilities: { experimentalApi: true },
    });
  }

  async close() {
    const hasExited = () => this.exited || this.child.exitCode !== null || this.child.signalCode !== null;
    const waitForExit = async (milliseconds) => {
      if (hasExited()) return true;
      let timer;
      const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); });
      const exited = this.exitPromise.then(() => true);
      const result = await Promise.race([exited, timedOut]);
      clearTimeout(timer);
      return result;
    };
    if (hasExited()) return;
    this.child.stdin.end();
    if (await waitForExit(this.gracefulShutdownMs)) return;
    if (hasExited()) return;
    if (process.platform === "win32") {
      const owned = windowsProcessTree(this.pid);
      const launcher = owned.find((identity) => identity.pid === this.pid);
      if (!launcher && !hasExited()) throw new Error(`Could not prove ownership of Codex app-server launcher ${this.pid} before tree cleanup.`);
      if (hasExited()) return;
      spawnSync("taskkill.exe", ["/PID", String(this.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await waitForExit(this.forceShutdownMs);
      const survivors = survivingWindowsIdentities(owned);
      if (survivors.length) throw new Error(`Owned Codex app-server process tree survived cleanup: ${survivors.map((item) => `${item.name}:${item.pid}`).join(", ")}.`);
      if (!hasExited()) throw new Error(`Codex app-server launcher ${this.pid} did not report exit after owned-tree cleanup.`);
      return;
    } else {
      try { process.kill(-this.pid, "SIGTERM"); } catch { if (!hasExited()) this.child.kill(); }
    }
    if (await waitForExit(this.forceShutdownMs)) return;
    if (hasExited()) return;
    try { process.kill(-this.pid, "SIGKILL"); } catch { if (!hasExited()) this.child.kill("SIGKILL"); }
    if (!await waitForExit(this.forceShutdownMs) && !hasExited()) throw new Error(`Codex app-server process ${this.pid} did not exit after owned-process cleanup.`);
  }
}
