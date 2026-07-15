# Visual fidelity workflow

Use owned or licensed reference material with a machine-readable object manifest. For an exact reconstruction, preserve stable object names and audit the final exported PPTX, not only a preview.

Run `npm run fidelity` from the repository root for the six-fixture proof suite. Treat any OOXML audit failure, overflow finding, similarity below 0.95, or full-size visual defect as a build failure.

Metrics are supporting evidence. Inspect every reference/output pair at full size and relayout content when line wrapping differs. Never compensate by rasterizing text.
