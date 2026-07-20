# Slidewright submission package

This directory contains the committed, reproducible portion of the OpenAI Build Week submission. Generate the screenshot and evidence bundle after a successful release run:

```powershell
npm run release:check
npm run submission:prepare
```

Then complete the external fields in `metadata.json` and run:

```powershell
npm run submission:check
```

The full check is now green. The corrected narrated YouTube demo is public at 2:53, Devpost submission `1087402` is submitted at `https://devpost.com/software/slidewright`, the public repository is judge-accessible, and the primary Codex `/feedback` session plus verified GPT-5.6 statement are recorded. `publication-evidence.json` binds the external identifiers and authoritative publication confirmations.

Files:

- `publication-evidence.json` — public repository, YouTube, and Devpost identifiers plus the observed publication confirmations.

- `SUBMISSION_COPY.md` — copy-ready category, tagline, descriptions, technical story, and Codex contribution statement.
- `DEMO_SCRIPT.md` — a 2:45 shot list and voiceover.
- `TESTING.md` — judge quick path and complete evidence path.
- `ASSET_MANIFEST.md` — screenshot purpose, source, and caption.
- `metadata.json` — external release facts that must be filled with verified values.
- `check-submission.mjs` — binary local/external readiness check.
