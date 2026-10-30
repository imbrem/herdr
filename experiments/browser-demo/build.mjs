import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gatewayUrl } from './src/gateway-client.js';

// Public runtime configuration is separate from static assets and contains no
// keys/tokens. A different gateway still needs explicit browser-origin policy.
const args = process.argv.slice(2);
let gateway = null;
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm run build -- [--gateway https://gateway.example/api/]');
  console.log('Default: same-origin gateway. Output: dist/ (static assets + config.json).');
  process.exit(0);
}
if (args.length) {
  if (args.length !== 2 || args[0] !== '--gateway') throw new Error('Expected --gateway HTTPS_BASE_URL; see --help.');
  gateway = gatewayUrl(args[1], args[1]).href;
}
const output = new URL('./dist/', import.meta.url);
await mkdir(output, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./src/client.js', import.meta.url))],
  bundle: true, format: 'esm', minify: true, sourcemap: false,
  outfile: fileURLToPath(new URL('client.js', output)),
  target: ['chrome120', 'firefox128', 'safari18'],
});
await copyFile(new URL('./src/index.html', import.meta.url), new URL('index.html', output));
await writeFile(new URL('config.json', output), JSON.stringify({ gateway }) + '\n');
