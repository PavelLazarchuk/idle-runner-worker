---
'@idle-runner/worker': minor
---

Worker pooling and automatic restart after a crash.

- New `createWorkerPool(factory, options?)`: several workers behind the same `WorkerRunner` interface, each call routed to the least busy one, workers still created lazily. `size` defaults to `hardwareConcurrency - 1`, capped at 4.
- `createWorkerRunner` accepts `autoRestart` (and `maxRestarts`, default 3): a worker that dies before it ever answers is terminated and replaced on the next push, instead of parking the runner as crashed. Calls in flight still reject and nothing is retried automatically.
