# Consulting pattern catalog status

## Outcome

Slidewright now contains a versioned catalog of 100 original consulting slide blueprints spanning executive synthesis, comparisons, processes, shape systems, quantitative exhibits, tables, timelines, operating models, and evidence pages. The catalog is a governed design system over the existing compiler, not a claim that 100 distinct rendering engines are finished.

Every pattern declares its communication intent, argument schema, supported item count, content budget, geometry rules, connector policy, overflow fallback, editability contract, anti-use cases, semantic signature, and required render and OOXML checks. Selection is deterministic and emits hash receipts.

## Current evidence

- 100/100 patterns instantiate deterministically through the compiler.
- 100/100 pass plan lint with zero errors and zero warnings.
- 100/100 render to native editable PowerPoint.
- 100/100 pass rendered lint and OOXML audit; no pattern relies on rasterized text.
- 100/100 were reviewed individually at full size by consulting, executive, design, and architecture critics.
- 5 patterns passed the current 92-point release threshold.
- 16 patterns require targeted revision.
- 79 patterns are vetoed from release until their defining semantic structure is implemented.

Benchmark scorecard SHA-256: `25534884158db47e595df0ea27f0a87cee1ef8b3bb07b1c881c0bf39655d2afe`.

## Release candidates

The current release-candidate set is intentionally small:

1. `c039-two-pole-tension-axis`
2. `c043-five-capability-pentagon`
3. `c045-seven-element-heptagonal-system`
4. `c046-eight-element-octagonal-system`
5. `c049-twelve-node-perimeter-network`

These are layout release candidates, not prewritten client slides. Final content still runs through Slidewright's ordinary text-fit, emphasis, overlap, editability, and executive-review gates.

## Fail-closed behavior

Normal catalog generation accepts only full-size-reviewed `pass` patterns whose compiler archetype supplies every required semantic mark. `revise` and `veto` patterns cannot generate a release candidate. They require explicit `developmentMode: true`, which exists only for controlled engine development and benchmark work.

This blocks the central failure discovered during review: a named exhibit such as a waterfall, bubble portfolio, roadmap, service blueprint, or customer journey must not ship as a renamed table, grid, or chevron slide.

## Next implementation sequence

1. Add a native quantitative-exhibit engine for bars, waterfall, slopegraph, dumbbell, dot plot, line, scatter, bubble, heatmap, cohort, tornado, bridge, and Marimekko structures.
2. Add a native roadmap engine for milestones, swimlanes, dependencies, horizons, waves, release trains, and critical paths.
3. Add semantic engines for capability houses, operating-model layers, journeys, service blueprints, and ecosystem maps.
4. Rebuild the 16 revision candidates first, then the vetoed blueprints in priority order.
5. Require individual full-size review at 92 or higher, zero critical defects, complete semantic coverage, compiler/linter success, and OOXML editability proof before promoting any pattern.

The project should describe this milestone as "100 governed blueprints with five reviewed release candidates," not "100 world-class finished slides."
