# @idle-runner/worker

## 1.1.0

### Minor Changes

- 5861ed7: Worker pooling and automatic restart after a crash.

    - New `createWorkerPool(factory, options?)`: several workers behind the same `WorkerRunner` interface, each call routed to the least busy one, workers still created lazily. `size` defaults to `hardwareConcurrency - 1`, capped at 4.
    - `createWorkerRunner` accepts `autoRestart` (and `maxRestarts`, default 3): a worker that dies before it ever answers is terminated and replaced on the next push, instead of parking the runner as crashed. Calls in flight still reject and nothing is retried automatically.

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
