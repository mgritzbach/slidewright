---
name: slidewright
description: Compile ideas, outlines, or visual references into polished native editable PowerPoint decks with deterministic margins, symmetric padding, integer font sizes, text fitting, rich-text emphasis, native grouping, rendering, visual comparison, and OOXML verification. Use for creating, recreating, repairing, or auditing PowerPoint work where formatting integrity and continued editability matter.
---

# Slidewright

Build presentations as verified artifacts. Separate content reasoning from deterministic geometry, and fail visibly when a quality constraint cannot be met.

## Workflow

1. Define the communication job in one sentence: audience, intended outcome, and central takeaway.
2. Apply the public reliability requirements in [references/complaint-contract.md](references/complaint-contract.md). Run `node scripts/slidewright.mjs bootstrap` once in a fresh target workspace, then `node scripts/slidewright.mjs preflight --out <report>`. Stop on required capability failures. State optional unsupported paths before generation.
3. If following an existing deck, inspect the complete source and preserve its typography, palette, spacing, placeholders, footers, guides, logos, master/layout binding, and chrome. Read [references/design-profile.md](references/design-profile.md), [references/template-fidelity.md](references/template-fidelity.md), [references/structural-ingestion.md](references/structural-ingestion.md), and [references/visual-fidelity.md](references/visual-fidelity.md). Use `scripts/slidewright.mjs profile <source.pptx> --out <profile.json>` for deterministic design extraction, or the structural importer when a native PPTX must cross the workflow boundary without losing its slide/layout/master/theme hierarchy, text runs, tables, charts, diagrams, notes, or reading order. Structural ingestion is lossless preservation, not permission for arbitrary edits to imported objects. If the only source is an image, follow [references/image-ingestion.md](references/image-ingestion.md): emit a vision-derived observation record, label font identity as a guess, and keep source geometry isolated from rendering and scoring.
4. Create a versioned deck specification. Read [references/deck-spec.md](references/deck-spec.md) and begin from `assets/demo-deck-spec.json` when useful. Resolve one logical design master, declared page archetypes, typography roles, inset tokens, paragraph-spacing tokens, and allowed variants before compiling individual slides.
5. For every prompt-originated release build, read [references/prompt-robustness.md](references/prompt-robustness.md) and [references/copy-resilience.md](references/copy-resilience.md), preserve the exact original prompt in a strict request envelope, and run `scripts/slidewright.mjs request <request.json> --out <guarded-run>`. This immutable entry point owns policy, adaptive copy relayout, compile, font audit, plan lint, render, realized-layout lint, plan-bound OOXML audit, optional executive review, delivery verification, and atomic publication. Then run `scripts/slidewright.mjs request-verify <guarded-run> --out <verification.json>`. Conflicting prompts must reject before a plan or deck is published. Use the individual commands below only for diagnostics or non-release development; they do not qualify a prompt-originated delivery.
6. If the user requests partner, executive, McKinsey-style, Harvard-style, or manual-review annotations, read [references/executive-review.md](references/executive-review.md), set `reviewMode` to `executive-overlay`, and deliver both the clean canonical deck and the separate annotated review copy. Otherwise keep E6 off.
7. To diagnose compilation independently, run `scripts/slidewright.mjs adapt <spec> --out <adapted-spec> --manifest <adaptation>` before `scripts/slidewright.mjs compile <adapted-spec> --out <plan>`. Preserve every normalized source word token exactly once and in order with its bold, italic, color, bullet, and level state; allow whitespace and source run boundaries to normalize at continuation breaks. Create native continuation slides before any type falls below its role minimum.
   For a bounded follow-up change, use `scripts/slidewright.mjs iterate <plan> --manifest <edit> --out <updated-plan>` and follow [references/iteration.md](references/iteration.md). Never broaden the editor-derived change closure.
8. Audit requested fonts with `scripts/slidewright.mjs fonts <plan> --out <report>`. Stop on missing families; install the font or explicitly change the theme and recompile. Never accept silent substitution.
9. Lint the plan with `scripts/slidewright.mjs lint <plan> --out <report>`. Treat warnings as failures. Shorten copy or change layout before lowering minimum type sizes.
10. Render native editable objects with `scripts/slidewright.mjs render <plan> --out <deck.pptx> --preview-dir <dir>`. Use the bundled OpenAI presentation artifact runtime; never rasterize text. Rendering exports actual object bounds and line counts, runs the second lint phase, and refuses to save the PPTX if the realized layout violates the contract.
11. When groups are required, normalize the exported OOXML and verify real `p:grpSp` groups. Read [references/grouping.md](references/grouping.md).
12. If the user explicitly wants direct in-application editing and Windows PowerPoint is available, use the optional named-object adapter described in [references/powerpoint-adapter.md](references/powerpoint-adapter.md). Its absence must never disable generation.
13. Audit the final exported PPTX with `scripts/audit_pptx.py <deck.pptx> --json <report>`. Confirm native text, whole-point approved sizes, and rich-text runs. For exact reconstructions, run the object-level audit and visual comparison described in [references/visual-fidelity.md](references/visual-fidelity.md).
14. For release qualification on Windows with Microsoft PowerPoint, run the repository-level `npm run repair-free` and `npm run repair-free:verify` gate. It freshly regenerates and snapshots 26 byte-unique fixtures; requires pre/post OPC, pinned Open XML SDK, native formatting-state, armed watcher, exact ownership/exit, and semantic validation; independently reruns those audits; and rejects every destructive control before atomically advancing release evidence. `repair-free:reuse` is development-only and never qualifies. A successful COM open alone never qualifies.
15. Inspect every rendered slide at full size. Fix all unintended overflow, clipping, wrapping, or overlap before delivery.
16. Create a montage from the rendered slides, then run `scripts/slidewright.mjs verify <deck.pptx> --out <manifest> --preview-dir <dir> --montage <image> --handoff <file> --require-bundle`. Report success only when the manifest confirms a nonempty PPTX ZIP with required package parts, at least one slide, matching per-slide previews, a montage, external-open instructions, a canonical path, and a content hash. For prompt-originated release work, the guarded request receipt remains additionally mandatory.

## Formatting contract

- Use equal outer margins and symmetric component padding unless the specification explicitly declares an intentional exception.
- Choose the largest fitting size from the approved integer point scale. Never emit fractional point sizes.
- Preserve text as native editable text and emphasis as independent runs.
- Use auto-sizing as a deterministic compile step; do not delegate uncontrolled fractional shrinking to PowerPoint.
- Keep every object inside the slide canvas and every single-line title on one line.
- Never allow visible text boxes to overlap. A generic overlap declaration cannot waive text-to-text separation.
- Extend headlines to the full safe width unless a declared center or two-thirds split reserves the adjacent region.
- Grow title/callout background regions with realized multi-line text height and symmetric padding, or relayout before export.
- Use one compact token on all four sides of text boxes and table cells; reject random one-side margins.
- Keep every text box strictly inside its declared backing block and preserve equivalent headline/body roles across repeated components.
- Bind non-decorative icons to the exact label and a declared semantic concept; reject unrelated icon choices.
- Keep constrained headlines within their archetype line/auto-size budget and use native paragraph spacing from the deck's `0/6/12 pt` scale.
- Remove empty inherited paragraphs before bullet formatting or fitting; never emit blank bullets.
- Require explicit divider and substantive-slide coverage for every declared topic in long-form decks.
- Treat undeclared sibling overlap, child escape from padded parents, low contrast, declared alignment drift, excess wrapping, and crowded layouts as build failures.
- Split dense flexible copy into balanced native continuation slides before rejecting; if non-splittable text or the slide ceiling still cannot close above the configured minimum, recommend shortening or a different layout.
- Use native charts, tables, shapes, and connectors when semantic editing matters. Rasterize only true visual assets.

## References

- Read [references/deck-spec.md](references/deck-spec.md) when authoring or validating input.
- Read [references/formatting-contract.md](references/formatting-contract.md) when changing layout or typography rules.
- Read [references/template-fidelity.md](references/template-fidelity.md) for any existing-deck or source-template task.
- Read [references/structural-ingestion.md](references/structural-ingestion.md) when an existing PPTX must be imported without flattening or semantic loss.
- Read [references/design-profile.md](references/design-profile.md) when extracting or reusing an existing deck's design system.
- Read [references/visual-fidelity.md](references/visual-fidelity.md) for reference reconstruction and comparison.
- Read [references/image-ingestion.md](references/image-ingestion.md) when reconstructing an opaque raster reference.
- Read [references/grouping.md](references/grouping.md) when objects must group or ungroup in PowerPoint.
- Read [references/iteration.md](references/iteration.md) for stale-safe named text, run, color, position, chart-component, or two-column-gap edits.
- Read [references/powerpoint-adapter.md](references/powerpoint-adapter.md) when direct Windows PowerPoint selection/edit/save is requested.
- Read [references/complaint-contract.md](references/complaint-contract.md) before capability preflight, delivery, or iteration.
- Read [references/prompt-robustness.md](references/prompt-robustness.md) for every prompt-originated release build.
- Read [references/copy-resilience.md](references/copy-resilience.md) for translated, expanded, or dense copy and continuation-slide evidence.
- Run the repository-level `npm run universal-design` gate after changing masters, archetypes, typography roles, insets, paragraph spacing, tables, icons, or containment behavior.
