/**
 * Bundle the Netlify functions in netlify/src into netlify/functions.
 *
 * The app code uses the "@/" import alias and Prisma's generated client, which
 * Netlify's own function bundler does not resolve reliably, so the bundling is
 * done here with esbuild and Netlify just deploys the output.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
rmSync(`${root}netlify/functions`, { recursive: true, force: true });

await build({
  entryPoints: {
    'worker-background': `${root}netlify/src/worker-background.ts`,
    scheduler: `${root}netlify/src/scheduler.ts`,
  },
  outdir: `${root}netlify/functions`,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  alias: { '@': `${root}src` },
  // Bundled ESM still needs require() for some CommonJS dependencies (pg).
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
});
