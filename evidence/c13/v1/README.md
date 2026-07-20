# C13 external review responses

This directory is intentionally empty until real independent human responses
are collected. Import completed responses with:

```powershell
node scripts/import-professional-quality-response.mjs --input C:\path\to\response.json
```

Do not manually place raw responses under `responses/`. The importer validates
the blinded assignment and strict schema, removes the participant-supplied
pseudonym in favor of a stable one-way id, and writes only qualifying sanitized
JSON. Never store names, email addresses, employers, or free-form personal data.

Agent, model, bot, implementation-team, unblinded, or incomplete responses are
rejected by `scripts/verify-professional-quality-evidence.mjs` and never count
toward C13.
