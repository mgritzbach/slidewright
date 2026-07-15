# Independent image ingestion

Use this path when the only source is a raster design image.

1. Normalize the input to an RGB PNG without metadata and name it by its SHA-256 digest.
2. Inspect only the pixels. Emit an observation record matching `../schemas/observed-design.schema.json`; do not use a source deck, HTML, CSS, geometry manifest, text transcript, or expected-answer fixture.
3. Record uncertainty explicitly. A font family inferred from pixels is always a guess.
4. Keep every object native and editable. Reconstruct flat graphics as shapes and all visible text as text runs.
5. Run `scripts/slidewright.mjs reconstruct <observed-design.json> --out <deck.pptx> --preview-dir <dir>`.
6. Remove exporter grouping locks, render the PPTX, run overflow and OOXML audits, then compare the source and rendered PNG with independently derived background metrics.
7. Reject full-slide raster fallback, embedded copies of the source, missing text, fractional type, missing fonts, blank controls, and provenance that shares source geometry with the renderer.
8. Inspect the source, reconstruction, overlay, and difference image at full size. Report visible deviations even when thresholds pass.

The committed independent fixture demonstrates the boundary: an isolated parser saw one opaque PNG, while deterministic rendering, structural audit, and pixel scoring happened later without source geometry.
