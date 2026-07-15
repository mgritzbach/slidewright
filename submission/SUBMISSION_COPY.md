# Build Week submission copy

## Project

**Name:** Slidewright

**Category:** Work & Productivity

**Tagline:** Editable PowerPoint, engineered rather than approximated.

## Short description

Slidewright is a Codex plugin and skill that turns ideas, visual references, and controlled template edits into native editable PowerPoint, then proves the formatting survived with deterministic compilation, rendering, structural audits, visual comparisons, and adversarial controls.

## Long description

AI can make a plausible slide screenshot in seconds. Knowledge workers still lose time repairing the actual PowerPoint: uneven margins, clipped copy, fractional type sizes, flattened visuals, silent font substitution, and templates that drift after one edit.

Slidewright treats presentation generation like a build pipeline. Codex translates the communication job into a semantic specification or a vision-derived observation record. A deterministic compiler maps that structure onto explicit margins, grids, spacing, and typography budgets. Its autosizer chooses the largest conventional whole-point size that fits. The renderer creates native PowerPoint text, shapes, rich-text runs, editable bar graphics, timelines, and groups. The release pipeline then lints geometry, blocks missing fonts and over-dense copy, renders every slide, audits the OOXML, compares pixels and object properties, and verifies the delivery bundle.

The independent opaque-image benchmark reconstructs an original invitation as 13 native text objects and 10 native shapes with zero pictures or embedded source raster. It scores 0.95102 global similarity, 0.93510 foreground similarity, 0.89922 background-normalized similarity, and 0.79492 edge F1. A text-erased adversarial control retains strong flat-color scores but fails the edge gate, proving the metric cannot be gamed by deleting the words.

The template benchmark makes exact copy edits in two named native placeholders while preserving every other byte outside the authorized slide part. A full-slide allowlist audit, five tamper controls, and a real PowerPoint `SaveAs`/reopen/render round trip prove that the master, 11 layouts, theme, relationships, footer, slide number, and preserve-only slide survive. This is deliberately claimed as a narrow copy-edit path, not general PPTX import.

Slidewright makes the editable artifact—not the screenshot—the product.

## What is technically non-trivial

- deterministic semantic-spec-to-layout compilation and discrete whole-point text fitting;
- native editable text, mixed emphasis, shapes, graphics, and PowerPoint groups;
- anti-circular image ingestion with quarantined source geometry;
- exact object-level formatting and OOXML package audits;
- missing-font and dense-copy fail-safe behavior;
- surgical source-template edits with whole-slide allowlisting;
- real PowerPoint group and template serialization round trips;
- adversarial controls and one-command evidence generation.

## How Codex contributed

Codex was the engineering environment and implementation collaborator: it researched the submission constraints and public PowerPoint complaints, scaffolded the plugin and skill, implemented the compiler, renderer, auditors, benchmarks, and negative controls, ran PowerPoint and browser QA, inspected every release render, and coordinated independent design, PowerPoint, product, and release reviews. Human decisions set the product thesis and non-negotiable quality bar: native editability, symmetric geometry, conventional typography, honest proof boundaries, and binary evidence before a goal can move to complete.

## Verified model and build session

GPT-5.6 usage: `[[GPT56_USAGE_STATEMENT]]`

Primary Codex `/feedback` session ID: `[[FEEDBACK_SESSION_ID]]`

The full submission checker rejects these tokens. Replace them only with the verified values recorded in `metadata.json`.
