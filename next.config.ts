import type { NextConfig } from 'next';

const config: NextConfig = {
  serverExternalPackages: ['pg', '@prisma/adapter-pg'],
  poweredByHeader: false,
  // The dashboard has no images. Skipping the optimizer keeps sharp (and its
  // semver dependency) out of the server bundle, where Netlify's file tracer
  // fails on a pnpm-linked semver/preload.js.
  images: { unoptimized: true },
  outputFileTracingExcludes: { '*': ['**/node_modules/sharp/**', '**/node_modules/@img/**', '**/node_modules/semver/**'] },
};

export default config;
