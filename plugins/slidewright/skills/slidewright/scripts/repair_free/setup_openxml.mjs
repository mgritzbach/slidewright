#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function confined(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export async function setupOpenXmlValidator({ root = process.cwd(), contract }) {
  if (process.platform !== "win32") throw new Error("The C04 Open XML SDK + real-PowerPoint gate currently requires Windows.");
  const runtimeRoot = path.resolve(root, "outputs", "repair-free", "runtime", "openxml", contract.version);
  const allowedRoot = path.resolve(root, "outputs", "repair-free", "runtime");
  if (!confined(allowedRoot, runtimeRoot)) throw new Error(`Unsafe Open XML runtime path: ${runtimeRoot}`);
  const packagePath = path.join(runtimeRoot, `${contract.package}.${contract.version}.nupkg`);
  const assemblyPath = path.join(runtimeRoot, "package", "lib", contract.targetFramework, "DocumentFormat.OpenXml.dll");
  await fs.mkdir(runtimeRoot, { recursive: true });
  let downloaded = false;
  let packageBytes;
  try {
    packageBytes = await fs.readFile(packagePath);
  } catch {
    const response = await fetch(contract.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Open XML SDK download failed with HTTP ${response.status}.`);
    packageBytes = Buffer.from(await response.arrayBuffer());
    downloaded = true;
  }
  const packageSha256 = sha256(packageBytes);
  if (packageSha256 !== contract.sha256) {
    throw new Error(`Open XML SDK package hash mismatch: expected ${contract.sha256}, got ${packageSha256}.`);
  }
  await fs.writeFile(packagePath, packageBytes);
  let assemblyExists = true;
  try { await fs.access(assemblyPath); } catch { assemblyExists = false; }
  if (assemblyExists && sha256(await fs.readFile(assemblyPath)) !== contract.assemblySha256) {
    assemblyExists = false;
  }
  if (!assemblyExists) {
    const extractionRoot = path.join(runtimeRoot, "package");
    await fs.rm(extractionRoot, { recursive: true, force: true });
    const command = [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `[IO.Compression.ZipFile]::ExtractToDirectory('${packagePath.replaceAll("'", "''")}', '${extractionRoot.replaceAll("'", "''")}')`,
    ].join("; ");
    const result = spawnSync("powershell", ["-NoProfile", "-Command", command], { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Open XML SDK extraction failed: ${(result.stderr || result.stdout).trim()}`);
  }
  const assemblyBytes = await fs.readFile(assemblyPath);
  const assemblySha256 = sha256(assemblyBytes);
  if (assemblySha256 !== contract.assemblySha256) {
    throw new Error(`Open XML SDK assembly hash mismatch: expected ${contract.assemblySha256}, got ${assemblySha256}.`);
  }
  const report = {
    schemaVersion: "slidewright-openxml-runtime/v1",
    valid: true,
    package: contract.package,
    version: contract.version,
    targetFramework: contract.targetFramework,
    url: contract.url,
    packageSha256,
    packagePath,
    assemblyPath,
    assemblySha256,
    downloaded,
    rendererSwitched: false,
    silentInstall: false
  };
  await fs.writeFile(path.join(runtimeRoot, "runtime.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const root = process.cwd();
  const contractPath = path.resolve(process.argv[2] ?? "fixtures/repair-free/v1/fixture-contract.json");
  const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
  setupOpenXmlValidator({ root, contract: contract.openXml }).then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
