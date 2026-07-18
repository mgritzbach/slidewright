#!/usr/bin/env node
import path from "node:path";
import { verifyTemplateMatrixReview } from "./lib/template-matrix-evidence.mjs";

const root = process.cwd();
const published = path.join(root, "outputs", "template-matrix");
const result = await verifyTemplateMatrixReview({ root, published, requireCurrentSource: true });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
