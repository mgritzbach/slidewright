# Deck specification

Use schema version `0.2`. Version `0.1` remains accepted for legacy input, but new specifications should use `0.2`. Keep semantic intent in the specification and exact coordinates in the compiled plan.

## Top-level fields

- `version`: use `0.2`.
- `title`: non-empty project/deck title.
- `theme`: optional font and color overrides.
- `layout.margin`: optional symmetric outer margin in pixels; default `64`.
- `slides`: non-empty slide array.

The compiler resolves every slide against one versioned logical design master, a declared page archetype, and deck-wide typography, inset, and paragraph-spacing tokens. This is a generated design contract, not a claim that the deck contains a source-template PowerPoint master.

## Supported layouts

### Hero

Required fields: `layout: "hero"`, `eyebrow`, `title`, `body`, and `callout`.

### Two column

Required fields: `layout: "two-column"`, `title`, and `left`/`right` objects with `heading` and `body`.

### Section and continuation

- `section`: `title` and `subtitle`; its backing grows with the title.
- `continuation`: `eyebrow`, `title`, and `body`; use it before shrinking dense copy below the role minimum.

### Native table

Use `layout: "table"`, a `title`, and a rectangular `table` with 2-6 columns and 1-8 body rows. Header and body cells use deck-wide roles and symmetric `8 px` native cell margins.

```json
{
  "layout": "table",
  "title": "Decisions and owners",
  "table": {
    "columns": ["Decision", "Owner", "Status"],
    "rows": [["Ship", "Team", "Ready"]]
  }
}
```

### Semantic icon list

Use `layout: "icon-list"`, a `title`, and 2-4 items. Each item requires a stable `id`, `label`, `body`, `conceptId`, and an icon from the native editable glyph library. The concept/icon pair must match the design-system ontology.

```json
{
  "layout": "icon-list",
  "title": "How the work is framed",
  "items": [
    { "id": "goal", "label": "Goal", "body": "The outcome.", "conceptId": "goal", "icon": "target" },
    { "id": "done", "label": "Done when", "body": "The checks.", "conceptId": "completion", "icon": "check" }
  ]
}
```

## Count-aware consulting points

Use `layout: "point-grid"` for 2-9 logically parallel points. Each item needs a stable `id`, editable `label`, and editable `body`. `arrangement` may be `auto`, `columns`, `rows`, or `grid`; prefer `auto` unless the content relationship requires a specific direction. At most one item may set `emphasis: true`.

`auto` resolves to `2`, `3`, `2+2`, `3+2`, `3+3`, `4+3`, `4+4`, and `3+3+3` rows for counts 2 through 9. Incomplete rows are centered. `SW031` enforces equal peer geometry and exact gutters.

## Polygon relationship system

Use `layout: "polygon-cycle"` only when 3-8 points form a genuine `cycle`, `system`, `perimeter`, or `mutual-reinforcement` relationship. The count determines a native editable triangle, square, pentagon, hexagon, heptagon, or octagon outline; it does not justify the topology by itself. Each item requires `id`, `label`, and `body`; optional `center` names the shared outcome or system. At most one point may set `emphasis: true`.

The compiler binds equal native point surfaces to the polygon vertices. `SW032` rejects a missing semantic relationship, the wrong native polygon, unequal nodes, or vertex drift. Use `point-grid` instead when the items are merely parallel, and use steps or a timeline when order is one-way rather than cyclical.

## Opposition and synthesis

Use `layout: "opposition"` for two genuinely conflicting positions. Provide a native editable `title`, `left.heading`, `left.body`, `right.heading`, and `right.body`. `axisLabel` defaults to `VS`. Add optional `synthesis` when the recommendation combines the two sides or defines a conditional boundary. Use a comparison table instead when there are more than two alternatives or several repeated criteria.

## Text values

Use a string for uniform text. Use runs for editable emphasis:

```json
{
  "runs": [
    { "text": "Ideas in. ", "bold": false },
    { "text": "PowerPoint out.", "bold": true }
  ]
}
```

Do not encode formatting with Markdown markers inside visible text.

For repeated `Label — explanation` items, encode the label plus delimiter and the explanation as separate runs. Keep the explanation style consistent across peer items; do not bold or italicize the whole paragraph merely because its leading label is emphasized.

For multiple native paragraphs, use `paragraphs` and optional `spaceBeforePt`/`spaceAfterPt` values from `0`, `6`, or `12`. Equivalent repeated components must keep their role and declared variant; do not encode one-off formatting in the content specification.
