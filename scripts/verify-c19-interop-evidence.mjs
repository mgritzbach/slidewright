#!/usr/bin/env node
import path from "node:path";
import { verifyPublishedC19Evidence } from "./lib/c19-interop-evidence.mjs";

const root = process.cwd();
const result = await verifyPublishedC19Evidence({ root, published: path.join(root, "evidence", "c19", "v1") });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
