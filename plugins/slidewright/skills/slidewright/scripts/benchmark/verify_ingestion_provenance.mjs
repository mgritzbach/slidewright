import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateObservedDesign } from "../lib/observed-design.mjs";

async function sha256(file) {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function filesRecursively(root) {
  const found = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...await filesRecursively(full));
    else found.push(full);
  }
  return found;
}

export async function verifyIngestionProvenance({ root, fixture, designFile, parserLogFile, pptx, render, out }) {
  const design = validateObservedDesign(JSON.parse(await fs.readFile(designFile, "utf8")));
  const parserLog = JSON.parse(await fs.readFile(parserLogFile, "utf8"));
  const source = path.join(fixture, `${design.input.sha256}.png`);
  const loggedPath = (value) => path.resolve(root, ...value.split("/"));
  const sourceHash = await sha256(source);
  const fixtureNames = (await fs.readdir(fixture)).sort();
  const allowed = new Set([`${design.input.sha256}.png`, "observed-design.json", "parser-access-log.json", "provenance.txt"]);
  const forbiddenFixtureFiles = fixtureNames.filter((name) => !allowed.has(name));
  const implementationRoots = [path.join(root, "plugins"), path.join(root, "packages"), path.join(root, "scripts"), path.join(root, "tests")];
  const implementationFiles = (await Promise.all(implementationRoots.map(async (candidate) => {
    try { return await filesRecursively(candidate); } catch { return []; }
  }))).flat().filter((file) => /\.(?:mjs|js|py|json|md)$/iu.test(file));
  const textValues = design.objects.filter((object) => object.type === "text").map((object) => object.text.value).filter((value) => value.trim().length >= 8);
  const hardcodedHits = [];
  for (const file of implementationFiles) {
    const content = await fs.readFile(file, "utf8");
    for (const value of textValues) if (content.includes(value)) hardcodedHits.push({ file: path.relative(root, file), value });
  }
  const checks = {
    sourceHashMatchesFilename: sourceHash === design.input.sha256,
    parserInputHashMatchesSource: design.input.sha256 === sourceHash,
    fixtureContainsPixelsAndObservationOnly: forbiddenFixtureFiles.length === 0,
    parserWasContextIsolated: parserLog.forkTurns === "none" && parserLog.contextInherited === false,
    parserInitialReadWasOpaquePngOnly: JSON.stringify(parserLog.initialFilesRead.map(loggedPath)) === JSON.stringify([path.resolve(source)]),
    parserCorrectionReadOnlyOwnInputs: (parserLog.correctionFilesRead ?? []).map(loggedPath).every((file) => [path.resolve(source), path.resolve(designFile)].includes(file)),
    parserWroteOnlyObservation: JSON.stringify(parserLog.filesWritten.map(loggedPath)) === JSON.stringify([path.resolve(designFile)]),
    sourceBuilderDeletedBeforeParsing: parserLog.sourceBuilderDeletedBeforeParsing === true,
    noFixtureCopyHardcodedInImplementation: hardcodedHits.length === 0,
  };
  const report = {
    valid: Object.values(checks).every(Boolean),
    checks,
    forbiddenFixtureFiles,
    hardcodedHits,
    hashes: {
      sourceSha256: sourceHash,
      parserOutputSha256: await sha256(designFile),
      pptxSha256: await sha256(pptx),
      renderSha256: await sha256(render),
    },
    separation: {
      parserInput: "opaque RGB PNG only",
      rendererInput: "observed-design.json only",
      scorerInputs: "source PNG and rendered PNG only",
      sharedSourceGeometry: false,
    },
  };
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.valid) throw new Error(`Ingestion provenance failed: ${JSON.stringify({ checks, forbiddenFixtureFiles, hardcodedHits })}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, fixture, designFile, parserLogFile, pptx, render, out] = process.argv.slice(2);
  verifyIngestionProvenance({ root, fixture, designFile, parserLogFile, pptx, render, out }).then((report) => {
    process.stdout.write(`Independent-ingestion provenance passed: ${report.hashes.sourceSha256}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
