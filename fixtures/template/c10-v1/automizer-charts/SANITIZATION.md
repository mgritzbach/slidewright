# Automizer chart fixture curation

The pinned MIT-licensed upstream deck is retained as `upstream-template.pptx`.
Its second slide contains a native clustered-column chart whose manually fixed
legend rectangle overlaps the category-axis labels when rendered by PowerPoint.

`sanitize.py` deterministically removes that manual legend rectangle from
`ppt/charts/chart1.xml`, replaces it with an empty chart layout, and pins the
`c:lang` metadata in both native chart parts from the upstream `de-DE` value to
`en-US`. The language pin prevents the English PowerPoint evidence environment
from silently rewriting chart locale during save/reopen; any different locale
now fails the semantic audit instead of being normalized away. PowerPoint then
reserves normal legend space. Both charts remain native and editable; their
embedded workbooks, series, values, axes, styles, colors, theme, and slide
geometry are unchanged.

The script also canonicalizes ZIP metadata and stores entries without
compression so the derived bytes do not depend on a local zlib version. It
fails closed on the reviewed upstream hash, the exact expected XML patterns,
the curated output hash, and the two-part semantic change set.
