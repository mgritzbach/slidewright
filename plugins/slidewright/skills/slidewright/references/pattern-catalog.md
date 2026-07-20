# Consulting pattern catalog

Slidewright ships a versioned catalog of exactly 100 consulting design recipes. The recipes are original structural syntheses informed by recurring public information architectures in McKinsey, BCG, Bain, Oliver Wyman, Strategy&, and Roland Berger publications. They do not copy firm templates, artwork, or brand systems.

The catalog is a selection layer over Slidewright's proven compiler engines. A recipe is not a new page archetype: it declares the communication intent, argument schema, supported item count, density, focus rule, connector policy, geometry constraints, content budget, editability contract, overflow fallback, anti-use cases, and mandatory render/OOXML tests. This keeps selection intelligence rich without weakening the immutable archetype and typography contracts.

## Commands

```text
node scripts/slidewright.mjs patterns list --out patterns.json
node scripts/slidewright.mjs patterns select intent.json --out selection-receipt.json
node scripts/slidewright.mjs patterns generate request.json --out deck-spec.json --receipt selection-receipt.json
```

`patterns list` accepts optional `--family`, `--archetype`, and `--style-class` filters.

`patterns select` expects a JSON object using any of these semantic fields:

```json
{
  "purpose": "compare",
  "relationship": "trade-off",
  "itemCount": 2,
  "density": "standard",
  "sequence": false,
  "overlap": false,
  "hierarchy": "tension",
  "dataMode": "mixed",
  "styleClass": "classic-analytical"
}
```

The selector scores exact purpose and relationship matches before count compatibility and density. It never randomizes and returns a receipt containing catalog, intent, and candidate hashes.

Selection is descriptive; generation is fail-closed. Only patterns with `visualReview.status: "pass"` and complete semantic coverage may produce release candidates. A pattern marked `revise` or `veto` can be instantiated only with `developmentMode: true` for controlled engine work and must never be delivered as a finished user slide.

`patterns generate` accepts either an explicit `patternId` or an `intent`, plus optional `content` and `themeProfileId`. It emits an ordinary version `0.2` deck specification. Run that specification through the guarded request pipeline for a release build.

```json
{
  "patternId": "c043-five-capability-pentagon",
  "themeProfileId": "slate",
  "content": {
    "title": "Five capabilities reinforce the operating model"
  }
}
```

## Portfolio balance

- 60 classic analytical recipes
- 30 contemporary geometric recipes
- 10 bold narrative recipes
- 10 executive synthesis
- 12 comparisons and choices
- 16 processes and transformations
- 12 shape and relationship systems
- 18 quantitative exhibits
- 10 tables and scorecards
- 10 timelines and roadmaps
- 6 organization and ecosystem maps
- 6 evidence and narrative pages

## Release gates

From the repository root, run `node scripts/build-pattern-catalog-source.mjs`, `node --test tests/pattern-catalog.test.mjs tests/prompt-robustness.test.mjs`, `npm run setup:runtime`, and `node scripts/run-pattern-catalog-benchmark.mjs`. The benchmark builds ten decks of ten patterns so a single rendering failure stays isolated. Every recipe must compile and lint without warnings, render to a full-size PNG, and pass the OOXML audit for native editable text, whole-point sizes, and rich-text runs. Visual approval remains separate: every PNG must be inspected individually and score at least 92 with no critical veto before that individual pattern becomes a release candidate. Never infer visual readiness from a montage or structural pass.

Do not describe the 100 recipes as 100 independent compiler engines. New engines require a registry refactor and their own immutable archetype contracts.
