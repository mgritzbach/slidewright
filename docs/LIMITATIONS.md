# Current limitations

- The semantic compiler currently supports a narrow set of layouts. Independent image ingestion is proven on one original invitation fixture, not yet a broad multi-domain benchmark; pixel-only font identity remains an explicit guess.
- Exact named-placeholder text editing is proven on one MIT-licensed, PowerPoint-authored golden fixture, including byte-level preservation outside the target slide and a real PowerPoint save/reopen round trip. General existing-deck import, structural edits, and coverage of complex charts, tables, diagrams, notes, media, embedded fonts, and multiple real-world templates are not yet proven.
- Exact visual rendering depends on fonts being installed on the render machine. Missing requested families now block with an explicit fallback suggestion; font embedding is not yet supported.
- Native grouping requires deterministic OOXML normalization after artifact export.
- PowerPoint group round-trip testing currently runs only on Windows with Microsoft PowerPoint installed.
- Similarity scores include renderer and font-antialiasing differences and must be read beside the structural audit and full-size review.
- Automatic dense-copy splitting, native chart/table export, and broad accessibility checks remain roadmap goals. Dense copy currently fails before export with actionable diagnostics instead of being silently shrunk. Current chart-component checks derive readability from native-shape label and mark geometry, but do not prove native PowerPoint chart semantics or mutation integrity.
- Automated plan and rendered-layout checks cover known canvas/parent clipping, overflow, overlap, contrast, declared alignment, wrapping, crowding, and chart-readability constraints. They complement, but do not replace, full-size review or prove professional quality across arbitrary designs.
