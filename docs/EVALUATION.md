# Evaluation strategy

## Competition scorecard

| Criterion | Product evidence |
| --- | --- |
| Technological implementation | Constraint compiler, deterministic autosizing, stable lint rules, native renderer, OOXML audit, test fixtures |
| Design | One-command workflow, actionable diagnostics, polished editable demo deck, coherent plugin onboarding |
| Potential impact | Measured reduction in formatting defects and cleanup time for real knowledge workers |
| Quality of idea | Formatting-as-code contract and evidence bundle, rather than another slide-image generator |

## Automated evaluation set

Create at least 20 deck specifications spanning:

- short and long titles;
- body copy at fit boundaries;
- mixed bold/regular/italic runs;
- symmetric and intentionally asymmetric layouts;
- empty, invalid, and over-dense content;
- two font families and three themes;
- the current named-placeholder golden-template fixture plus additional complex imported-template fixtures as that path expands.

Each fixture records expected compile status, selected type sizes, diagnostic IDs, and structural properties of the exported PPTX.

## Metrics

- **Fit accuracy:** compiler prediction agrees with rendered outcome.
- **Typography compliance:** whole-point sizes from the approved scale / all text sizes.
- **Editability rate:** native editable text objects / visible text objects.
- **Defect escape rate:** visual defects found after lint / slides built.
- **Determinism:** plan hash stability across repeated runs.
- **Repair time:** minutes needed to make the exported deck presentation-ready.

## Human evaluation

Ask 5–8 target users to complete the same task with their current workflow and Slidewright. Blind-review both outputs for hierarchy, spacing, readability, and ease of editing. Measure time to first acceptable deck and repair actions after changing one sentence per slide.

## Release gates

- Unit and negative-fixture tests pass.
- Three repeated compiles produce identical plan files.
- Lint returns zero warnings and errors for the demo.
- OOXML audit proves native text, approved sizes, and mixed emphasis.
- Every slide passes full-size visual review.
- Fresh judge setup completes in under five minutes.
