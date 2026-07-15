# Optional direct PowerPoint adapter

Use this fallback only when the user explicitly wants Microsoft PowerPoint itself to select or modify native objects. It is optional, Windows-only, and must not become a generation dependency.

Resolve the installed Slidewright skill directory, then run the self-contained adapter with explicit paths and stable object names:

```powershell
$skillRoot = "<path-to-installed-slidewright-skill>"
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $skillRoot "scripts/powerpoint-edit-adapter.ps1") `
  -InputPptx <input.pptx> `
  -OutputPptx <edited.pptx> `
  -ReportJson <adapter-report.json> `
  -GroupName <native-group-name> `
  -TargetName <native-text-shape-name> `
  -ReplacementText <new-text>
```

The adapter must verify one active named-shape selection, retain native text and bold formatting after save/reopen, preserve the native group name and exact sorted member-name set through ungroup/regroup, and emit distinct input/output SHA-256 hashes. Render and inspect the edited deck after the command.

If PowerPoint is absent or the platform is not Windows, report the adapter as unavailable and continue with the normal compile/lint/render/audit workflow. Never silently substitute computer-use automation or disable generation.
