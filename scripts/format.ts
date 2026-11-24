#!/usr/bin/env node
// Format gate: Prettier over the code scope (see .prettierignore for why the
// rest of the tree is deliberately not formatted).
//
// Usage: node scripts/format.ts           -> prettier --check (npm run format:check)
//        node scripts/format.ts --write   -> reformat in place  (npm run format)
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const prettierBin = require.resolve('prettier/bin/prettier.cjs');

/** The format scope: the code and the root configs, nothing else. */
const FORMAT_INPUTS = [
  'src/',
  'scripts/',
  'test/',
  'eslint.config.js',
  'vitest.config.ts',
  'package.json',
  'tsconfig.json',
] as const;

const write = process.argv.includes('--write');
const result = spawnSync(
  process.execPath,
  [prettierBin, write ? '--write' : '--check', ...FORMAT_INPUTS],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
