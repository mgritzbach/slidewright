# Public complaint ledger: Codex and PowerPoint

Research date: 2026-07-15. Scope: publicly indexed complaints and limitation reports found through searches of `openai/codex`, `openai/skills`, Reddit, OpenAI product pages, and adjacent editable-PPTX workflows. Searches were primarily in English, while directly surfaced non-English reports were retained. “Every complaint” means every distinct failure mode substantiated in this sweep; private, deleted, unindexed, and many non-English discussions may be missing.

Direct Codex/OpenAI reports are weighted above adjacent ecosystem complaints. Duplicate reports are merged into one failure mode. Product/app defects that a skill cannot repair are translated into self-diagnosis and fallback goals.

## Sources

- [Codex issue #16315: PowerPoint repair dialog and removed content](https://github.com/openai/codex/issues/16315)
- [OpenAI skills issue #241: slides output always needs repair](https://github.com/openai/skills/issues/241)
- [Codex issue #15427: pinned artifact runtime missing from public releases](https://github.com/openai/codex/issues/15427)
- [Codex issue #22468: presentations capability missing after workspace-dependency mismatch](https://github.com/openai/codex/issues/22468)
- [Codex issue #19701: plugins and marketplace tools missing](https://github.com/openai/codex/issues/19701)
- [OpenAI skills issue #367: users cannot find the slides skill](https://github.com/openai/skills/issues/367)
- [Codex issue #29873: PPTX preview differs by app entry point](https://github.com/openai/codex/issues/29873)
- [Codex issue #14079: Windows local file links rendered incorrectly](https://github.com/openai/codex/issues/14079)
- [Codex issue #32428: enabled computer-use plugin lacks its execution tool](https://github.com/openai/codex/issues/32428)
- [Reddit: PowerPoint skill is hard to find; artifact-tool missing; fine editing weaker](https://www.reddit.com/r/codex/comments/1tbn8f9/powerpoint_skill/)
- [Reddit: prompt sensitivity and poor PPTX quality](https://www.reddit.com/r/codex/comments/1roqqfx/help_with_openais_slides_skill/)
- [Reddit: minor errors, uncertain visual quality, and LibreOffice behavior](https://www.reddit.com/r/codex/comments/1snshls/has_anyone_tested_codex_powerpoint_excel_skill/)
- [Reddit: template, spacing, typography, color, and brand drift](https://www.reddit.com/r/codex/comments/1twfr18/working_system_for_creating_consistent_sales/)
- [Reddit: PPTX ingestion must retain tables, diagrams, and hierarchy](https://www.reddit.com/r/codex/comments/1sl217f/best_way_to_batch_convert_pptx_pdfs_to_markdown/)
- [Reddit: Google Slides output is visually weaker and lacks editing controls](https://www.reddit.com/r/codex/comments/1rzzeqi/google_slides_in_codex/)
- [Reddit: Codex claims to create PPTX but returns dead links](https://www.reddit.com/r/ProgrammerHumor/comments/1toora5/myexperiencewithcodexsofar/)
- [Adjacent editable-PPTX complaint: flattened slide images are not real editable slides](https://www.reddit.com/r/Markdown/comments/1snf9mu/is_there_anything_that_can_create_slides_that/)
- [Adjacent iteration complaint: small edits reintroduce spacing, margin, and overlap problems](https://www.reddit.com/r/ClaudeAI/comments/1tpc2ki/has_anyone_found_a_reliable_claude_workflow_for/)
- [Official PowerPoint app limitation: advanced template and font handling may be unsupported](https://chatgpt.com/apps/powerpoint/)
- [OpenAI Academy presentation expectations: editable text, notes, overflow, crowded-layout, and chart review](https://openai.com/academy/how-to-use-codex-for-everyday-work/)

## Deduplicated complaint inventory

| Complaint | Evidence pattern | Slidewright response | Goal |
| --- | --- | --- | --- |
| Skill/plugin is missing or hard to discover | Users cannot find Slides/Presentations; marketplace exposes only a subset | Ship a self-contained install path, discovery check, and exact remediation | C01, C02 |
| Presentation capability is absent despite entitlement or install | Workspace-dependency and plugin state mismatches hide Office tools | Preflight capabilities and provide a renderer-independent diagnostic/fallback path | C01, C02 |
| `@oai/artifact-tool` or pinned runtime cannot be found/downloaded | Reddit and GitHub report missing package/runtime and public-release 404 | Resolve supported runtimes dynamically; verify clean-host install; fail with a single actionable message | C03 |
| Hidden or surprising LibreOffice dependency | Users report it being installed or used unless challenged | Publish the renderer/platform matrix and never install or switch renderers silently | C20 |
| Generated PPTX requires repair or loses content | Two OpenAI repositories contain repair-dialog reports | Validate OOXML relationships/content types and open every release fixture in real PowerPoint without repair | C04 |
| Codex says a file exists but sends a dead/broken link | Public report of confident nonexistent/dead PPTX links; Windows path issue | Verify existence, size, ZIP integrity, and final link target before delivery | C05 |
| Valid PPTX looks unsupported or broken in Codex preview | Workspace picker and output links behave differently | Always emit PNG/PDF previews plus an external-open manifest and explain preview limitations | C06 |
| Output is flattened into slide images or HTML rather than editable PPTX | Users explicitly reject HTML/image output because they need editable PowerPoint | Require native text and semantic objects; forbid text-as-image fallback | C07, C09 |
| Not all shapes or structures survive conversion | Image-to-PPT and ingestion reports miss shapes, diagrams, tables, or hierarchy | Audit complete semantic coverage and named-object counts | C08, C17, C18 |
| Generic, unattractive, or competitor-inferior design | Users call output poor/crappy, prefer HTML, or rank other tools higher | Add blind design review, varied professional benchmarks, and first-open acceptance scoring | C13 |
| Too much prompt overrides the workflow; too little yields poor slides | Direct Codex slides-skill report | Provide a short stable input contract and adversarial prompt matrix | C12 |
| Minor layout errors remain | Reports mention minor errors; official workflow calls out overflow, crowded layouts, and unreadable charts | Automated overlap/overflow/contrast checks plus full-size review | C14 |
| Spacing, margins, wrapping, and formatting break after edits | Adjacent editable-deck reports describe repeated manual repair | Add mutation and fine-grained edit round trips with layout preservation | C15, C16 |
| Existing templates and brand systems drift | Users need masters, typography, colors, spacing, and reusable patterns preserved | Import and retain masters/layouts/placeholders/theme relationships; publish deviations | C10, C11 |
| Font/template handling is incomplete | Official PowerPoint app notes advanced font/template limitations | Detect substitution, embed/license fonts where allowed, and prove template behavior | C11 |
| Fine-grained editing is weaker than first-draft generation | Codex discussion says full structure works better than precise slide edits | Address objects by stable identity and test small edits without global restyling | C16 |
| Charts require external work or become unreadable/non-native | Users mention Excel workarounds; official guidance calls for chart readability checks | Add native chart/table/diagram fixtures with semantic edit tests | C18 |
| Existing PPTX ingestion strips text but loses visual meaning | Users request hierarchy, table, and diagram preservation | Build structural import with slide/master/object hierarchy and visual descriptions | C17 |
| Google Slides and other suite interop is weak | Users prefer HTML or request richer Google Slides APIs | Test import/open fidelity in Google Slides, Keynote, and Canva; publish a compatibility matrix | C19 |
| Direct PowerPoint automation can be unavailable despite enabled tooling | Computer-use execution tool can be missing | Keep generation independent of UI automation and offer an optional PowerPoint adapter with a CLI fallback | C21 |
| Community cannot tell whether quality was actually tested | Users explicitly ask for test and beauty reports | Publish fixtures, exact metrics, negative controls, and reproducible commands | C22 |

## Priority

P0: C03–C05, C07–C16. These determine whether the file is usable and trustworthy.

P1: C01–C02, C06, C17–C18, C20–C22. These determine adoption, portability, and professional workflow fit.

P2: C19. Cross-suite compatibility matters, but PowerPoint integrity remains the first release target.

This ledger is evidence, not proof of market frequency. A repeated complaint receives stronger confidence, but a single reproducible corruption or data-loss report is still a release blocker.
