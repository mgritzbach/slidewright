# Native grouping

The artifact runtime may export otherwise editable shapes with `a:spLocks noGrp="1"`. For objects declared groupable, remove that lock during a deterministic post-export normalization step.

For pre-grouped output, wrap stable named members in `p:grpSp`, preserve member z-order, and set group `off/ext` and `chOff/chExt` to the same union bounds. Do not set `noUngrp`.

Audit the normalized final deck for the expected group name, members, locks, and native text. When PowerPoint is available, ungroup, regroup, save, reopen, and verify child count plus native text survival.
