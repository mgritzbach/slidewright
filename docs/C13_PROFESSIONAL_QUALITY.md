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

The generated scorecard distinguishes three states:

1. `preparationValid`: the corpus and blinded packet are technically valid;
2. `externalEvidenceComplete`: qualifying human responses satisfy the sample
   boundaries;
3. `c13Satisfied`: every frozen human threshold passes.

An agent-authored response, an AI reviewer, an implementation-team member, a
response that lacks the blindness attestations, or a response containing direct
personal data is rejected and cannot advance C13.
