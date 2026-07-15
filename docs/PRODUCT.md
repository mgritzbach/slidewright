# Product brief

## One-line pitch

Slidewright turns an idea, outline, or source deck into a polished PowerPoint whose formatting remains coherent and whose text, emphasis, shapes, charts, and tables remain editable.

## The problem

AI-generated decks usually fail at the last mile. The screenshot looks plausible, but the actual file contains uneven margins, clipped text, fractional type sizes, broken hierarchy, flattened visuals, or formatting that disintegrates when a user edits one sentence. Presentation work is therefore not eliminated; it is displaced into cleanup.

## Target user

The primary user is a knowledge worker who needs to create or revise professional PowerPoint decks under time pressure and must hand off a file that colleagues can continue editing. Initial beachheads are consultants, strategy and operations teams, founders, educators, and policy professionals.

## Job to be done

> When I give an AI my idea, content, or source deck, create a presentation I can confidently open, edit, and share without spending another hour repairing layout and typography.

## Product promise

Slidewright guarantees a formatting contract, not merely a generated file:

1. Layout is compiled against explicit margins, grids, spacing, and density budgets.
2. Text is fitted using conventional integer point sizes.
3. Text and semantic objects remain native and editable.
4. Rich-text emphasis remains run-level bold, regular, italic, and color.
5. The final PPTX is linted, rendered, inspected, and accompanied by evidence.

## Initial wedge

The first release supports a small number of excellent, adaptable layout families rather than dozens of brittle templates. A narrow compiler with strong guarantees is more valuable than a broad generator that silently produces cleanup work.

## Differentiation

| Typical generator | Slidewright |
| --- | --- |
| Optimizes the first screenshot | Optimizes the editable artifact lifecycle |
| Lets PowerPoint shrink text unpredictably | Selects the largest approved integer size that fits |
| Treats spacing as aesthetic guesswork | Enforces geometry constraints and symmetry |
| Flattens emphasis or whole slides | Preserves native objects and rich-text runs |
| Declares success after export | Emits lint, render, and OOXML evidence |

## North-star metric

**First-open acceptance rate:** percentage of generated slides a user accepts without any formatting repair.

Supporting metrics:

- formatting defects per slide;
- manual cleanup minutes per deck;
- percent of text objects that remain editable;
- percent of type sizes in the approved scale;
- template deviation count;
- build success rate without warnings.

## Non-goals for the first week

- replacing PowerPoint as an editor;
- building a full template marketplace;
- supporting every chart type or animation;
- claiming pixel-identical template fidelity before golden-file evidence exists;
- generating decorative visuals when the user did not ask for them.
