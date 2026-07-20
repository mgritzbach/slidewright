#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMacosDesktopSuite } from "./macos_desktop_suite_lib.mjs";

const runner = fileURLToPath(import.meta.url);
const scripts = path.dirname(runner);
const root = path.resolve(scripts, "..", "..");

await runMacosDesktopSuite({
  root,
  runner,
  commonRunner: path.join(scripts, "macos_desktop_suite_lib.mjs"),
  worker: path.join(scripts, "keynote_macos_worker.applescript"),
  inventory: path.join(scripts, "inventory_interop.py"),
  evidenceLibrary: path.join(root, "scripts", "lib", "c19-interop-evidence.mjs"),
  suiteId: "keynote-macos",
  label: "Keynote macOS",
  application: "Apple Keynote",
  appBundle: "/Applications/Keynote.app",
  appExecutable: "/Applications/Keynote.app/Contents/MacOS/Keynote",
  nativeWorkingDocument: "keynote-working.key",
  emphasisTargetName: "surface-01-title",
  targetName: "surface-01-body",
  replacementText: "Native text edit verified in Keynote [C19].",
});
