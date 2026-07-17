---
name: slidewright
description: Compile ideas, outlines, or visual references into polished native editable PowerPoint decks with deterministic margins, symmetric padding, integer font sizes, text fitting, rich-text emphasis, native grouping, rendering, visual comparison, and OOXML verification. Use for creating, recreating, repairing, or auditing PowerPoint work where formatting integrity and continued editability matter.
---

# Slidewright

Build presentations as verified artifacts. Separate content reasoning from deterministic geometry, and fail visibly when a quality constraint cannot be met.

## Workflow

1. Define the communication job in one sentence: audience, intended outcome, and central takeaway.
2. Apply the public reliability requirements in [references/complaint-contract.md](references/complaint-contract.md). Run `node scripts/slidewright.mjs bootstrap` once in a fresh target workspace, then `node scripts/slidewright.mjs preflight --out <report>`. Stop on required capability failures. State optional unsupported paths before generation.
3. If following an existing deck, inspect the complete source and preserve its typography, palette, spacing, placeholders, footers, guides, logos, master/layout binding, and chrome. Read [references/design-profile.md](references/design-profile.md), [references/template-fidelity.md](references/template-fidelity.md), and [references/visual-fidelity.md](references/visual-fidelity.md). Use `scripts/slidewright.mjs profile <source.pptx> --out <profile.json>` for deterministic extraction, then `scripts/slidewright.mjs derive <profile.json> --intent <design-intent.json> --content <content-spec.json> --out <edit-plan.json>` for the verified clone-only path. General structural import remains unproven. If the only source is an image, follow [references/image-ingestion.md](references/image-ingestion.md): emit a vision-derived observation record, label font identity as a guess, and keep source geometry isolated from rendering and scoring.
4. Create a versioned deck specification. Read [references/deck-spec.md](references/deck-spec.md) and begin from `assets/demo-deck-spec.json` when useful.
5. For every prompt-originated release build, read [references/prompt-robustness.md](references/prompt-robustness.md), preserve the exact original prompt in a strict request envelope, and run `scripts/slidewright.mjs request <request.json> --out <guarded-run>`. This immutable entry point owns policy, compile, font audit, plan lint, render, realized-layout lint, plan-bound OOXML audit, delivery verification, and atomic publication. Then run `scripts/slidewright.mjs request-verify <guarded-run> --out <verification.json>`. Conflicting prompts must reject before a plan or deck is published. Use the individual commands below only for diagnostics or non-release development; they do not qualify a prompt-originated delivery.
6. To diagnose compilation independently, run `scripts/slidewright.mjs compile <spec> --out <plan>`.
   For a bounded follow-up change, use `scripts/slidewright.mjs iterate <plan> --manifest <edit> --out <updated-plan>` and follow [references/iteration.md](references/iteration.md). Never broaden the editor-derived change closure.
7. Audit requested fonts with `scripts/slidewright.mjs fonts <plan> --out <report>`. Stop on missing families; install the font or explicitly change the theme and recompile. Never accept silent substitution.
8. Lint the plan with `scripts/slidewright.mjs lint <plan> --out <report>`. Treat warnings as failures. Shorten copy or change layout before lowering minimum type sizes.
9. Render native editable objects with `scripts/slidewright.mjs render <plan> --out <deck.pptx> --preview-dir <dir>`. Use the bundled OpenAI presentation artifact runtime; never rasterize text. Rendering exports actual object bounds and line counts, runs the second lint phase, and refuses to save the PPTX if the realized layout violates the contract.
10. When groups are required, normalize the exported OOXML and verify real `p:grpSp` groups. Read [references/grouping.md](references/grouping.md).
11. If the user explicitly wants direct in-application editing and Windows PowerPoint is available, use the optional named-object adapter described in [references/powerpoint-adapter.md](references/powerpoint-adapter.md). Its absence must never disable generation.
12. Audit the final exported PPTX with `scripts/audit_pptx.py <deck.pptx> --json <report>`. Confirm native text, whole-point approved sizes, and rich-text runs. For exact reconstructions, run the object-level audit and visual comparison described in [references/visual-fidelity.md](references/visual-fidelity.md).
13. Inspect every rendered slide at full size. Fix all unintended overflow, clipping, wrapping, or overlap before delivery.
14. Create a montage from the rendered slides, then run `scripts/slidewright.mjs verify <deck.pptx> --out <manifest> --preview-dir <dir> --montage <image> --handoff <file> --require-bundle`. Report success only when the manifest confirms a nonempty PPTX ZIP with required package parts, at least one slide, matching per-slide previews, a montage, external-open instructions, a canonical path, and a content hash. For prompt-originated release work, the guarded request receipt remains additionally mandatory.

## Formatting contract

- Use equal outer margins and symmetric component padding unless the specification explicitly declares an intentional exception.
- Choose the largest fitting size from the approved integer point scale. Never emit fractional point sizes.
- Preserve text as native editable text and emphasis as independent runs.
- Use auto-sizing as a deterministic compile step; do not delegate uncontrolled fractional shrinking to PowerPoint.
- Keep every object inside the slide canvas and every single-line title on one line.
- Never allow visible text boxes to overlap. A generic overlap declaration cannot waive text-to-text separation.
- Extend headlines to the full safe width unless a declared center or two-thirds split reserves the adjacent region.
- Grow title/callout background regions with realized multi-line text height and symmetric padding, or relayout before export.
- Remove empty inherited paragraphs before bullet formatting or fitting; never emit blank bullets.
- Require explicit divider and substantive-slide coverage for every declared topic in long-form decks.
- Treat undeclared sibling overlap, child escape from padded parents, low contrast, declared alignment drift, excess wrapping, and crowded layouts as build failures.
- Reject content that cannot fit above the configured minimum and recommend shortening or a different layout.
- Use native charts, tables, shapes, and connectors when semantic editing matters. Rasterize only true visual assets.

## References

- Read [references/deck-spec.md](references/deck-spec.md) when authoring or validating input.
- Read [references/formatting-contract.md](references/formatting-contract.md) when changing layout or typography rules.
- Read [references/template-fidelity.md](references/template-fidelity.md) for any existing-deck or source-template task.
- Read [references/design-profile.md](references/design-profile.md) when extracting or reusing an existing deck's design system.
- Read [references/visual-fidelity.md](references/visual-fidelity.md) for reference reconstruction and comparison.
- Read [references/image-ingestion.md](references/image-ingestion.md) when reconstructing an opaque raster reference.
- Read [references/grouping.md](references/grouping.md) when objects must group or ungroup in PowerPoint.
- Read [references/iteration.md](references/iteration.md) for stale-safe named text, run, color, position, chart-component, or two-column-gap edits.
- Read [references/powerpoint-adapter.md](references/powerpoint-adapter.md) when direct Windows PowerPoint selection/edit/save is requested.
- Read [references/complaint-contract.md](references/complaint-contract.md) before capability preflight, delivery, or iteration.
- Read [references/prompt-robustness.md](references/prompt-robustness.md) for every prompt-originated release build.
