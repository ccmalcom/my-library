# Backend benchmarks (Python/Railway vs Node/Vercel)

Methodology: `scripts/benchmark.mjs` hits each ported route 30× per backend with a
real user JWT and real data, recording cold (first request of the run) and warm
p50/p95 **client-observed** latency. The Node backend's `Server-Timing` header
(admin debug mode, wave 0) is captured for span-level diagnosis.

**Standing caveat:** this compares FastAPI-on-Railway-container vs
Node-on-Vercel-serverless — deployment shape included, not language alone. A true
Vercel cold start cannot be forced on demand; "cold" is best-effort.

## Wave 1 — read-only routes

_Results pending: run the harness (Task 14 / wave-1 verification) and paste the
table here, with the run date and both deployment URLs' commit SHAs._
