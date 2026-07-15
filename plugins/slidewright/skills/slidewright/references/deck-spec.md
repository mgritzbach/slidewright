# Deck specification

Use schema version `0.1`. Keep semantic intent in the specification and exact coordinates in the compiled plan.

## Top-level fields

- `version`: must be `0.1`.
- `title`: non-empty project/deck title.
- `theme`: optional font and color overrides.
- `layout.margin`: optional symmetric outer margin in pixels; default `64`.
- `slides`: non-empty slide array.

## Supported MVP layouts

### Hero

Required fields: `layout: "hero"`, `eyebrow`, `title`, `body`, and `callout`.

### Two column

Required fields: `layout: "two-column"`, `title`, and `left`/`right` objects with `heading` and `body`.

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
