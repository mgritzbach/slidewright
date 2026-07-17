# Copy resilience

Use structural adaptation when translated, expanded, or dense copy would otherwise force clipping or type below the role minimum.

## Required path

For prompt-originated release work, use `scripts/slidewright.mjs request`; its compile stage runs the adapter and publishes `adapted-spec.json` plus `adaptation.json` before rendering. For diagnostics, run:

```text
scripts/slidewright.mjs adapt <spec.json> --out <adapted-spec.json> --manifest <adaptation.json>
scripts/slidewright.mjs compile <adapted-spec.json> --out <plan.json>
```

The adapter may split flexible hero body/callout copy, two-column bodies, section detail, and existing continuation bodies. It must not split a title, eyebrow, or column heading silently. Those fields require editorial shortening or another declared layout.

## Invariants

- Preserve every normalized source word token and its bold, italic, color, bullet, and level state exactly once and in order.
- Allow whitespace and source run boundaries to normalize at continuation breaks; do not claim byte-exact source copy or original run segmentation.
- Keep the original slide first, then place labeled continuation slides immediately after it in field order.
- Balance chunks across the minimum fitting slide count instead of leaving a nearly empty final continuation.
- Keep all visible copy as native editable text using approved whole-point sizes at or above the role minimum.
- Recompute and verify the adaptation from the original specification; reject dropped, duplicated, reordered, or misowned chunks.
- Refuse non-splittable overflow and output beyond the configured slide ceiling. Never bypass the ceiling by shrinking or clipping.

Run `npm run copy-resilience` for the bounded C15 corpus, `npm run copy-resilience:verify` for independent artifact and recomputation checks, and finalize individual full-size review with `npm run copy-resilience:review -- --decisions <file>`.

The current proof covers the committed layouts, Arial, one pinned German translation, and flexible-copy density through 4x. It is not a translation engine or a universal language/layout claim.
