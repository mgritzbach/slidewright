import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../plugins/slidewright/skills/slidewright/scripts/semantic_surface/presentation_path_identity.ps1", import.meta.url));

test("PowerPoint OneDrive URLs resolve only to an exact confined allowlisted local path", (context) => {
  if (process.platform !== "win32" || !process.env.OneDrive) return context.skip("Windows OneDrive identity control");
  const allowed = path.join(process.env.OneDrive, "Slidewright identity", "deck.pptx");
  const relative = "Slidewright identity/deck.pptx";
  const cases = {
    positive: `https://d.docs.live.net/0123456789abcdef/${relative}`,
    traversal: "https://d.docs.live.net/0123456789abcdef/%2e%2e/secret.pptx",
    encodedSeparator: "https://d.docs.live.net/0123456789abcdef/%2e%2e%5csecret.pptx",
    foreignHost: `https://example.com/0123456789abcdef/${relative}`,
  };
  const escapedHelper = helper.replaceAll("'", "''");
  const escapedAllowed = allowed.replaceAll("'", "''");
  const encodedCases = JSON.stringify(cases).replaceAll("'", "''");
  const command = `. '${escapedHelper}';$c='${encodedCases}'|ConvertFrom-Json;[ordered]@{positive=Get-NormalizedPresentationPath $c.positive @('${escapedAllowed}');notAllowed=Get-NormalizedPresentationPath $c.positive @('C:\\not-allowed.pptx');traversal=Get-NormalizedPresentationPath $c.traversal @('${escapedAllowed}');encodedSeparator=Get-NormalizedPresentationPath $c.encodedSeparator @('${escapedAllowed}');foreignHost=Get-NormalizedPresentationPath $c.foreignHost @('${escapedAllowed}')}|ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.positive, allowed);
  assert.equal(output.notAllowed, null);
  assert.equal(output.traversal, null);
  assert.equal(output.encodedSeparator, null);
  assert.equal(output.foreignHost, null);
});
