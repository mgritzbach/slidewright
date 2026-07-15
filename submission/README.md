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

The full check remains red until the repository is accessible to judges, the public YouTube demo is under three minutes with audio, the primary Codex `/feedback` session ID is recorded, and Devpost/judge access are confirmed. This is intentional: G09 cannot be marked complete from local drafts.

Files:

- `SUBMISSION_COPY.md` — copy-ready category, tagline, descriptions, technical story, and Codex contribution statement.
- `DEMO_SCRIPT.md` — a 2:45 shot list and voiceover.
- `TESTING.md` — judge quick path and complete evidence path.
- `ASSET_MANIFEST.md` — screenshot purpose, source, and caption.
- `metadata.json` — external release facts that must be filled with verified values.
- `check-submission.mjs` — binary local/external readiness check.
