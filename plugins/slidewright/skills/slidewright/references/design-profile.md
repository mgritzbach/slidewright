# Existing-deck design profiles

Use this path when a user supplies a native `.pptx` whose design system should be reused without silently restyling it.

## Verified workflow

1. Extract a deterministic raw OOXML profile:

   ```powershell
   node scripts/slidewright.mjs profile <source.pptx> --out <profile.json>
   ```

2. Inspect the profile and source deck. Confirm the requested editable placeholder names, slide archetype, logo groups, guides, master/layout association, palette, fonts, type scale, and rim/limiter pairs. Never infer permission to replace or remove undeclared objects.
3. Write a content specification whose replacements include exact `shapeName`, `before`, and `after` values, plus a design-intent file that declares the expected editable placeholders and approved integer font sizes.
4. Compile the source-bound edit plan:

   ```powershell
   node scripts/slidewright.mjs derive <profile.json> --intent <design-intent.json> --content <content-spec.json> --out <edit-plan.json>
   ```

5. Apply the plan to a copy of the source deck. The `g22-v1` policy is `clone-source-deck`, preserves undeclared objects, and rejects arbitrary import.
6. Re-extract and audit the result. Compare exact EMU geometry, themes, relationships, masters/layouts, guides, logos, recurring chrome, and symmetry contracts. Treat warnings or undeclared drift as failure.
7. Save and reopen in Microsoft PowerPoint when available, render every slide, and inspect each render at full size.

## Symmetry contract

Paired left/right or top/bottom rims and limiting lines must have exactly equal thickness, opposite-edge offsets, colors, and line styles unless a source-bound asymmetry declaration names the pair and explains the exception. Equality is checked in EMUs; rounded display values are not authoritative. An intentionally one-sided accent is preserved as source chrome but does not weaken equality requirements for paired rims or limiters.

## Proof boundary

This path reuses a source deck by cloning it and changing only declared native placeholder text. It is not a general PPTX importer and does not currently reconstruct arbitrary charts, tables, SmartArt, notes, media, or new layouts from the extracted profile. Keep those limitations explicit.