# Demo and submission plan

The release-ready 2:45 shot list, exact voiceover, recording checks, screenshot manifest, and judge instructions live in the reproducible [submission package](../submission/README.md):

- [public demo script](../submission/DEMO_SCRIPT.md)
- [judge testing instructions](../submission/TESTING.md)
- [submission asset manifest](../submission/ASSET_MANIFEST.md)
- [copy-ready submission text](../submission/SUBMISSION_COPY.md)

Run `npm run submission:prepare` after the full release check to assemble the six screenshot assets and their SHA-256 manifest under `outputs/submission/`. Run `npm run submission:check` only after the GitHub URL, public YouTube video, audio/duration confirmation, `/feedback` session ID, GPT-5.6 usage statement, Devpost participation, and judge access are verified in `submission/metadata.json`.

G09 remains `0` until that full check passes. Local drafts or placeholders do not count as submission evidence.
