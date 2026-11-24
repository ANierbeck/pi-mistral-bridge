#!/usr/bin/env node
// Build: bundle the extension entry point to dist/index.js with esbuild.
// Everything except Node builtins is bundled (`platform: 'node'` marks the
// builtins external automatically), so the shipped pi manifest entry
// ./dist/index.js is self-contained and consumers need no runtime
// installation of the SDKs. The spike (spikes/) drives
// @agentclientprotocol/sdk and @modelcontextprotocol/sdk (which pulls in
// zod) over stdio and HTTP — all bundle cleanly as ESM for platform node.
import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
});
