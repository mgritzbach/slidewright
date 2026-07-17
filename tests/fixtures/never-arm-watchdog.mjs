#!/usr/bin/env node
import fs from "node:fs/promises";
import { captureWorkerIdentityWithRetry } from "../../scripts/lib/exact-worker-process.mjs";

const parentIdentityReceiptPath = process.argv[5];
if (!parentIdentityReceiptPath) throw new Error("parentIdentityReceiptPath is required");
const identity = await captureWorkerIdentityWithRetry(process.pid);
if (!identity) throw new Error("Could not capture never-arm fixture identity");
await fs.writeFile(parentIdentityReceiptPath, `${JSON.stringify({ schemaVersion: "slidewright-forced-parent-identity/v1", ...identity }, null, 2)}\n`, "utf8");
setInterval(() => {}, 60_000);
