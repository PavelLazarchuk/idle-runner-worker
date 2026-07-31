import { describe, expect, it, vi } from 'vitest';

import { createWorkerRunner } from '../src/main/worker-runner';
import { FakeWorker } from './fake-worker';

function makeRunner(options?: { onError?: (error: unknown) => void }) {
    const worker = new FakeWorker();
    let created = 0;
    const runner = createWorkerRunner(() => {
        created++;

        return worker.asWorker;
    }, options);

    return { worker, runner, factoryCalls: () => created };
}

describe('createWorkerRunner — the happy path', () => {
    it('posts {id, name, payload} and resolves with the worker value', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('buildIndex', [1, 2, 3]);

        expect(worker.messages).toEqual([{ id: 1, name: 'buildIndex', payload: [1, 2, 3] }]);
        expect(runner.size).toBe(1);

        worker.reply({ id: 1, ok: true, value: 'index' });

        await expect(promise).resolves.toBe('index');
        expect(runner.size).toBe(0);
    });

    it('creates the worker lazily on the first push and reuses it', () => {
        const { runner, factoryCalls } = makeRunner();

        expect(factoryCalls()).toBe(0);

        void runner.push('a').catch(() => {});
        void runner.push('b').catch(() => {});

        expect(factoryCalls()).toBe(1);
    });

    it('gives every call its own id and matches out-of-order replies', async () => {
        const { worker, runner } = makeRunner();
        const first = runner.push('a');
        const second = runner.push('b');

        expect(worker.messages.map(message => message.id)).toEqual([1, 2]);

        worker.reply({ id: 2, ok: true, value: 'second' });
        worker.reply({ id: 1, ok: true, value: 'first' });

        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('second');
    });

    it('forwards the transfer list to postMessage', () => {
        const { worker, runner } = makeRunner();
        const buffer = new ArrayBuffer(8);

        void runner.push('decode', buffer, { transfer: [buffer] }).catch(() => {});

        expect(worker.posted[0]!.transfer).toEqual([buffer]);
    });

    it('sends an empty transfer list when none was given', () => {
        const { worker, runner } = makeRunner();

        void runner.push('a').catch(() => {});

        expect(worker.posted[0]!.transfer).toEqual([]);
    });

    it('ignores a reply for an id it does not know', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        expect(() => worker.reply({ id: 999, ok: true, value: 'stray' })).not.toThrow();
        expect(() => worker.reply(null)).not.toThrow();
        expect(() => worker.reply({ ok: true, value: 'no id' })).not.toThrow();

        worker.reply({ id: 1, ok: true, value: 'mine' });

        await expect(promise).resolves.toBe('mine');
    });
});

describe('createWorkerRunner — failures', () => {
    it('rehydrates an Error from the wire, keeping name, message and stack', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        worker.reply({
            id: 1,
            ok: false,
            error: { name: 'RangeError', message: 'too big', stack: 'at worker.ts:1' },
        });

        const error = await promise.catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('RangeError');
        expect((error as Error).message).toBe('too big');
        expect((error as Error).stack).toBe('at worker.ts:1');
    });

    it('passes a thrown non-Error value through unchanged', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        worker.reply({ id: 1, ok: false, error: { raw: { code: 42 } } });

        await expect(promise).rejects.toEqual({ code: 42 });
    });

    it('rejects — never throws — when the factory cannot make a worker', async () => {
        const runner = createWorkerRunner(() => {
            throw new Error('Worker is not defined');
        });

        await expect(runner.push('a')).rejects.toThrow('Worker is not defined');
        expect(runner.size).toBe(0);
    });

    it('rejects when the payload cannot be structured-cloned', async () => {
        const { worker, runner } = makeRunner();
        worker.postError = new Error('DataCloneError');

        await expect(runner.push('a', () => 'a function')).rejects.toThrow(
            /payload for task "a" could not be sent/
        );
        expect(runner.size).toBe(0);
    });

    it('an uncaught worker error rejects everything in flight instead of hanging it', async () => {
        const { worker, runner } = makeRunner();
        const first = runner.push('a');
        const second = runner.push('b');

        worker.emitError('boom', 'worker.js', 7);

        await expect(first).rejects.toThrow('worker failed: boom (worker.js:7)');
        await expect(second).rejects.toThrow('worker failed: boom (worker.js:7)');
        expect(runner.size).toBe(0);
    });

    it('rejects a later push at a crashed worker instead of hanging it forever', async () => {
        const { worker, runner } = makeRunner();

        void runner.push('a').catch(() => {});
        worker.emitError('script load failed');

        await expect(runner.push('b')).rejects.toThrow(/call terminate\(\) before pushing again/);
        expect(runner.size).toBe(0);
        expect(worker.messages).toHaveLength(1);
    });

    it('terminate() clears the crash, so the next push gets a fresh worker', async () => {
        const { worker, runner, factoryCalls } = makeRunner();

        void runner.push('a').catch(() => {});
        worker.emitError('boom');
        runner.terminate();

        void runner.push('b').catch(() => {});

        expect(factoryCalls()).toBe(2);
        expect(runner.size).toBe(1);
    });

    it('keeps a worker that has already answered, since an uncaught error there is not its death', async () => {
        const onError = vi.fn();
        const { worker, runner } = makeRunner({ onError });

        const first = runner.push('a');
        worker.reply({ id: 1, ok: true, value: 'alive' });
        await expect(first).resolves.toBe('alive');

        const inFlight = runner.push('b');
        worker.emitError('a stray timer threw', 'unrelated.js', 3);

        worker.reply({ id: 2, ok: true, value: 'answered anyway' });

        await expect(inFlight).resolves.toBe('answered anyway');

        const next = runner.push('c');
        worker.reply({ id: 3, ok: true, value: 'still serving' });

        await expect(next).resolves.toBe('still serving');
        expect((onError.mock.calls[0]![0] as Error).message).toContain('a stray timer threw');
    });

    it('still treats an uncaught error as fatal while the worker has never answered', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        worker.emitError('boom');

        await expect(promise).rejects.toThrow(/worker failed/);
        await expect(runner.push('b')).rejects.toThrow(/call terminate\(\) before pushing again/);
    });

    it('forgets that the old worker had answered when terminate() replaces it', async () => {
        const { worker, runner } = makeRunner();

        const first = runner.push('a');
        worker.reply({ id: 1, ok: true, value: 'alive' });
        await expect(first).resolves.toBe('alive');

        runner.terminate();

        void runner.push('b').catch(() => {});
        worker.emitError('the replacement never loaded');

        await expect(runner.push('c')).rejects.toThrow(/call terminate\(\) before pushing again/);
    });

    it("ignores a message of the worker's own that happens to carry a live id", async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        worker.reply({ id: 1, type: 'progress', done: 0.5 });
        worker.reply({ id: 1, ok: 'yes', value: 'not a boolean' });

        expect(runner.size).toBe(1);

        worker.reply({ id: 1, ok: true, value: 'the real reply' });

        await expect(promise).resolves.toBe('the real reply');
    });

    it('rejects everything in flight when the worker could not read a payload', async () => {
        const { worker, runner } = makeRunner();
        const first = runner.push('a');
        const second = runner.push('b');

        worker.reply({ op: 'undeliverable' });

        await expect(first).rejects.toThrow(/could not deserialise the payload/);
        await expect(second).rejects.toThrow(/could not deserialise the payload/);
        expect(runner.size).toBe(0);

        const next = runner.push('c');
        worker.reply({ id: 3, ok: true, value: 'still here' });

        await expect(next).resolves.toBe('still here');
    });

    it('a messageerror rejects everything in flight but leaves the worker usable', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        worker.emitMessageError();

        await expect(promise).rejects.toThrow(/could not be deserialised/);

        const next = runner.push('b');
        worker.reply({ id: 2, ok: true, value: 'still here' });

        await expect(next).resolves.toBe('still here');
    });

    it('reports unawaited failures to onError but stays quiet about aborts', async () => {
        const onError = vi.fn();
        const { worker, runner } = makeRunner({ onError });
        const controller = new AbortController();

        const failing = runner.push('a');
        const aborted = runner.push('b', undefined, { signal: controller.signal });

        worker.reply({ id: 1, ok: false, error: { name: 'Error', message: 'nope' } });
        controller.abort();

        await expect(failing).rejects.toThrow('nope');
        await expect(aborted).rejects.toThrow(/Aborted/);

        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0]![0] as Error).message).toBe('nope');
    });

    it('survives an onError that throws', async () => {
        const onError = vi.fn(() => {
            throw new Error('reporter is broken');
        });
        const { worker, runner } = makeRunner({ onError });
        const promise = runner.push('a');

        worker.reply({ id: 1, ok: false, error: { name: 'Error', message: 'nope' } });

        await expect(promise).rejects.toThrow('nope');
        expect(onError).toHaveBeenCalledOnce();
    });
});

describe('createWorkerRunner — cancellation', () => {
    it('rejects an already-aborted signal without ever creating the worker', async () => {
        const { runner, factoryCalls } = makeRunner();

        await expect(
            runner.push('a', undefined, { signal: AbortSignal.abort() })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(factoryCalls()).toBe(0);
    });

    it('rejects immediately on abort and tells the worker in the same turn', async () => {
        const { worker, runner } = makeRunner();
        const controller = new AbortController();
        const promise = runner.push('slow', undefined, { signal: controller.signal });

        controller.abort();

        expect(worker.messages[1]).toEqual({ id: 1, op: 'abort' });
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(runner.size).toBe(0);
    });

    it('ignores a reply that arrives after the abort', async () => {
        const { worker, runner } = makeRunner();
        const controller = new AbortController();
        const promise = runner.push('slow', undefined, { signal: controller.signal });

        controller.abort();
        worker.reply({ id: 1, ok: true, value: 'too late' });

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('still rejects when telling a dead worker about the abort throws', async () => {
        const { worker, runner } = makeRunner();
        const controller = new AbortController();
        const promise = runner.push('slow', undefined, { signal: controller.signal });

        worker.postError = new Error('worker is gone');
        controller.abort();

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('drops the abort listener once a call settles', async () => {
        const { worker, runner } = makeRunner();
        const controller = new AbortController();
        const promise = runner.push('a', undefined, { signal: controller.signal });

        worker.reply({ id: 1, ok: true, value: 'done' });
        await expect(promise).resolves.toBe('done');

        controller.abort();

        expect(worker.messages).toHaveLength(1);
    });

    it('clear() rejects everything with AbortError and tells the worker', async () => {
        const { worker, runner } = makeRunner();
        const first = runner.push('a');
        const second = runner.push('b');

        runner.clear();

        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.messages.slice(2)).toEqual([
            { id: 1, op: 'abort' },
            { id: 2, op: 'abort' },
        ]);
        expect(worker.terminated).toBe(false);
    });

    it('clear(reason) rejects with that reason', async () => {
        const { runner } = makeRunner();
        const reason = new Error('route changed');
        const promise = runner.push('a');

        runner.clear(reason);

        await expect(promise).rejects.toBe(reason);
    });

    it('terminate() rejects everything, kills the worker and unhooks its listeners', async () => {
        const { worker, runner } = makeRunner();
        const promise = runner.push('a');

        runner.terminate();

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(worker.terminated).toBe(true);
        expect(worker.listenerCount('message')).toBe(0);
        expect(worker.listenerCount('error')).toBe(0);
        expect(worker.listenerCount('messageerror')).toBe(0);
    });

    it('a push after terminate() starts a fresh worker', async () => {
        const { runner, factoryCalls } = makeRunner();

        void runner.push('a').catch(() => {});
        runner.terminate();

        expect(factoryCalls()).toBe(1);

        void runner.push('b').catch(() => {});

        expect(factoryCalls()).toBe(2);
    });

    it('terminate() on an unused runner is a no-op', () => {
        const { runner, factoryCalls } = makeRunner();

        expect(() => runner.terminate()).not.toThrow();
        expect(factoryCalls()).toBe(0);
    });

    it('size counts only calls that are still in flight', async () => {
        const { worker, runner } = makeRunner();
        const first = runner.push('a');
        void runner.push('b').catch(() => {});

        expect(runner.size).toBe(2);

        worker.reply({ id: 1, ok: true, value: 1 });
        await first;

        expect(runner.size).toBe(1);
    });
});
