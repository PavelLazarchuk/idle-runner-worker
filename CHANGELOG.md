# @idle-runner/worker

## 1.0.2

### Patch Changes

- 1908ca3: Add a `size-limit` budget and enforce it in CI. `npm run size` measures the built ESM and CJS bundles (minified + brotli) and fails if they exceed the limits in `.size-limit.json` — currently 2.5 kB for the full entry point, plus separate entries for the main-thread half (`createWorkerRunner`) and the worker half (`defineWorkerTasks`, `transfer`), since neither side should ever pull in the other. Tooling only; the published bundle is unchanged.

## 1.0.1

### Patch Changes

- d5cf3a7: Remove the "Not in v1" section from the README. The scope decisions it described — no worker pool, no priorities, no automatic restart after a crash, no `timeout` — still stand; they just don't need a dedicated section to remain true.

## 1.0.0

### Major Changes

- Initial release.
- TypeScript support.
- Documentation.
