#!/usr/bin/env node
import { parseCommand, USAGE } from "./commands.js";

const command = parseCommand(process.argv.slice(2));
if (command.kind === "help") {
  process.stdout.write(`${USAGE}\n`);
} else {
  process.stderr.write(`cue ${command.kind}: not implemented yet (scaffold)\n`);
  process.exitCode = 2;
}
