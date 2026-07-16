# Direct user feedback ledger

This register converts observed slide failures into release requirements. It supplements the public complaint ledger; each item remains uncredited until the binary goal in `GOAL_STATUS.md` has its named proof.

| Observed failure | Required behavior | Goal |
| --- | --- | --- |
| A headline overlapped body text | Any visible text-box intersection is a build failure, even when generic overlap is otherwise declared | G24 |
| A headline box stopped early despite unused safe width | Use the full safe width unless the layout declares a center or two-thirds split that reserves the adjacent region | G25 |
| Wrapped title text extended below its white/background band | Grow the text-backed region with symmetric padding or relayout the slide before export | G26 |
| Seventeen topics were compressed into 27 slides without clear structural coverage | Require a coverage manifest and an explicit divider plus substantive slide for every declared topic | G27 |
| Empty paragraphs in inherited bullet layouts created blank bullets and pushed body text into headlines | Strip or reject empty bullet paragraphs before fitting; they must not consume layout budget or create collisions | G28 |
| Text inherited under source screenshots or other reserved regions | Treat screenshot/media bounds as occupied and reject any undeclared text intersection | G24 |
| Dense divider titles needed deeper title zones and lower subtitles | Compute divider geometry from realized title height and preserve minimum vertical separation | G24, G26 |

Source: direct feedback and the subsequent failure analysis in the Codex task titled `Locate event info`, read on 2026-07-16.