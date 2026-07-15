# Template fidelity

For an existing deck or user-provided template:

1. Preserve the input file and export a distinct edited copy unless the user requests in-place editing.
2. Inspect every source slide, layout, placeholder, theme, footer, page marker, and recurring chrome.
3. Extract the source type scale, fonts, colors, margins, padding patterns, and media frames.
4. Map each requested output slide to a source layout before editing.
5. Edit inherited objects instead of rebuilding parallel approximations.
6. Log every intentional deviation with the source slide, target object, reason, and user instruction.
7. Reject content that no source layout can hold without violating the template; offer the closest viable source layouts.
8. Render and compare every edited slide at full size, then run the structural audit.

Never mix the source design with another template or silently restyle the deck.
