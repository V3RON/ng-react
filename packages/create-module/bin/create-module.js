#!/usr/bin/env node
// The `create-module` binary. Deliberately three lines of logic: everything
// testable lives in `../src/cli.js`, which returns an exit code and the text
// to print instead of touching the process.

import process from 'node:process';
import { run } from '../src/cli.js';

const result = run(process.argv.slice(2));
if (result.stdout !== '') {
  process.stdout.write(result.stdout);
}
if (result.stderr !== '') {
  process.stderr.write(result.stderr);
}
process.exitCode = result.code;
