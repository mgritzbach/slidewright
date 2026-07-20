# C13 professional-quality evidence

C13 is deliberately a human-outcome gate. Machine lint, OOXML audits, pixel
comparisons, PowerPoint round trips, internal full-size review, and agent review
can prepare the study and reject technical defects, but none of them proves that
professional users accept a deck on first open or can clean it up quickly.

The frozen `c13-v1` contract therefore requires:

- at least 21 hash-distinct slide designs drawn from at least four licensed
  source families;
- one independent human expert reviewing all 21 designs blind;
- five independent human target users, each reviewing five assigned designs;
- all 21 designs covered by the user study;
- at least 80% expert and aggregate user first-open acceptance;
- at least 60% first-open acceptance for every user;
- expert dimension scores averaging at least 4/5, with no individual score
  below 3/5;
- median cleanup time at most five minutes, 90th percentile at most ten
  minutes, and median repair actions at most two.

`npm run professional-quality:prepare` creates a blinded reviewer packet and a
separate administrator key from the current C10 licensed-template matrix. The
packet hides fixture names, source identities, conditions, and slide lineage.
The administrator key must never be provided to a reviewer before submission.
Five deterministic files under `reviewer-packet/target-users/` route each user
to exactly five candidate codes, opaque deck filenames, and slide numbers. They
contain no fixture ids, source paths, hashes, or design identities. Give a user
only the routing file whose assignment id they will submit.

The packet's `RUBRIC.md` anchors every expert dimension from 1 (critical
failure) through 5 (exceptional) and defines first-open acceptance as requiring
no edit. Target-user timing starts when the assigned slide appears and stops
when the participant would present it professionally.

The generated scorecard distinguishes three states:

1. `preparationValid`: the corpus and blinded packet are technically valid;
2. `externalEvidenceComplete`: qualifying human responses satisfy the sample
   boundaries;
3. `c13Satisfied`: every frozen human threshold passes.

An agent-authored response, an AI reviewer, an implementation-team member, a
response that lacks the blindness attestations, or a response containing direct
personal data is rejected and cannot advance C13.

Import each completed response through the sanitizer; never copy raw responses
into evidence manually:

```powershell
node scripts/import-professional-quality-response.mjs --input C:\path\to\response.json
```

The importer validates the exact blinded assignment, strict response fields,
human and independence attestations, score/timing ranges, and privacy rules
before writing. It replaces the participant-supplied pseudonym with a stable
one-way identifier and refuses conflicting duplicate evidence. After importing
all responses, rerun `npm run professional-quality:prepare` and then
`npm run professional-quality:require-complete`.
