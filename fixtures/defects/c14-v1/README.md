# C14 v1 defect fixture contract

This owned synthetic fixture matrix proves two-phase automated quality checks. Plan lint covers bounds, fit, unintended overlap, contrast, declared alignment, wrapping, container clipping, crowding, and bounded chart readability. Rendered-layout lint maps stable object names to actual exported bounding boxes and line counts before a PPTX may be saved.

`npm run defects` must:

1. accept the clean demo plus rendered, native-shape horizontal and vertical chart components whose labels, marks, bounds, collisions, contrast, orientation, categories, and series are derived from child geometry rather than trusted booleans;
2. reject every isolated plan mutation with its exact rule ID;
3. render the clean deck, pass rendered-layout lint, `slides_test.py`, OOXML audit, and a real PowerPoint text-bound check;
4. reject a false one-line fit claim only after actual layout export and emit no deliverable PPTX;
5. create a deliberately clipped temporary PPTX, reject it from real PowerPoint text bounds, and delete the rejected file;
6. produce identical diagnostics over three runs and a content-addressed scorecard.

The chart fixtures exercise readability metadata only. They do not claim native PowerPoint chart export; C18 remains separate.
