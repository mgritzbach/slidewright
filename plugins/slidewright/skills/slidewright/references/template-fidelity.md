# Template fidelity

For an existing deck or user-provided template:

1. Preserve the input file and export a distinct edited copy unless the user requests in-place editing.
2. Inspect every source slide, layout, placeholder, theme, footer, page marker, and recurring chrome.
3. Extract the source type scale, fonts, colors, margins, padding patterns, and media frames.
4. Map each requested output slide to a source layout before editing.
5. Edit inherited objects instead of rebuilding parallel approximations.
6. Log every intentional deviation with the source slide, target object, reason, and user instruction.
7. Reject content that no source layout can hold without violating the template; offer the closest viable source layouts.
8. Render and compare every edited slide at full size, then run the structural audit.

Never mix the source design with another template or silently restyle the deck.

## Verified narrow edit path

For copy-only changes to existing native placeholders, use the surgical editor rather than importing and rebuilding the deck:

```powershell
python scripts/template/edit_template.py <source.pptx> <edit-plan.json> <edited.pptx> --json <edit-report.json>
python scripts/template/audit_template_preservation.py <source.pptx> <edited.pptx> <edit-plan.json> --json <audit.json> --source-manifest <source-parts.json> --edited-manifest <edited-parts.json>
```

The edit plan must pin the source SHA-256 and, for every edit, the slide number, unique shape name, placeholder type/index, exact before text, and exact after text. The editor preserves the paragraph and run structure and changes only the matching `a:t` values. The audit must show that only the declared slide part changed, all relationship tuples are identical, protected master/layout/theme parts are byte-identical, preserved slides are byte-identical, and the target remains native text.

The repository's `npm run template` benchmark adds source-versus-edit render comparison, a real PowerPoint save/reopen round trip, exact round-trip render comparison, full-size review, and destructive negative controls. Do not use this narrow proof to claim arbitrary slide insertion, object movement, layout changes, or general structural PPTX ingestion.
