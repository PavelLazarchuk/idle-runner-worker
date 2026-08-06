---
'@idle-runner/worker': patch
---

Add a `size-limit` budget and enforce it in CI. `npm run size` measures the built ESM and CJS bundles (minified + brotli) and fails if they exceed the limits in `.size-limit.json` — currently 2.5 kB for the full entry point, plus separate entries for the main-thread half (`createWorkerRunner`) and the worker half (`defineWorkerTasks`, `transfer`), since neither side should ever pull in the other. Tooling only; the published bundle is unchanged.
