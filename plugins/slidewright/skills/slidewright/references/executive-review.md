# E6 executive review overlay

E6 is an optional post-QA review stage for prompt-originated decks. It adds human-judgment prompts without weakening or modifying the verified canonical presentation.

## Activation

Set the strict request envelope field to one of:

- `"reviewMode": "off"` — publish only `deck.pptx`.
- `"reviewMode": "executive-overlay"` — publish `deck.pptx` plus `deck.executive-review.pptx`.

If the field is absent, the mode is `off`. Any other value is rejected before compilation.

## Review-copy behavior

- Yellow boxes are native editable PowerPoint text shapes named `SW-E6-<slide>-<finding>`.
- Each box is anchored to a named target shape and quotes or names the exact claim, passage, table, card set, or comparison being reviewed.
- Every finding contains a concrete diagnosis, the consequence for the intended executive audience, a specific recommended revision, and the selected reference concept/slide when design provenance is available.
- Comparisons are classified by their semantic relationship: alternatives need a selection rule, complementary maps need crosswalk logic, roles need authority boundaries, and sequential panels need exit conditions and handoffs.
- Exact repeated sentences and generic boilerplate such as “sharpen the takeaway” fail the specificity gate.
- Review notes may intentionally cover the area being questioned. They may not overlap another E6 note or leave the slide canvas.
- The canonical deck is independently audited to contain zero E6 objects.
- Turning E6 off creates no annotated deck and leaves the canonical deck byte-identical to the same build with E6 on.

Do not use E6 as a substitute for linting. Mechanical defects still fail the build; E6 is reserved for claims and decisions that require human validation.
