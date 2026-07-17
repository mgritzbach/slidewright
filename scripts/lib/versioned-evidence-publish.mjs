import fs from "node:fs/promises";
import path from "node:path";

async function listRegularFiles(root, directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listRegularFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Versioned evidence contains unsupported filesystem entry: ${absolute}`);
  }
  return files;
}

async function assertIdenticalTrees(left, right) {
  const [leftFiles, rightFiles] = await Promise.all([listRegularFiles(left), listRegularFiles(right)]);
  if (leftFiles.length !== rightFiles.length || leftFiles.some((file, index) => file !== rightFiles[index])) {
    throw new Error(`Existing evidence run differs from staging file inventory: ${JSON.stringify({ leftFiles, rightFiles })}`);
  }
  for (const relative of leftFiles) {
    const [leftBytes, rightBytes] = await Promise.all([
      fs.readFile(path.join(left, ...relative.split("/"))),
      fs.readFile(path.join(right, ...relative.split("/"))),
    ]);
    if (!leftBytes.equals(rightBytes)) throw new Error(`Existing evidence run differs from staging bytes at ${relative}.`);
  }
}

async function assertScorecardBinding(directory, scorecardHash) {
  const scorecard = JSON.parse((await fs.readFile(path.join(directory, "scorecard.json"), "utf8")).replace(/^\uFEFF/u, ""));
  if (scorecard.scorecardHash !== scorecardHash) {
    throw new Error(`Evidence scorecard hash ${scorecard.scorecardHash ?? "<missing>"} does not match publication key ${scorecardHash}.`);
  }
}

async function replaceFileAtomically(target, contents) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, contents, "utf8");
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function publishVersionedEvidence(staging, published, scorecardHash, { currentSchemaVersion = "slidewright-semantic-current/v1", verifyFinal = null, currentExtra = null } = {}) {
  const runs = path.join(published, "runs");
  const finalRun = path.join(runs, scorecardHash);
  await fs.mkdir(runs, { recursive: true });
  await assertScorecardBinding(staging, scorecardHash);
  try {
    await fs.rename(staging, finalRun);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error;
    try { await fs.access(finalRun); } catch { throw error; }
    await assertScorecardBinding(finalRun, scorecardHash);
    await assertIdenticalTrees(staging, finalRun);
    await fs.rm(staging, { recursive: true, force: true });
  }
  if (verifyFinal) await verifyFinal(finalRun);
  const current = {
    schemaVersion: currentSchemaVersion,
    scorecardHash,
    run: `runs/${scorecardHash}`,
    ...(currentExtra ?? {}),
  };
  const scorecardTarget = path.join(published, "scorecard.json");
  const priorScorecard = await fs.readFile(scorecardTarget, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  try {
    await replaceFileAtomically(scorecardTarget, await fs.readFile(path.join(finalRun, "scorecard.json"), "utf8"));
    // current.json is authoritative and advances last. A crash before this
    // atomic rename leaves the prior run selected; a completed rename selects
    // a run that has already passed verifyFinal.
    await replaceFileAtomically(path.join(published, "current.json"), `${JSON.stringify(current, null, 2)}\n`);
  } catch (error) {
    if (priorScorecard === null) await fs.rm(scorecardTarget, { force: true });
    else await replaceFileAtomically(scorecardTarget, priorScorecard);
    throw error;
  }
  return finalRun;
}
