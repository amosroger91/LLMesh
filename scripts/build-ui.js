import { build } from 'esbuild';
import { readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
const output = resolve('src/ui/assets'); mkdirSync(output, { recursive: true });
for (const entry of readdirSync(output, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith('.js')) unlinkSync(join(output, entry.name));
await build({ entryPoints: { app: 'src/ui/app.js' }, bundle: true, splitting: true, format: 'esm', platform: 'browser',
  outdir: 'src/ui/assets', target: 'chrome136', sourcemap: false, minify: true, logLevel: 'info' });
