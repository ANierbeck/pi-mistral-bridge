#!/usr/bin/env node
// Lint gate: ESLint over the code scope (src/, scripts/, test/).
// A thin wrapper around the eslint binary so `npm run lint` does not depend
// on a PATH-resolved eslint. Extra args are passed through (e.g. `--fix`).
//
// Usage: node scripts/lint.ts [--fix]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// eslint's exports map does not expose ./bin/eslint.js; go via package.json.
const eslintBin = join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js');

const result = spawnSync(
  process.execPath,
  [eslintBin, 'src/', 'scripts/', 'test/', ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
