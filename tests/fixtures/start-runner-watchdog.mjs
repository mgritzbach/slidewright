import path from "node:path";
import { startRunnerWatchdog } from "../../scripts/lib/runner-watchdog.mjs";

const [root, stagingDir, watchdogScript, cleanupScript, completionMarker, readyMarker, recoveryReport, diagnosticLog] = process.argv.slice(2);
const result = await startRunnerWatchdog({
  root,
  stagingDir,
  watchdogScript,
  cleanupScript,
  completionMarker,
  readyMarker,
  recoveryReport,
  diagnosticLog,
  startupTimeoutMs: 10_000,
  scanWindowMilliseconds: 1_000,
});
process.stdout.write(`${JSON.stringify({ ...result, stagingDir: path.resolve(stagingDir) })}\n`);
