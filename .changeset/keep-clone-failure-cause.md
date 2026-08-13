---
'@idle-runner/worker': patch
---

Keep the original failure as `cause` when a payload cannot be sent, and document two defaults that the README stated more confidently than the code did.

- A `push` whose payload fails to clone rejects with the same explanatory message as before, now carrying the platform's own error — usually a `DataCloneError` naming the value it choked on — as `cause`.
- The pool's `size` default is `hardwareConcurrency - 1` capped at 4, and 2 where `navigator.hardwareConcurrency` is not reported; the fallback was undocumented.
- "Outside a worker realm" now says which realm is meant: a Web Worker global. Node's `worker_threads` communicates over `parentPort`, so `defineWorkerTasks()` there warns and registers nothing.
