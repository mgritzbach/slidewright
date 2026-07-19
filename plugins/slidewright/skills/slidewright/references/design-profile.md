# Existing-deck design profiles

Use this path when a user supplies a native `.pptx` whose design system should be reused without silently restyling it.

## Verified workflow

1. Extract a deterministic raw OOXML profile:

   ```powershell
   node scripts/slidewright.mjs profile <source.pptx> --out <profile.json>
   ```

2. Inspect the profile and source deck. Confirm the requested editable placeholder names, slide archetype, logo groups, guides, master/layout association, palette, fonts, type scale, and rim/limiter pairs. Also inspect `designConceptInventory`: every viable source slide must state its communication purpose, composition model and variant, semantic item count, normalized regions, source-object blueprint, native reconstructability, spatial relationships, density, suitability constraints, and exact source slide number. Standard `a:gradFill` is normalized with stops, positions, color transforms/transparency, and linear/path geometry. A gradient that cannot yet be reconstructed emits a fidelity warning and does not abort the deck inventory. Never infer permission to replace or remove undeclared objects.
3. Write a content specification whose replacements include exact `shapeName`, `before`, and `after` values, plus a design-intent file that declares the expected editable placeholders and approved integer font sizes.
4. Compile the source-bound edit plan:

   ```powershell
   node scripts/slidewright.mjs derive <profile.json> --intent <design-intent.json> --content <content-spec.json> --out <edit-plan.json>
   ```

5. Apply the plan to a copy of the source deck. The `g22-v1` policy is `clone-source-deck`, preserves undeclared objects, and rejects arbitrary import.
6. Re-extract and audit the result. Compare exact EMU geometry, themes, relationships, masters/layouts, guides, logos, recurring chrome, and symmetry contracts. Treat warnings or undeclared drift as failure.
7. Save and reopen in Microsoft PowerPoint when available, render every slide, and inspect each render at full size.

## New-deck reference grounding

For a new deck that should visibly reuse a rich reference library, invoke the guarded request with the extracted profile:

```powershell
node scripts/slidewright.mjs request <request.json> --reference-profile <profile.json> --out <guarded-run>
node scripts/slidewright.mjs request-verify <guarded-run> --out <verification.json>
```

The compile stage resolves the dominant theme through actual display-order inheritance, binds source color and font roles, matches each generated slide to a viable source concept, rejects zero or incompatible item topologies, and reconstructs only composition variants with an exact native editable adapter. Unsupported variants become explicit fallbacks. `design-provenance.json` records source and generated item counts, exact adapter and observable editable object IDs, inheritance, tokens, structure, and blueprint object count. The source minor font is applied as the generated logical master's single family; the source major font remains recorded, fallback is `null`, and no unrelated installed face may be substituted silently. The run fails if fewer than 75% of substantive slides are grounded, more than two slides fall back, or fewer than six distinct concepts are used when six or more output slides exist. E6 comments must identify the exact target object, diagnose the actual decision relationship, explain the executive consequence, recommend a concrete revision, and cite the selected source concept when available.

## Symmetry contract

Paired left/right or top/bottom rims and limiting lines must have exactly equal thickness, opposite-edge offsets, colors, and line styles unless a source-bound asymmetry declaration names the pair and explains the exception. Equality is checked in EMUs; rounded display values are not authoritative. An intentionally one-sided accent is preserved as source chrome but does not weaken equality requirements for paired rims or limiters.

## Proof boundary

The copy-only derivation path still clones a source deck and changes only declared native placeholder text. The new-deck grounding path reuses semantic composition concepts and source color/minor-font tokens through Slidewright's proven native archetypes; it does not currently transplant the source master/layout package, guides, logos, limiter lines, or recurring chrome into a newly authored deck. Those structures are provenance-only until an explicit, rights-aware native application mode and PowerPoint round-trip evidence exist. It also does not losslessly import arbitrary SmartArt, notes, video, animation, or every third-party object type. It must disclose fidelity warnings and provenance rather than claiming unrestricted structural import.
