import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureWorkerIdentity } from "../scripts/lib/exact-worker-process.mjs";
import { startRunnerWatchdog } from "../scripts/lib/runner-watchdog.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const semantic = path.join(root, "plugins", "slidewright", "skills", "slidewright", "scripts", "semantic_surface");
const watchdogScript = path.join(semantic, "powerpoint_mutation_runner_watchdog.ps1");
const cleanupScript = path.join(semantic, "cleanup_owned_powerpoint.ps1");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("C18 watchdog exits on a completion marker while its parent remains alive", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows C18 watchdog control");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "slidewright-c18-watchdog-"));
  const completion = path.join(directory, "complete.marker");
  const ready = path.join(directory, "ready.marker");
  const recovery = path.join(directory, "recovery.json");
  const diagnostic = path.join(directory, "diagnostic.log");
  try {
    const startup = await startRunnerWatchdog({
      root,
      stagingDir: path.join(directory, "staging"),
      watchdogScript,
      cleanupScript,
      completionMarker: completion,
      readyMarker: ready,
      recoveryReport: recovery,
      diagnosticLog: diagnostic,
      scanWindowMilliseconds: 1_000,
    });
    assert.equal(startup.enabled, true);
    assert.ok(captureWorkerIdentity(startup.processId));
    await fs.writeFile(completion, "complete\n", "utf8");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && captureWorkerIdentity(startup.processId)) await delay(100);
    assert.equal(captureWorkerIdentity(startup.processId), null);
    await assert.rejects(fs.access(recovery), (error) => error.code === "ENOENT");
    assert.equal(process.pid > 0, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
