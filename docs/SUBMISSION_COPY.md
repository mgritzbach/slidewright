# Draft Build Week submission copy

## Name

Slidewright

## Tagline

Editable PowerPoint, engineered rather than approximated.

## Short description

Slidewright is a Codex plugin that compiles ideas and source material into native editable PowerPoint decks, then proves the formatting survived with deterministic linting, rendering, and OOXML audits.

## Long description

AI can generate a plausible slide in seconds, but knowledge workers still lose time repairing the actual PowerPoint: uneven margins, clipped copy, arbitrary fractional type sizes, flattened visuals, and formatting that breaks after one edit.

Slidewright treats presentation generation as a build pipeline. Codex translates the communication job and content hierarchy into a semantic deck specification. A deterministic compiler maps that specification onto explicit margins, grids, spacing, and typography budgets. The autosizer selects the largest conventional integer point size that fits instead of allowing uncontrolled shrinking. The renderer creates native PowerPoint text and shapes, including independently editable bold and regular runs. Finally, Slidewright lints the layout, renders every slide, and audits the exported OOXML.

The current demo produces a three-slide editable deck with zero lint warnings, zero overflow, 18 native text nodes, mixed bold/regular paragraphs, and no fractional or off-scale font sizes. When content cannot meet the quality floor, the build fails with an actionable recommendation instead of silently producing tiny text.

Slidewright makes the editable artifact—not the screenshot—the product.

## What is technically non-trivial

- deterministic semantic-spec-to-layout compilation;
- constrained text measurement and discrete type-scale fitting;
- stable rule IDs and actionable negative diagnostics;
- native PowerPoint rich-text rendering;
- structural post-export OOXML verification;
- clean-copy, one-command judge execution.

## How Codex and GPT-5.6 were used

Codex researched requirements, scaffolded the plugin/skill, implemented the build pipeline and tests, executed artifact-level QA, and supported the product narrative. Before submission, replace this paragraph with the exact GPT-5.6 usage from the release sessions and attach the primary `/feedback` session ID. Do not claim a model or session that was not verified.

## Testing instructions

1. Open the repository in Codex with Node.js 20+ and Python 3.11+ available.
2. Run `npm run demo`.
3. Open `outputs/demo/slidewright-demo.pptx` in PowerPoint.
4. Edit the title on slide 1 and toggle the emphasized phrase between bold and regular.
5. Inspect `outputs/demo/lint-report.json`, the rendered previews, and `outputs/demo/ooxml-audit.json`.

Expected result: the build passes, all text remains editable, and the audit reports only approved whole-point font sizes plus mixed bold/regular runs.
