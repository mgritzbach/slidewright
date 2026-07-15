# Demo and submission plan

## Three-minute narrative

**0:00–0:20 — The pain.** Show an AI-generated slide with uneven margins, clipped copy, and arbitrary font sizes. State that the hard part is not generating a screenshot; it is delivering a file another person can edit.

**0:20–0:45 — The input.** In Codex, invoke Slidewright on a short idea/specification. Show the semantic JSON rather than manual coordinates.

**0:45–1:20 — The compiler.** Run compile and lint. Highlight the exact 64 px frame, symmetric component padding, and autosizer choosing the largest fitting size from an integer point scale.

**1:20–1:55 — The artifact.** Open the output in PowerPoint. Edit a title, toggle one phrase from bold to regular, move a shape, and show that nothing is flattened.

**1:55–2:25 — The proof.** Show the rendered previews and OOXML audit. Demonstrate a deliberately over-dense fixture failing with a useful recommendation instead of silently producing tiny text.

**2:25–2:50 — The impact.** Compare cleanup actions and describe the path from the vertical slice to template-preserving enterprise workflows.

**2:50–3:00 — Close.** “Slidewright makes the editable artifact—not the screenshot—the product.”

## Judge test path

1. Install or open the repo-local Slidewright plugin.
2. Start a new Codex task.
3. Run the included demo prompt or the `npm run demo` pipeline.
4. Open `outputs/demo/slidewright-demo.pptx` in PowerPoint.
5. Edit the mixed-emphasis title and inspect `outputs/demo/ooxml-audit.json`.

Target total time: under five minutes, with a prebuilt demo artifact included in the release if distribution rules permit.

## Submission assets to prepare

- 16:9 hero image showing prompt → compiler → editable PPTX.
- Three screenshots: Codex workflow, PowerPoint edit, evidence report.
- Public demo video and transcript/captions.
- Short and long project descriptions.
- Installation/testing instructions copied from the release tag.
- Architecture diagram and measurement table.
- `/feedback` session ID and dated commit history.
