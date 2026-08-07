import { describe, expect, it, vi } from 'vitest';

import { createWorkerPool } from '../src/main/worker-pool';
import { FakeWorker } from './fake-worker';

function makePool(options?: Parameters<typeof createWorkerPool>[1]) {
    const workers: FakeWorker[] = [];
    const pool = createWorkerPool(() => {
        const worker = new FakeWorker();
        workers.push(worker);

        return worker.asWorker;
    }, options);

    return { pool, workers };
}

describe('createWorkerPool', () => {
    it('keeps to one worker while calls do not overlap', async () => {
        const { pool, workers } = makePool({ size: 3 });

        const first = pool.push('a');
        expect(workers).toHaveLength(1);
        workers[0]!.reply({ id: workers[0]!.idOf(0), ok: true, value: 'first' });
        await expect(first).resolves.toBe('first');

        const second = pool.push('b');
        expect(workers).toHaveLength(1);
        workers[0]!.reply({ id: workers[0]!.idOf(1), ok: true, value: 'second' });
        await expect(second).resolves.toBe('second');
    });

    it('spreads overlapping calls across workers, least busy first', () => {
        const { pool, workers } = makePool({ size: 3 });

        void pool.push('a').catch(() => {});
        void pool.push('b').catch(() => {});
        void pool.push('c').catch(() => {});

        expect(workers).toHaveLength(3);
        expect(workers.map(worker => worker.messages.length)).toEqual([1, 1, 1]);
        expect(pool.size).toBe(3);
    });

    it('wraps around to the least busy worker once every one is busy', () => {
        const { pool, workers } = makePool({ size: 2 });

        void pool.push('a').catch(() => {});
        void pool.push('b').catch(() => {});
        void pool.push('c').catch(() => {});

        expect(workers).toHaveLength(2);
        expect(workers[0]!.messages.map(message => message.name)).toEqual(['a', 'c']);
        expect(workers[1]!.messages.map(message => message.name)).toEqual(['b']);
    });

    it('routes back to a worker that has become free again', async () => {
        const { pool, workers } = makePool({ size: 2 });

        const first = pool.push('a');
        void pool.push('b').catch(() => {});
        workers[0]!.reply({ id: workers[0]!.idOf(0), ok: true, value: 'done' });
        await first;

        void pool.push('c').catch(() => {});

        expect(workers[0]!.messages.map(message => message.name)).toEqual(['a', 'c']);
    });

    it('resolves and rejects per call, exactly like a single runner', async () => {
        const { pool, workers } = makePool({ size: 2 });

        const ok = pool.push('a');
        const failed = pool.push('b');

        workers[0]!.reply({
            id: workers[0]!.idOf(0),
            ok: true,
            value: 42,
        });
        workers[1]!.reply({
            id: workers[1]!.idOf(0),
            ok: false,
            error: { name: 'RangeError', message: 'nope' },
        });

        await expect(ok).resolves.toBe(42);
        await expect(failed).rejects.toMatchObject({ name: 'RangeError', message: 'nope' });
    });

    it('forwards per-call options to the chosen worker', () => {
        const { pool, workers } = makePool({ size: 1 });
        const buffer = new ArrayBuffer(8);

        void pool.push('decode', buffer, { transfer: [buffer] }).catch(() => {});

        expect(workers[0]!.posted[0]!.transfer).toEqual([buffer]);
    });

    it('aborts a single call without touching its neighbours', async () => {
        const { pool, workers } = makePool({ size: 2 });
        const controller = new AbortController();

        const aborted = pool.push('a', undefined, { signal: controller.signal });
        const kept = pool.push('b');

        controller.abort();

        await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
        workers[1]!.reply({ id: workers[1]!.idOf(0), ok: true, value: 'kept' });
        await expect(kept).resolves.toBe('kept');
        expect(pool.size).toBe(0);
    });

    it('size sums the workers, and clear() empties all of them', async () => {
        const { pool, workers } = makePool({ size: 2 });

        const first = pool.push('a');
        const second = pool.push('b');
        first.catch(() => {});
        second.catch(() => {});

        expect(pool.size).toBe(2);

        pool.clear();

        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await expect(second).rejects.toMatchObject({ name: 'AbortError' });
        expect(pool.size).toBe(0);
        expect(workers.every(worker => !worker.terminated)).toBe(true);
    });

    it('terminate() kills every worker it started', async () => {
        const { pool, workers } = makePool({ size: 2 });

        const first = pool.push('a');
        const second = pool.push('b');
        first.catch(() => {});
        second.catch(() => {});

        pool.terminate();

        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        expect(workers.every(worker => worker.terminated)).toBe(true);
        expect(pool.size).toBe(0);
    });

    it('a push after terminate() starts fresh workers', () => {
        const { pool, workers } = makePool({ size: 2 });

        void pool.push('a').catch(() => {});
        pool.terminate();
        void pool.push('b').catch(() => {});

        expect(workers).toHaveLength(2);
        expect(workers[1]!.terminated).toBe(false);
    });

    it('falls back to a single worker on a bad size, with a warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { pool, workers } = makePool({ size: 0 });

        void pool.push('a').catch(() => {});
        void pool.push('b').catch(() => {});

        expect(workers).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('size'));
        warn.mockRestore();
    });

    it('starts at least one worker when no size is given', () => {
        const { pool, workers } = makePool();

        void pool.push('a').catch(() => {});

        expect(workers).toHaveLength(1);
    });

    it('a crash in one worker leaves the others serving', async () => {
        const { pool, workers } = makePool({ size: 2 });

        const doomed = pool.push('a');
        const healthy = pool.push('b');
        doomed.catch(() => {});

        workers[0]!.emitError('import failed', 'tasks.worker.js', 1);

        await expect(doomed).rejects.toThrow(/import failed/);

        workers[1]!.reply({ id: workers[1]!.idOf(0), ok: true, value: 'still here' });
        await expect(healthy).resolves.toBe('still here');
    });
});
