# Risk register

| Risk | Likelihood | Impact | Mitigation | Release evidence |
| --- | --- | --- | --- | --- |
| Text measurement differs between compiler and PowerPoint | Medium | High | Conservative glyph metrics, renderer layout export, full-size visual QA, golden boundary fixtures | No overflow in demo and boundary suite |
| Artifact runtime is unavailable outside Codex | Medium | High | Runtime discovery script, prebuilt judge artifact, renderer adapter boundary, documented supported platforms | Fresh judge-path test |
| “Editable” output still flattens some objects | Low | High | OOXML inspection of text and semantic object types | Audit JSON and manual PowerPoint edit |
| Source-template styling drifts | High | High | Complete template audit, inherited-object edits, golden-file comparison, deviation log | G10 evidence |
| AI produces content too dense for the design | High | Medium | Compiler quality floor and actionable failure instead of silent shrinking | Negative fixture demo |
| Project looks like a thin prompt wrapper | Medium | High | Deterministic compiler, stable diagnostics, renderer, auditor, and evaluation dataset | Code walkthrough and tests |
| Demo exceeds three minutes or hides Codex/GPT use | Medium | High | Timed script, explicit Codex segment, captions, rehearsal | Final 2:30–2:50 video |
| Third-party templates/assets create IP issues | Low | High | Use owned, licensed, public-domain, or synthetic fixtures and document provenance | License/source register |
| Deadline risk | Medium | High | Release candidate July 20 and submit by noon Pacific July 21 | Submitted Devpost receipt |
