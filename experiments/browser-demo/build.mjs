import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await build({ entryPoints: [new URL('./src/client.js', import.meta.url).pathname], bundle: true,
  format: 'esm', outfile: new URL('./dist/client.js', import.meta.url).pathname,
  minify: true, sourcemap: false, target: ['chrome120', 'firefox128', 'safari18'] });
await copyFile(new URL('./src/index.html', import.meta.url), new URL('./dist/index.html', import.meta.url));
