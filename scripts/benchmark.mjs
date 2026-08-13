#!/usr/bin/env node
/**
 * Wave benchmark: hits each ported route N times on both backends, reports
 * cold (first request) and warm p50/p95 client-observed latency, plus the
 * Node side's Server-Timing header (debug mode) when present.
 *
 * Usage:
 *   node scripts/benchmark.mjs \
 *     --python https://<railway-app> \
 *     --node https://<vercel-deploy> \
 *     --token "$SUPABASE_JWT" \
 *     [--reps 30] [--bypass-secret "$VERCEL_BYPASS"]
 *
 * The token is read from argv and used only in memory. --bypass-secret sets
 * x-vercel-protection-bypass for SSO-protected preview deployments.
 * Caveat (by design): this compares FastAPI-on-Railway-container vs
 * Node-on-Vercel-serverless — deployment shape included, not language alone.
 */

const ROUTES = [
  // [python path, node path]
  ['/stats', '/api/stats'],
  ['/books', '/api/books'],
  ['/books?rated_only=true', '/api/books?rated_only=true'],
  ['/profile', '/api/profile'],
  ['/profile/status', '/api/profile/status'],
  ['/profile/subjects', '/api/profile/subjects'],
  ['/profile/highlights', '/api/profile/highlights'],
  ['/profile/archetype', '/api/profile/archetype'],
  ['/recommendations', '/api/recommendations'],
  ['/recommendations/rejected', '/api/recommendations/rejected'],
  ['/settings/api-key/status', '/api/settings/api-key/status'],
  ['/settings/profile', '/api/settings/profile'],
  ['/settings/usage', '/api/settings/usage'],
  ['/directive', '/api/directive'],
];

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const pythonBase = arg('python');
const nodeBase = arg('node');
const token = arg('token');
const reps = parseInt(arg('reps', '30'), 10);
const bypass = arg('bypass-secret');

if (!pythonBase || !nodeBase || !token) {
  console.error('required: --python <base> --node <base> --token <jwt>');
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}` };
if (bypass) headers['x-vercel-protection-bypass'] = bypass;

function pct(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function timeOne(base, path) {
  const t0 = performance.now();
  const res = await fetch(base + path, { headers });
  await res.text();
  return {
    ms: performance.now() - t0,
    status: res.status,
    serverTiming: res.headers.get('server-timing'),
  };
}

async function bench(base, path) {
  const cold = await timeOne(base, path);
  const warm = [];
  let lastServerTiming = cold.serverTiming;
  for (let i = 0; i < reps; i++) {
    const r = await timeOne(base, path);
    warm.push(r.ms);
    if (r.serverTiming) lastServerTiming = r.serverTiming;
    if (r.status >= 500) console.error(`  !! ${base}${path} -> ${r.status}`);
  }
  warm.sort((a, b) => a - b);
  return {
    status: cold.status,
    coldMs: cold.ms,
    p50: pct(warm, 50),
    p95: pct(warm, 95),
    serverTiming: lastServerTiming,
  };
}

const fmt = (x) => x.toFixed(0);

console.log(`# Benchmark run ${new Date().toISOString()} (reps=${reps})`);
console.log('');
console.log('| route | py cold | py p50 | py p95 | node cold | node p50 | node p95 | node Server-Timing |');
console.log('|---|---|---|---|---|---|---|---|');
for (const [pyPath, nodePath] of ROUTES) {
  const py = await bench(pythonBase, pyPath);
  const nd = await bench(nodeBase, nodePath);
  console.log(
    `| \`${pyPath}\` | ${fmt(py.coldMs)} | ${fmt(py.p50)} | ${fmt(py.p95)} | ` +
      `${fmt(nd.coldMs)} | ${fmt(nd.p50)} | ${fmt(nd.p95)} | ${nd.serverTiming ?? ''} |`
  );
}
console.log('');
console.log(
  'Caveat: FastAPI-on-Railway-container vs Node-on-Vercel-serverless — deployment shape included, not language alone. "cold" = first request of this run (a true Vercel cold start cannot be forced on demand).'
);
