# Fine-grained named iteration

Use named iteration only on a compiled Slidewright plan with unique stable object IDs. A `c16-v1` manifest has this shape:

```json
{
  "version": "c16-v1",
  "id": "short-edit-id",
  "baselinePlanHash": "full-plan-content-sha256",
  "edit": {
    "type": "bold",
    "targetId": "s1-title",
    "runIndex": 0,
    "value": true
  }
}
```

Run `scripts/slidewright.mjs iterate <plan.json> --manifest <edit.json> --out <updated-plan.json>`. The command rejects stale baseline hashes, missing or duplicate targets, invalid runs and values, no-ops, inventory changes, and collateral object changes. The editor derives the exact changed-object closure; ignore any caller-supplied allowlist.

Version 1 supports single-run text replacement, run-level bold, text or fill color, bounded position fields, semantic native-shape chart values with their marks, and the gap of a named two-column layout. It does not claim arbitrary layout restructuring or native Office `c:chart` mutation.

After every edit, run font audit, zero-warning lint, render, OOXML audit, and localized render comparison. The named editor itself rejects an invalid post-edit plan, including a repeated `Label — explanation` item whose body inherits the label's emphasis. Untouched named objects must retain their hashes, untouched pixels must be exact, and release fixtures must survive PowerPoint save and reopen.

The PPTX stores canonical chart-component metadata in native shape descriptions so data values remain reconstructable without the external plan. Treat a missing, stale, or hash-invalid payload as a build failure.
