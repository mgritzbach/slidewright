# Reference-grounded deck generation

Slidewright can use an existing presentation as a design source for a new native editable deck. The reference deck is treated as evidence, not as a screenshot library and not as an unrestricted template-edit contract.

## Build contract

1. `profile` reads the complete native PowerPoint package, normalizes standard solid and gradient fills, records masters, layouts, guides, fonts, palette, recurring chrome, logos, and equal rim/limiter contracts, and inventories every viable source slide as a semantic design concept.
2. Each concept carries a reconstruction blueprint: named composition variant, semantic item count, normalized source-object geometry, native-object reconstructability, and exact minimum/maximum item topology where the composition requires it.
3. `request --reference-profile` compiles the requested content first, then selects only concepts whose communication model, semantic item topology, and exact native adapter fit the generated slide. Media, logo, Gantt, unknown-topology, and unsupported variants become explicit fallbacks rather than false reference-derived claims.
4. Reference tokens come from the theme inherited by the most slides in actual display order. Scheme colors, font roles, guides, master/layout chains, logo records, and recurring chrome remain provenance-bound. The source minor family is the one-family logical-master binding; the source major family remains recorded. Fallback is `null`, so an unavailable applied source font fails instead of silently substituting.
5. The adaptation reconstructs the selected topology with observable native editable text, shapes, tables, and charts. Visible text is never rasterized. Text must remain inside its declared backing object with symmetric padding and approved integer point sizes.
6. `design-provenance.json` binds every generated slide to the reference deck hash, profile hash, source slide, semantic concept, composition model and variant, source/generated item counts, exact adapter and observable object IDs, inheritance chain, adaptations, and confidence.
7. `request-verify` independently recomputes the tokens, structure, topology, adapter evidence, mapping aggregates, and validity, and rejects missing, stale, or tampered provenance.

## Release floors

- Standard DrawingML gradients must profile without aborting.
- Every viable reference slide must appear in the semantic inventory.
- At least 75% of substantive generated slides must be reference-derived.
- No more than two generated slides may use a generic fallback.
- Decks with at least six slides must use at least six distinct reference concepts.
- A topological variant must be reproduced as an observable native composition, not merely as a borrowed palette or border treatment.
- A table concept must declare a positive semantic column count. Zero is never treated as compatible with every generated table.
- The plan linter, font audit, rendered-layout lint, OOXML audit, executive-review specificity check, and delivery verifier must all pass.
- Review overlays are optional. When enabled, each yellow note must identify the exact object, diagnosis, executive impact, concrete revision, and reference provenance; duplicate sentences and note overflow are build failures.

## Honest boundary

The semantic inventory, topology checks, and native reconstruction make source choices traceable, reusable, and visually testable. For newly authored decks, Slidewright currently applies supported reference composition adapters plus source color and available minor-font tokens. Master/layout relationships, guides, logos, limiter/orientation lines, and recurring chrome are inventoried and bound into provenance, but are not yet transplanted into the new file. Use the clone-source edit path when those native source structures must be preserved today; do not describe provenance-only structures as applied inheritance.

These checks still do not prove that every human reviewer will recognize every selected concept. Final recognizability remains a manual acceptance test against the source slide, clean output, and `design-provenance.json` before a reference-grounded release is called complete.
