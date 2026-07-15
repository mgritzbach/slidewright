#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const destination = path.join(root, "outputs", "submission", "screenshots");
const assets = [
  ["fixtures/independent/7a688db716046c64928d4ee197cd9e211360cd7b62f4c5db5a885fd508a85bb8.png", "01-independent-reference.png"],
  ["outputs/ingestion/reconstruction/slide-1.png", "02-editable-reconstruction.png"],
  ["outputs/fidelity/slidewright-fidelity-benchmark/slide-1.png", "03-horizontal-native-design.png"],
  ["outputs/template/source/slide-1.png", "04-template-before.png"],
  ["outputs/template/slidewright-mit-template-edited/slide-1.png", "05-template-after.png"],
  ["outputs/template/powerpoint-roundtrip/slide-1.png", "06-powerpoint-roundtrip.png"],
];

await fs.rm(path.dirname(destination), { recursive: true, force: true });
await fs.mkdir(destination, { recursive: true });
const manifest = [];
for (const [sourceRelative, targetName] of assets) {
  const source = path.join(root, sourceRelative);
  const target = path.join(destination, targetName);
  const content = await fs.readFile(source).catch(() => {
    throw new Error(`Missing ${sourceRelative}; run npm run release:check first.`);
  });
  await fs.writeFile(target, content);
  manifest.push({
    file: `screenshots/${targetName}`,
    source: sourceRelative.replaceAll("\\", "/"),
    bytes: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  });
}
await fs.writeFile(path.join(root, "outputs", "submission", "asset-manifest.json"), `${JSON.stringify({ valid: true, assets: manifest }, null, 2)}\n`, "utf8");
process.stdout.write(`Prepared ${manifest.length} submission screenshots in ${destination}\n`);
