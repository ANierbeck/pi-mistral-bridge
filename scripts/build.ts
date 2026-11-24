#!/usr/bin/env node
// Build: bundle the extension entry point to dist/index.js with esbuild.
// Everything except Node builtins and the HOST-PROVIDED packages is bundled
// (`platform: 'node'` marks the builtins external automatically). Pi supplies
// @earendil-works/pi-ai, @earendil-works/pi-coding-agent, @earendil-works/pi-tui
// and typebox to extensions (pi-coding-agent docs/packages.md, "Declare
// dependencies"): they are declared as peerDependencies "*" in package.json and
// must stay EXTERNAL here — a bundled physical copy bypasses Pi's extension
// module mapping and creates duplicate classes, registries and init work.
// test/bundle.test.ts and the CI build step assert they are not inlined.
// The ACP and MCP SDKs (regular dependencies) do bundle cleanly as ESM for
// platform node.
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
  external: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-ai/*',
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-coding-agent/*',
    '@earendil-works/pi-tui',
    '@earendil-works/pi-tui/*',
    'typebox',
    'typebox/*',
  ],
});
