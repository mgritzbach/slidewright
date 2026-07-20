# Consulting layout grammar

This grammar converts a message into a native, editable consulting composition. It is a selection system, not a gallery of decorative diagrams.

## Evidence base

The local study inspected all 66 slides in `Dummy Slide.pptx` at full rendered size and analyzed the native object geometry. The file studied had SHA-256 `DE4EB2869C60EE8DCEB1D2261BEB6F1A440DE0F9518B70B60FFE98CD186FEEA4`; no source deck or proprietary asset is committed.

- 60 slides contain substantive content; six are blank or near-blank.
- 57 of 60 substantive slides use the same title box: `x=48`, `y=40.32`, `w=1184`, `h=79.68` on a `1280 x 720` canvas.
- All 60 substantive slides resolve the primary title to 26 pt. The dominant body sizes by character count are 14 pt and 16 pt.
- The repeated content frame begins near `y=146.67`, leaving a deliberate band between the title and the evidence.
- Repeated peers are normally aligned to one grid and one baseline. A single color or size exception indicates selection, current state, risk, or recommendation.
- The corpus repeatedly uses equal columns, 2x2 quadrants, 3x2 and 4x2 frameworks, row lists, option tables, timelines, pyramids, and central-system diagrams.

Public consulting material reinforces the semantic choices. McKinsey's account of Barbara Minto describes a conclusion above logically similar, ordered, MECE support; BCG uses a matrix when two independent dimensions determine a choice; McKinsey's influence model uses four distinct elements around one outcome; BCG uses a three-step form for a true sequence. These are the reasons Slidewright chooses structure from the relationship between ideas rather than from item count alone.

## First choose the relationship

1. Use columns or a grid for independent, logically parallel points.
2. Use rows for a scan-heavy list, especially when labels or explanations are longer.
3. Use chevrons, steps, or a timeline only when order, duration, or handoff matters.
4. Use a matrix or table when the audience must compare the same criteria across options.
5. Use opposition for two genuinely conflicting positions. Add a synthesis band when the recommendation combines them.
6. Use a pyramid for hierarchy or narrowing, not merely because there are three points.
7. Use Venn, puzzle, or radial structures only when overlap, interdependence, or a shared center is the message.

## Count-aware default for parallel points

The `point-grid` archetype supports two through nine native point cells. `arrangement: "auto"` uses the following rows. Incomplete rows remain centered; equal peers retain equal width, height, padding, typography, and gaps.

| Points | Default rows | Best use | Secondary option |
|---:|---|---|---|
| 2 | `2` | choice, dual condition, paired lenses | opposition if the positions conflict |
| 3 | `3` | three pillars or independent moves | row sequence only when order matters |
| 4 | `2 + 2` | four workstreams or a complete framework | `4` columns for very short copy |
| 5 | `3 + 2` | five choices with equal status | one vertical list for longer explanations |
| 6 | `3 + 3` | six capabilities or workstreams | `2 + 2 + 2` when copy is longer |
| 7 | `4 + 3` | seven controls or dimensions | one lead plus six only when a true parent exists |
| 8 | `4 + 4` | eight questions or levers | `3 + 3 + 2` for narrower media |
| 9 | `3 + 3 + 3` | nine-part system | matrix only when rows and columns have meaning |

Do not make a last item wider merely to fill space. Center the incomplete row. Do not emphasize more than one peer unless the semantics define multiple named variants.

## Opposition, pro/con, and contradiction

Use `layout: "opposition"` for two positions that must be read against one another.

- Keep both sides equal in width and height, with a visible central decision boundary.
- Phrase headings in the same grammatical form and keep body density comparable.
- Use position and a controlled color variant to distinguish the sides; do not change font hierarchy between them.
- Add `synthesis` when the answer is a hybrid, a guardrail, or a conditional recommendation. The synthesis spans the full safe width below both sides.
- If there are three or more alternatives, use a comparison table rather than forcing a multi-way “versus” slide.
- If the contrast is temporal (current/future) or causal (problem/solution), use direction and sequence rather than adversarial styling.

## Space and hierarchy rules

- Reserve a stable action-title band. The title states the conclusion, not the topic.
- Give the title the full safe width unless a real center or two-thirds structural split reserves the adjacent region.
- Keep one dominant visual field below the title. Avoid many unrelated islands.
- Use equal outer margins and symmetric internal padding. Common generated values are 64 px outer margin, 16/24/32 px component padding, and 16/24/48 px semantic gaps.
- Keep labels short and parallel. Put explanation below the label in a separate editable run or paragraph.
- Preserve one deck-wide title, component-heading, body, table, and source-note hierarchy. Shorten or relayout before shrinking below the minimum.
- Use one deliberate highlight for the recommendation, risk, current step, or exception. All other peer geometry remains unchanged.
- A background or header block must grow with its text. Text may never escape or overlap another text box.

## Patterns not promoted to defaults

The source deck contains decorative cylinders, hexagons, puzzle pieces, speedometers, Venns, and stepped rails. They remain available as semantic concepts, but they are not count-based defaults: ornamental geometry increases object count, reduces text capacity, and often implies a relationship the content does not have. Slidewright prefers the simplest structure that makes the logic visible.

## Compiler and lint contract

- `point-grid` accepts 2–9 stable items and `auto|columns|rows|grid` arrangement.
- `opposition` accepts two sides, a short axis label, and an optional synthesis statement.
- Every visible element remains a native editable PowerPoint object.
- `SW031` rejects unequal peer geometry, wrong gutters, and off-center incomplete rows.
- Existing fit, overlap, padding, typography, run-emphasis, export, and rendered-layout rules remain mandatory.

## Public cross-checks

- [McKinsey on Barbara Minto, the Pyramid Principle, and MECE](https://www.mckinsey.com/alumni/news-and-events/global-news/alumni-news/barbara-minto-mece-i-invented-it-so-i-get-to-say-how-to-pronounce-it.)
- [BCG on using a scale-and-standardization matrix to segment operational choices](https://www.bcg.com/publications/2019/simpler-faster-efficient-operations-financial-services)
- [McKinsey's four building blocks of change](https://www.mckinsey.com/capabilities/people-and-organizational-performance/our-insights/the-four-building-blocks--of-change)
- [BCG's three-step culture-change approach](https://www.bcg.com/publications/2024/how-to-create-a-transformation-that-lasts)
