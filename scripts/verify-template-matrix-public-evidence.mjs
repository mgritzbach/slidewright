#!/usr/bin/env node
import path from "node:path";
import { verifyPublishedTemplateMatrixEvidence } from "./lib/template-matrix-public-evidence.mjs";

const root = process.cwd();
const result = await verifyPublishedTemplateMatrixEvidence({ root, published: path.join(root, "evidence", "c10", "v1") });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
