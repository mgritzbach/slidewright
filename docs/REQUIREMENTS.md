# Requirements

## Functional requirements

| ID | Requirement | MVP acceptance |
| --- | --- | --- |
| F01 | Accept a versioned deck specification | Valid JSON compiles; invalid input fails with actionable diagnostics |
| F02 | Compile layouts deterministically | Same specification and token set produce byte-equivalent plan JSON |
| F03 | Enforce symmetric outer margins | Each slide content frame has equal left/right and top/bottom margins within 1 px |
| F04 | Enforce symmetric component padding | Components declaring uniform padding pass; asymmetric padding fails unless explicitly allowed |
| F05 | Auto-fit text to approved sizes | Largest fitting size is selected from the configured integer point scale; no fractional size is emitted |
| F06 | Preserve minimum readable sizes | Content that cannot fit above the minimum produces an error and a relayout/shortening suggestion |
| F07 | Preserve editability | Text renders as PowerPoint text nodes and semantic objects are not flattened into slide images |
| F08 | Preserve rich-text emphasis | Mixed bold and regular runs survive export and remain independently editable |
| F09 | Detect geometric defects | Plan and rendered-layout lint reject canvas/parent clipping, text overflow, unintended overlap, contrast, declared alignment, wrapping, crowding, and bounded chart-readability defects |
| F10 | Emit build evidence | Every build can output plan JSON, lint JSON, rendered previews, and OOXML audit JSON |
| F11 | Package the workflow as a Codex plugin/skill | Repo-local marketplace, valid plugin manifest, valid skill metadata, and judge-ready setup instructions |
| F12 | Respect source templates | Proven narrowly: named-placeholder text edits preserve every non-target package part and pass a PowerPoint round trip on the MIT golden fixture; broader structural import remains outside the release claim |
| F13 | Forbid visible text collisions | Any positive-area text/text or text/reserved-region intersection fails both plan and realized-layout lint; generic overlap declarations cannot waive the rule |
| F14 | Consume headline safe width | Headline geometry equals the complete safe interval unless an actual center or two-thirds divider intersects the headline zone and reserves one side |
| F15 | Grow text-backed regions | A title or callout surface reaches the realized text bottom plus symmetric padding; under-height fixtures fail before delivery |
| F16 | Preserve declared topic coverage | A versioned coverage manifest maps every topic, in order, to one unique divider and at least one unique substantive slide |
| F17 | Remove inherited empty bullets | Empty source paragraphs are removed before fitting; master-inherited bullet fixtures preserve non-empty paragraphs and reject blank-bullet reinsertion |

## Quality requirements

| ID | Requirement | Target |
| --- | --- | --- |
| Q01 | Compiler unit test coverage | Every release-credited layout rule has an explicit positive path and isolated negative fixture with stable diagnostics |
| Q02 | Determinism | Zero plan diff across three consecutive builds from identical input |
| Q03 | Visual integrity | Zero unintended overflow, clipping, or overlap in the demo deck |
| Q04 | Typography consistency | 100% of audited text sizes are whole point values in the approved scale |
| Q05 | Editability | 100% of visible demo text is represented by native text nodes |
| Q06 | Portability | Windows primary; macOS/Linux path handling covered by Node path APIs and CI by submission |
| Q07 | Explainability | Every lint failure includes rule ID, location, message, and recommended fix |

## Approved default design tokens

- Canvas: `1280 x 720 px` (16:9)
- Outer margin: `64 px` on all sides
- Grid: 12 columns with `24 px` gutters
- Component padding: `32 px` default, symmetric
- Type scale in points: `54, 48, 44, 40, 36, 32, 28, 24, 20, 18, 16, 14, 12`
- Default title minimum: `28 pt`
- Default body minimum: `16 pt`
- Font: Arial for the portable benchmark default; any alternate requested family must pass the installed-font audit before rendering
- Geometry tolerance: `1 px`

## Definition of done for a deck

A deck is done only when the specification compiles, plan lint has no errors or warnings, actual exported layout metadata passes the second lint phase, the PPTX exports, OOXML audit passes, each slide is rendered, and every rendered slide is inspected at full size.
