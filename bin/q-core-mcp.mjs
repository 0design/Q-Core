#!/usr/bin/env node
import { serveMcp } from '../src/mcp.mjs';
import { guardedStreamWrite } from '../src/persistence.mjs';

const usage = 'Usage: q-core-mcp <manifest.yaml>\nRun the local MCP approval server over stdio. The manifest is fixed at startup.\n';
const args = process.argv.slice(2);
try {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) guardedStreamWrite(process.stdout, usage);
  else {
    if (args.length !== 1 || args[0].startsWith('-')) throw new Error(usage.trim());
    await serveMcp({ manifestFile: args[0] });
  }
} catch (error) {
  guardedStreamWrite(process.stderr, `${error.code ? error.code + ': ' : ''}${error.message}\n`);
  process.exitCode = 1;
}
