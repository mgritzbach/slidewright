#!/usr/bin/env node
import { main } from "../../../plugins/slidewright/skills/slidewright/scripts/slidewright.mjs";

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
