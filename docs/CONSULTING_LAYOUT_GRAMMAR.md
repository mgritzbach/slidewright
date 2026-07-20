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
7. Use a segmented triangle through dodecagon only when the points form a cycle, system, perimeter, or mutually reinforcing model.
8. Use Venn, puzzle, or radial structures only when overlap, interdependence, or a shared center is the message.

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

## Segmented polygon systems from triangle through dodecagon

The `polygon-cycle` archetype supports three through twelve native editable points. Count selects the polygon only after the relationship has been declared. Every vertex lies on one true circumcircle, so squares, pentagons, and higher polygons remain regular instead of flattening to fill a rectangle. Each side is its own mitered native beam, with a deliberate corner gap, upright editable marker, optional emphasis state, and matched adjacent callout module. The callouts need no leader lines. Counts nine through twelve automatically use denser but still 16 pt two-column annotations instead of shrinking text.

| Points | Native form | Appropriate meaning |
|---:|---|---|
| 3 | Triangle | three mutually reinforcing foundations or tensions |
| 4 | Square | four controls forming one bounded operating system |
| 5 | Pentagon | a five-stage recurring cycle or five-part system |
| 6 | Hexagon | six connected capabilities around one outcome |
| 7 | Heptagon | seven guardrails defining a perimeter |
| 8 | Octagon | eight linked levers in a complete system |
| 9 | Nonagon | nine mutually dependent capabilities in one delivery engine |
| 10 | Decagon | ten reinforcing enterprise-readiness levers |
| 11 | Undecagon | eleven controls forming a complete perimeter |
| 12 | Dodecagon | a recurring monthly or twelve-move transformation cycle |

Do not use the polygon merely because the item count matches. Parallel pillars remain a grid; a one-way process remains steps; criteria-versus-options remains a matrix. Polygon callouts keep equal dimensions and hierarchy, sit adjacent to their bound edge segment, and may surround one short shared outcome. The center statement is placed at the true visual center; the triangle receives a specifically protected central region so the statement cannot collide with its beams. At most one segment and its callout receive the emphasis variant.

## Structural separation, flow, and connected patterns

- Use `quadrant-focus` when four equal domains surround one decision or outcome. The compiler creates four open native zones, a symmetric central diamond, and four matching divider lines that terminate at and render beneath the diamond.
- Use `chevron-flow` for three through five real handoffs. Direction is carried by equal native chevrons, so no decorative connector line is required; an optional takeaway spans the safe width below the sequence.
- Use `icon-network` with `topology: "honeycomb"` for seven touching modular capabilities, `"pyramid"` for 3/6/10 hierarchical nodes, or `"square"` for 4/9 connected peers. One node may set `emphasis: true`; peer geometry and typography remain unchanged.
- Prefer adjacency or intrinsic shape direction over leader lines. When a pyramid or square network requires a connector, create it before the nodes, run it center-to-center underneath them, and match its color to the destination node rim. A connector may never terminate visibly over a box or its text.

## Shape-composition reference families

The user-supplied references add a reusable composition set. These are semantic families, not screenshots to copy blindly.

| Family | Use when | Defining visual logic |
|---|---|---|
| Emphasis matrix | four options share two dimensions and one needs focus | equal 2x2 tiles; one full-fill highlight; explanations outside or in aligned quadrants |
| Venn intersection | the message is overlap or a combined proposition | two or three translucent circles; intersection owns the synthesis; prose stays outside the geometry |
| Framed pillars | three or four distinct value drivers support one promise | equal open frames; icon breaks the top rule; identical heading/body hierarchy |
| Lead-tile mosaic | one statement governs six or seven supporting ideas | one high-contrast lead tile plus equal icon cards on the same grid |
| Step plus impact | ordered moves lead to one consequence | numbered horizontal rows aligned to one tall impact panel with matching step notches |
| Milestone timeline | sequence, date, and current/future state matter | continuous rail, alternating annotations, active milestone, muted future region |
| Ascending steps | ordered stages also represent rising maturity or progress | staggered platforms, large native numbers, short curved or angled connectors, one current-state accent |
| Asymmetric comparison | two positions conflict and one side is selected | unequal but intentional fields, central `VS` pivot, identical internal text hierarchy |
| Speech-tab comparison | two alternatives need compact framing before evidence | equal tabbed header blocks with a centered pivot and aligned bullets below |
| Mirrored feature scorecard | two options must be compared against the same numbered criteria | mirrored central option panels, equal numbered side rails, criterion text aligned across both sides |
| Quadrant with center | four domains connect through one shared decision | open equal zones, center-terminated underlay guides, central symmetric diamond, four semantic icon/annotation modules |
| Funnel or cylinder | stages narrow, accumulate, or filter | stacked tapered native segments with one-to-one aligned explanations |
| Hub and spoke | one outcome depends on multiple satellite capabilities | dominant center hub, underlay radial connectors, equal icon nodes, external annotations |
| Honeycomb system | modular capabilities touch through a central capability | native adjacent hexagons, regular geometry, one center emphasis, labels contained inside nodes |
| Four-part overlap | four lenses jointly define one ideal or combined answer | four equal circles, quiet central overlap field, synthesis in the center, external text in four quadrants |
| Chevron sequence | two to five true handoffs lead to one conclusion | contiguous native chevrons, repeated step/heading/body hierarchy, semantic icon per step, full-width takeaway band |

The selector must choose these families from message structure: overlap selects Venn; narrowing selects funnel; time selects timeline; shared center selects hub-and-spoke; adjacency and modularity select honeycomb. Item count alone never selects an intricate shape.

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
- Prefer text beside its semantic shape. If a connector is necessary, route it underneath every node and label, bind it to exact source/target nodes, and match the target rim color.

## Patterns not promoted to defaults

The source deck contains decorative cylinders, puzzle pieces, speedometers, Venns, stepped rails, and polygon motifs. They are never count-based defaults: ornamental geometry increases object count, reduces text capacity, and often implies a relationship the content does not have. Polygon forms are now available only through the semantically guarded `polygon-cycle` archetype. Slidewright still prefers the simplest structure that makes the logic visible.

## Compiler and lint contract

- `point-grid` accepts 2–9 stable items and `auto|columns|rows|grid` arrangement.
- `opposition` accepts two sides, a short axis label, and an optional synthesis statement.
- `polygon-cycle` accepts 3-12 stable items plus an explicit relationship and emits a segmented native triangle through dodecagon.
- `quadrant-focus` accepts exactly four icon-bound items plus one central statement.
- `chevron-flow` accepts 3-5 ordered icon-bound steps and an optional takeaway.
- `icon-network` accepts honeycomb (7), pyramid (3/6/10), or square (4/9) node counts with at most one emphasis state.
- Every visible element remains a native editable PowerPoint object.
- `SW031` rejects unequal peer geometry, wrong gutters, and off-center incomplete rows.
- `SW032` rejects an unsupported polygon relationship, missing or non-native beam, wrong segment count, ring position/rotation drift, unequal callouts, broken marker binding, or center-binding drift.
- `SW033` rejects unequal quadrant zones, a non-symmetric center, late/overlaid dividers, or divider/rim color mismatch.
- `SW034` rejects chevron count, geometry, baseline, or gap drift and any non-intrinsic connector mode.
- `SW035` rejects invalid icon-network counts or geometry, visible/late connectors, endpoint drift, and connector/rim color mismatch.
- Existing fit, overlap, padding, typography, run-emphasis, export, and rendered-layout rules remain mandatory.

## Public cross-checks

- [McKinsey on Barbara Minto, the Pyramid Principle, and MECE](https://www.mckinsey.com/alumni/news-and-events/global-news/alumni-news/barbara-minto-mece-i-invented-it-so-i-get-to-say-how-to-pronounce-it.)
- [BCG on using a scale-and-standardization matrix to segment operational choices](https://www.bcg.com/publications/2019/simpler-faster-efficient-operations-financial-services)
- [McKinsey's four building blocks of change](https://www.mckinsey.com/capabilities/people-and-organizational-performance/our-insights/the-four-building-blocks--of-change)
- [BCG's three-step culture-change approach](https://www.bcg.com/publications/2024/how-to-create-a-transformation-that-lasts)
