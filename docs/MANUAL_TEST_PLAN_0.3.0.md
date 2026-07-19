# Slidewright 0.3.0 manual acceptance test

Use a fresh Codex task for each scenario. Start the prompt with `$slidewright` and attach the named inputs. Open every delivered `.pptx` in Microsoft PowerPoint; do not score a preview image alone.

## Pass threshold

The release is suitable for sharing when all five scenarios pass, no scenario has a blocking formatting defect, every edited file survives save/close/reopen, and median manual cleanup time is at most five minutes. Record defects even when they are easy to repair.

## Scenario 1 — prompt to new executive deck

Ask for an 8–10 slide horizontal executive presentation from a one-page brief. Require a title slide, storyline, comparison, process, native table, horizontal chart, vertical chart, and conclusion.

Check:

- First-open acceptance: would you present it after content review only?
- No text overlaps another text box or escapes its covering block.
- Outer margins and repeated component padding are symmetric.
- Headlines use available width and remain concise when space is constrained.
- Similar headline/body patterns use the same font, size, emphasis, and spacing.
- Font sizes are conventional whole points; paragraph spacing normally uses 12, 6, or 0 points.
- Tables, charts, connectors, groups, and text remain native and editable.

## Scenario 2 — rich reference deck reuse

Attach a presentation with at least 20 visually distinct slides and ask for a new 8–12 slide deck on unrelated content. Explicitly request reuse of the reference design language and composition ideas.

Check:

- Recognizable reference compositions appear throughout the new deck, not only its colors.
- Supported composition patterns, palette, gradients, available minor-font tokens, and spacing are reused when technically and legally available.
- Any unavailable font or unsupported source construct is reported explicitly; no silent substitution is accepted.
- Open `design-provenance.json`: each substantive slide identifies a source slide, concept, composition variant, adaptation, confidence, and item topology.
- The output is still a new presentation; source text is not copied accidentally.

Known open goal: in new-deck mode, master/layout relationships, guides, logos, limiter/orientation lines, and recurring chrome are inventoried but not yet transplanted. Test those today with the clone-source edit path, and record any expectation for automatic new-deck inheritance separately against G22.

## Scenario 3 — E6 executive review on and off

Build the same deck twice: once with executive review off and once with `reviewMode: executive-overlay`.

Check:

- Off produces only the clean deck.
- On produces the identical clean deck plus a separate editable review copy.
- Yellow notes point to exact claims, decisions, relationships, or design areas needing human judgment.
- Notes diagnose slide-specific issues, explain executive impact, and recommend concrete action.
- Repeated generic boilerplate is a failure.
- Yellow boxes do not cover essential content or overflow their own text.

## Scenario 4 — editability and formatting survival

In PowerPoint, make all of these edits in a delivered deck:

1. Change one title and add roughly 25% more body copy.
2. Bold and unbold individual words in a mixed-emphasis paragraph.
   Also inspect a repeated `Label — explanation` list: every label stays emphasized, every explanation stays regular, and a label-specific italic nuance does not spread into its body.
3. Change one chart value and one native-table cell.
4. Ungroup and regroup one graphic.
5. Move one diagram node and adjust one connector.
6. Save as a new file, close PowerPoint, reopen it, and inspect every edited slide.

Pass only if the edits are possible without reconstructing the slide, formatting remains stable, connectors stay attached, and no new clipping or overlap appears.

## Scenario 5 — difficult layouts and orientations

Create one horizontal invite card, one vertical information brochure, and one website/mobile-page reconstruction from visual references.

Check:

- Orientation, visual hierarchy, margins, and repeated spacing match the references closely.
- Text remains native and editable; only true image assets are rasterized.
- Background or covering blocks expand with multi-line text.
- Icons match the concept they label.
- No arbitrary one-sided text inset appears unless the reference clearly requires it.

## Feedback record

Copy this block once per scenario:

```text
Scenario:
Prompt/task link:
Input files:
First-open acceptance (yes/no):
Blocking defects:
Non-blocking defects:
Editability checks passed:
Save/close/reopen passed (yes/no):
Reference concepts recognized:
E6 note quality (specific/generic/not applicable):
Manual cleanup minutes:
Would you share this output unchanged (yes/no):
Screenshots and affected slide numbers:
```
