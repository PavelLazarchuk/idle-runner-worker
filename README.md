# @idle-runner/worker

[![npm version](https://img.shields.io/npm/v/@idle-runner/worker.svg)](https://www.npmjs.com/package/@idle-runner/worker)
[![npm downloads](https://img.shields.io/npm/dm/@idle-runner/worker.svg)](https://www.npmjs.com/package/@idle-runner/worker)

Send heavy work to a worker and `await` the result. ~1.2kb on the main thread, ~1.4kb in the worker, zero dependencies.

`@idle-runner/core` defers work **on** the main thread — a 200ms computation is still 200ms of main thread, just chopped up. This package moves it **off** the main thread entirely: a named task registry inside the worker, one promise per call on the outside, plus the two things hand-rolled `postMessage` code always ends up missing — cancellation and transferables.

There is no dependency between the two packages. Use whichever the work calls for.

## Install

```sh
npm install @idle-runner/worker
```

## Quick start

The worker declares what it can do:

```ts
// worker.ts
import { defineWorkerTasks } from '@idle-runner/worker';

export const tasks = {
    buildIndex: (products: Product[]) => buildSearchIndex(products), // heavy and synchronous
    parse: (csv: string) => parseCsv(csv),
};

defineWorkerTasks(tasks);
```

The main thread calls it by name:

```ts
// app.ts
import { createWorkerRunner } from '@idle-runner/worker';
import type { tasks } from './worker';

const runner = createWorkerRunner<typeof tasks>(
    () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
);

const index = await runner.push('buildIndex', products);
```

`import type` is erased at compile time, so importing the worker module for its types puts nothing worker-side in your page bundle — but it gives `push` the real payload and result types, per task name.

The worker itself is created on the **first** `push`, not when the runner is made. A runner nobody uses costs nothing, and a module that is never called is safe to import on a server.

### Chunked work: `yield` in the worker

A worker has no rendering to block, so a task starts the moment the worker is free — there is no idle budget and nothing to wait for. `yield` still has a job, though: it is where a cancellation can land.

```ts
defineWorkerTasks({
    downscale: function* (photos: Photo[]) {
        const thumbs: Thumbnail[] = [];

        for (const photo of photos) {
            thumbs.push(downscale(photo));
            yield; // an abort sent from the page can take effect here
        }

        return thumbs;
    },
});
```

The task resolves with the generator's `return` value; what it yields is never a result. Steps run back-to-back and control goes back to the worker's event loop about every 16ms — often enough that an abort is picked up promptly, rarely enough that a generator yielding 100k times does not become 100k macrotasks.

A task may also be `async`; the promise is awaited and the call resolves with its value.

### Cancelling

```ts
const controller = new AbortController();
const thumbs = runner.push('downscale', photos, { signal: controller.signal });

controller.abort(); // `thumbs` rejects with AbortError right now
```

The rejection does **not** wait for a round trip. The caller is answered immediately and the worker is told in parallel, because a worker in the middle of a synchronous task is not reading messages at all — waiting for it to acknowledge would mean waiting for the very work you are trying to cancel.

What the worker does with the abort depends on the task:

| the call is…                     | effect in the worker                                                |
| -------------------------------- | ------------------------------------------------------------------- |
| still queued behind another task | dropped; never starts                                               |
| a generator, mid-flight          | stops at its next `yield`, and its `finally` blocks run             |
| a plain function, mid-flight     | runs to the end — nothing can interrupt it; the result is discarded |
| an `async` task, mid-flight      | same: the promise settles, the result is discarded                  |

That last row is not a limitation of this library but of the platform: a synchronous function owns its thread until it returns. Chunk it with `yield` if you need it to be cancellable.

### Transferables

Binary payloads should be handed over, not copied — in both directions.

```ts
// main thread: the buffer is detached here and adopted there, with no copy
const stats = await runner.push('analyse', buffer, { transfer: [buffer] });
```

```ts
// worker: return by transfer instead of by copy
import { defineWorkerTasks, transfer } from '@idle-runner/worker';

defineWorkerTasks({
    decode: (bytes: ArrayBuffer) => {
        const pixels = heavyDecode(bytes);

        return transfer(pixels, [pixels.buffer]);
    },
});
```

`transfer()` is typed as the value it wraps, so the task's return type stays the real result type and `push` resolves with exactly that. The consequence: return it straight from the task — do not read the wrapper or reuse it.

Reading a transferred object afterwards throws, on either side. That is the point: there is only one owner.

## Errors

A task that throws rejects its call, and nothing else — neighbouring calls are unaffected and the worker keeps serving:

```ts
try {
    await runner.push('parse', csv);
} catch (error) {
    // error.name === 'SyntaxError', error.message and error.stack all survive,
    // and the stack points into the worker script, where the throw happened.
}
```

Errors are taken apart and rebuilt across the wire rather than structured-cloned. Cloning an `Error` drops its subclass and throws outright if the instance carries a non-cloneable property — losing the failure entirely, which is the one thing an error channel may not do. Name, message and stack survive; a thrown non-`Error` value is passed through as-is.

Some failures belong to the worker rather than to a task. Each one rejects **everything in flight** rather than leaving promises pending forever, because none of them can be attributed to a single call:

- a worker that never started — an uncaught error before it has answered anything, most often a script that failed to load;
- a reply that could not be deserialised;
- a payload the worker could not deserialise, which never reaches a task and so can never be answered by id.

Only the first is fatal. A worker that has never spoken is assumed to be dead — a `push` would post into a void and wait for a reply that cannot come — so the runner is marked as crashed and **later pushes reject too**, with the original failure and a note about how to recover. The other two say nothing about the health of the thread, so the runner keeps using it.

An uncaught error in a worker that **has** already answered a call is a different thing: the worker is demonstrably alive, and the throw belongs to something else running in it — a stray timer, an unrelated listener, a library with an opinion. Workers survive uncaught errors, so calls in flight still get their answers and the runner keeps serving. The error is reported through `onError` if you passed one; the browser logs it either way.

Recovery from a crash is deliberately manual in v1: `terminate()`, then push again to get a fresh worker.

For calls nobody awaited — and for a non-fatal error inside the worker, which belongs to no call at all — pass `onError` when creating the runner. Aborts are never reported through it.

## When to use this — and when not to

**Good fits** — CPU-bound work with a serialisable payload and a serialisable result:

- parsing and transforming large payloads (CSV, JSON, protobuf)
- building search indexes, diffs, layouts, aggregations
- image, audio and video processing on `ArrayBuffer`s
- crypto, compression, WASM number-crunching

**Bad fits — use something else:**

- ❌ **Work that touches the DOM.** There is no `document` in a worker. Compute in the worker, apply on the main thread.
- ❌ **Work whose payload dwarfs the work.** Structured clone is not free; shipping 50MB to save 2ms of computation is a net loss. Transferables help when the data is binary and you no longer need it locally.
- ❌ **Non-urgent work that must stay on the main thread** (touching DOM, waiting on layout) — that is [`@idle-runner/core`](https://github.com/PavelLazarchuk/idle-runner-core)'s job.
- ❌ **Async job concurrency control** (rate-limiting N fetches) — that's [`p-queue`](https://github.com/sindresorhus/p-queue)'s job.

## Does it actually work?

Tested in real browsers rather than asserted, in [`test/browser/worker.browser.test.ts`](test/browser/worker.browser.test.ts) — real `Worker`, real structured clone, real transfers — with a **negative control**, because a benchmark that only shows the good number proves nothing:

| workload                                           | long tasks (≥50ms) on the main thread |
| -------------------------------------------------- | ------------------------------------- |
| 180ms of work run on the main thread (the control) | at least one — as it must             |
| the same 180ms of work inside the worker           | none                                  |

A companion test keeps a `requestAnimationFrame` loop running while the worker chews through 150ms of work and asserts that frames keep arriving. The transfer tests assert the buffer is **detached** on the sending side in both directions — the only observable proof that nothing was copied.

Everything runs on **Chromium and WebKit** in CI. The two long-task assertions are skipped on WebKit, which does not implement the `longtask` entry type; every other test runs on both.

## How it works

One worker per runner, one message per call, and nothing clever:

| direction | message                    | meaning                      |
| --------- | -------------------------- | ---------------------------- |
| → worker  | `{ id, name, payload }`    | call this task               |
| → worker  | `{ id, op: 'abort' }`      | drop this call if you can    |
| → page    | `{ id, ok: true, value }`  | it resolved                  |
| → page    | `{ id, ok: false, error }` | it threw                     |
| → page    | `{ op: 'undeliverable' }`  | a payload arrived unreadable |

Each call gets a numeric id and an entry in a `Map<id, {resolve, reject}>`; replies are matched by id, and a reply for an id that is no longer there — cancelled, cleared — is dropped. A message needs an `ok` to count as a reply at all, so a worker script that posts messages of its own alongside the task protocol cannot settle somebody's call by reusing a number.

Inside the worker, calls run **one at a time** through a FIFO queue. That queue is a correctness requirement rather than a policy choice: a generator task hands the event loop back between slices, so without it the message for a second call would start executing nested inside the first, interleaving two tasks that each believe they own the thread.

Both halves ship from one entry point. They share nothing at runtime and the package is side-effect-free, so a bundler drops `createWorkerRunner` from your worker chunk and the worker half from your page chunk.

## SSR / Node

Safe to import on a server. No worker is created until the first `push`, and `defineWorkerTasks()` outside a worker realm warns and no-ops instead of installing a listener that could never fire. No `typeof window` guard, no dynamic import. Covered by [`test/ssr.test.ts`](test/ssr.test.ts).

If the environment has no `Worker` at all, the failure surfaces as a **rejected** `push` — never as a throw out of `createWorkerRunner` or at import time.

## API

### `createWorkerRunner(factory, options?)`

`factory` is called at most once per worker, on the first `push`. Passing a factory rather than a `Worker` is what makes creation lazy — and it keeps the `new Worker(new URL(...))` form intact, which is the only form bundlers can statically detect.

| Option    | Type                       | Description                                                                                           |
| --------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `onError` | `(error: unknown) => void` | Error channel for calls nobody awaited, and for worker errors that belong to no call. Aborts are not. |

| Member                        | Description                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `push(name, payload?, opts?)` | Call a task by name; resolves with its result.                                                                                        |
| `clear(reason?)`              | Reject every in-flight call (`AbortError` by default, or your `reason`) and tell the worker to drop them. The worker stays alive.     |
| `terminate()`                 | Reject every in-flight call and terminate the worker. A later `push` starts a fresh one — which is also how you recover from a crash. |
| `size`                        | In-flight call count.                                                                                                                 |

Per-call options:

| Option     | Type             | Description                                                                                                             |
| ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `signal`   | `AbortSignal`    | Abort this one call. Rejects with `AbortError` immediately. See [Cancelling](#cancelling) for what the worker can stop. |
| `transfer` | `Transferable[]` | Hand these over instead of copying them. They are detached on this side.                                                |

### `defineWorkerTasks(tasks)`

Runs inside the worker. Registers a plain object of task functions: a sync function, a generator function, or an `async` function. Each takes **one** payload — bundle several values into an object — and calling `push` on a task that declares more than one argument is a compile error against that call, not against the registry. Calling `defineWorkerTasks` more than once merges into the same registry and keeps a single message listener.

A task may declare its payload optional (`(payload?: T) => …`), in which case `push` will take it or leave it.

An unknown task name rejects the call with a clear error rather than going silent, and so does an `async function*` — an async generator is neither of the two shapes the host can drive, and a wrong answer is worse than a failure.

### `transfer(value, transferables)`

Worker-side. Marks a result to be handed over rather than copied. Return it directly from the task.

## License

MIT
