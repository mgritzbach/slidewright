# Current limitations

- The semantic compiler currently supports a narrow set of layouts. Independent image ingestion is proven on one original invitation fixture, not yet a broad multi-domain benchmark; pixel-only font identity remains an explicit guess.
- Existing PowerPoint template import and preservation are not yet proven.
- Exact visual rendering depends on fonts being installed on the render machine. Missing requested families now block with an explicit fallback suggestion; font embedding is not yet supported.
- Native grouping requires deterministic OOXML normalization after artifact export.
- PowerPoint group round-trip testing currently runs only on Windows with Microsoft PowerPoint installed.
- Similarity scores include renderer and font-antialiasing differences and must be read beside the structural audit and full-size review.
- Automatic dense-copy splitting, native chart/table coverage, and accessibility checks remain roadmap goals. Dense copy currently fails before export with actionable diagnostics instead of being silently shrunk.
