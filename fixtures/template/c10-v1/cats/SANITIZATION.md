# Cats fixture sanitation contract

The tracked `template.pptx` is a deterministic derivative of the reviewed
upstream binary with SHA-256
`b0b5eea81ad7d8a47c5cb98f04e286d0b9bbe6177b15b57003618e1165dc77ba`.
The upstream binary is vendored as `upstream-template.pptx` and is part of the
public implementation closure.

The sanitizer fails closed unless the input hash and expected OOXML fragments
match. It makes only these content changes:

1. Replaces the creator and last-modifier values in `docProps/core.xml` with
   `Slidewright Fixture`.
2. Clears the organization value in `docProps/app.xml`.
3. Replaces personal change-tracking names, user IDs, and client IDs in
   `ppt/changesInfos/changesInfo1.xml` and `ppt/revisionInfo.xml` with fixed
   fixture values.
4. Deletes one reviewed personal thank-you/contact text shape from each of
   slides 31, 32, and 33.

The artwork credit text and external source URL on each of slides 31-33 are in
separate shapes and must remain present. All 138 source ZIP entries remain in
their original order. The sanitizer writes stored ZIP entries with a fixed
timestamp, so package metadata does not depend on the machine clock.

The curated output must have SHA-256
`b996327ede97791a8e54cde0983f04880bdddd68b28901ff129146d59362547c`.
