#!/usr/bin/env node
import { bootstrapArtifactWorkspace } from "../plugins/slidewright/skills/slidewright/scripts/lib/artifact-runtime.mjs";

try {
  const workspaceIndex = process.argv.indexOf("--workspace");
  const workspace = workspaceIndex >= 0 ? process.argv[workspaceIndex + 1] : process.cwd();
  if (!workspace) throw new Error("--workspace requires a path.");
  const report = await bootstrapArtifactWorkspace({ cwd: workspace });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write([
      `Linked ${report.source} ${report.artifactToolVersion} into ${report.cwd}`,
      `Host profile: ${report.hostProfile}; downloaded: ${report.downloaded}; renderer switched: ${report.rendererSwitched}`,
      "",
    ].join("\n"));
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
