---
name: slidewright
description: Compile ideas, outlines, or visual references into polished native editable PowerPoint decks with deterministic margins, symmetric padding, integer font sizes, text fitting, rich-text emphasis, native grouping, rendering, visual comparison, and OOXML verification. Use for creating, recreating, repairing, or auditing PowerPoint work where formatting integrity and continued editability matter.
---

# Slidewright

Build presentations as verified artifacts. Separate content reasoning from deterministic geometry, and fail visibly when a quality constraint cannot be met.

## Workflow

1. Define the communication job in one sentence: audience, intended outcome, and central takeaway.
2. Apply the public reliability requirements in [references/complaint-contract.md](references/complaint-contract.md). Run `node scripts/slidewright.mjs bootstrap` once in a fresh target workspace, then `node scripts/slidewright.mjs preflight --out <report>`. Stop on required capability failures. State optional unsupported paths before generation.
3. If following an existing deck, inspect the complete source and preserve its typography, palette, spacing, placeholders, footers, and chrome. Read [references/template-fidelity.md](references/template-fidelity.md) and [references/visual-fidelity.md](references/visual-fidelity.md). The verified template path is limited to declared text edits in uniquely named native placeholders; general existing-deck import and structural editing are not proven. If the only source is an image, follow [references/image-ingestion.md](references/image-ingestion.md): emit a vision-derived observation record, label font identity as a guess, and keep source geometry isolated from rendering and scoring.
4. Create a versioned deck specification. Read [references/deck-spec.md](references/deck-spec.md) and begin from `assets/demo-deck-spec.json` when useful.
5. Compile the specification with `scripts/slidewright.mjs compile <spec> --out <plan>`.
   For a bounded follow-up change, use `scripts/slidewright.mjs iterate <plan> --manifest <edit> --out <updated-plan>` and follow [references/iteration.md](references/iteration.md). Never broaden the editor-derived change closure.
6. Audit requested fonts with `scripts/slidewright.mjs fonts <plan> --out <report>`. Stop on missing families; install the font or explicitly change the theme and recompile. Never accept silent substitution.
7. Lint the plan with `scripts/slidewright.mjs lint <plan> --out <report>`. Treat warnings as failures. Shorten copy or change layout before lowering minimum type sizes.
8. Render native editable objects with `scripts/slidewright.mjs render <plan> --out <deck.pptx> --preview-dir <dir>`. Use the bundled OpenAI presentation artifact runtime; never rasterize text. Rendering exports actual object bounds and line counts, runs the second lint phase, and refuses to save the PPTX if the realized layout violates the contract.
9. When groups are required, normalize the exported OOXML and verify real `p:grpSp` groups. Read [references/grouping.md](references/grouping.md).
10. If the user explicitly wants direct in-application editing and Windows PowerPoint is available, use the optional named-object adapter described in [references/powerpoint-adapter.md](references/powerpoint-adapter.md). Its absence must never disable generation.
11. Audit the final exported PPTX with `scripts/audit_pptx.py <deck.pptx> --json <report>`. Confirm native text, whole-point approved sizes, and rich-text runs. For exact reconstructions, run the object-level audit and visual comparison described in [references/visual-fidelity.md](references/visual-fidelity.md).
12. Inspect every rendered slide at full size. Fix all unintended overflow, clipping, wrapping, or overlap before delivery.
13. Create a montage from the rendered slides, then run `scripts/slidewright.mjs verify <deck.pptx> --out <manifest> --preview-dir <dir> --montage <image> --handoff <file> --require-bundle`. Report success only when the manifest confirms a nonempty PPTX ZIP with required package parts, at least one slide, matching per-slide previews, a montage, external-open instructions, a canonical path, and a content hash.

## Formatting contract

- Use equal outer margins and symmetric component padding unless the specification explicitly declares an intentional exception.
- Choose the largest fitting size from the approved integer point scale. Never emit fractional point sizes.
- Preserve text as native editable text and emphasis as independent runs.
- Use auto-sizing as a deterministic compile step; do not delegate uncontrolled fractional shrinking to PowerPoint.
- Keep every object inside the slide canvas and every single-line title on one line.
- Treat undeclared sibling overlap, child escape from padded parents, low contrast, declared alignment drift, excess wrapping, and crowded layouts as build failures.
- Reject content that cannot fit above the configured minimum and recommend shortening or a different layout.
- Use native charts, tables, shapes, and connectors when semantic editing matters. Rasterize only true visual assets.

## References

- Read [references/deck-spec.md](references/deck-spec.md) when authoring or validating input.
- Read [references/formatting-contract.md](references/formatting-contract.md) when changing layout or typography rules.
- Read [references/template-fidelity.md](references/template-fidelity.md) for any existing-deck or source-template task.
- Read [references/visual-fidelity.md](references/visual-fidelity.md) for reference reconstruction and comparison.
- Read [references/image-ingestion.md](references/image-ingestion.md) when reconstructing an opaque raster reference.
- Read [references/grouping.md](references/grouping.md) when objects must group or ungroup in PowerPoint.
- Read [references/iteration.md](references/iteration.md) for stale-safe named text, run, color, position, chart-component, or two-column-gap edits.
- Read [references/powerpoint-adapter.md](references/powerpoint-adapter.md) when direct Windows PowerPoint selection/edit/save is requested.
- Read [references/complaint-contract.md](references/complaint-contract.md) before capability preflight, delivery, or iteration.
