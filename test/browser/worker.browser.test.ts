import { afterEach, describe, expect, it } from 'vitest';

import { createWorkerRunner } from '../../src/main/worker-runner';
import type { WorkerRunner } from '../../src/shared/types';

const live: WorkerRunner[] = [];

function makeRunner(): WorkerRunner {
    const runner = createWorkerRunner(
        () => new Worker(new URL('./fixtures/tasks.worker.ts', import.meta.url), { type: 'module' })
    );

    live.push(runner);

    return runner;
}

afterEach(() => {
    for (const runner of live.splice(0)) runner.terminate();
});

function busyWait(ms: number): void {
    const start = performance.now();

    while (performance.now() - start < ms) {
        // burn
    }
}

describe('a real worker, end to end', () => {
    it('runs a task and comes back with its value', async () => {
        const runner = makeRunner();

        await expect(runner.push('sum', [1, 2, 3, 4])).resolves.toBe(10);
    });

    it('runs concurrent calls on one worker, each resolving with its own result', async () => {
        const runner = makeRunner();

        await expect(
            Promise.all([
                runner.push('sum', [1, 1]),
                runner.push('later', 'hello'),
                runner.push('squares', 4),
            ])
        ).resolves.toEqual([2, 'hello!', [0, 1, 4, 9]]);
    });

    it('drives a generator task across yields and returns its return value', async () => {
        const runner = makeRunner();
        const squares = (await runner.push('squares', 2000)) as number[];

        expect(squares).toHaveLength(2000);
        expect(squares[1999]).toBe(1999 * 1999);
    });

    it('rejects with the worker Error, name and message intact', async () => {
        const runner = makeRunner();
        const error = (await runner.push('boom').catch((reason: unknown) => reason)) as Error;

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe('RangeError');
        expect(error.message).toBe('worker exploded');
        expect(error.stack).toBeTruthy();
    });

    it('passes a thrown non-Error value through', async () => {
        const runner = makeRunner();

        await expect(runner.push('throwString')).rejects.toBe('not an error');
    });

    it('rejects a name the worker does not know', async () => {
        const runner = makeRunner();

        await expect(runner.push('nope')).rejects.toThrow('unknown task "nope"');
    });

    it('keeps serving calls after a failure', async () => {
        const runner = makeRunner();

        await expect(runner.push('boom')).rejects.toThrow('worker exploded');
        await expect(runner.push('sum', [2, 2])).resolves.toBe(4);
    });

    it('rejects an async generator task by name instead of answering with junk', async () => {
        const runner = makeRunner();

        await expect(runner.push('streamy')).rejects.toThrow(/async generator/);
        await expect(runner.push('sum', [3, 3])).resolves.toBe(6);
    });

    it('starts a fresh worker after terminate()', async () => {
        const runner = makeRunner();

        await expect(runner.push('sum', [1])).resolves.toBe(1);

        runner.terminate();

        await expect(runner.push('sum', [2])).resolves.toBe(2);
    });
});

describe('an uncaught error in a worker that is otherwise fine', () => {
    it('keeps serving, because the throw belonged to something else in the thread', async () => {
        const runner = makeRunner();

        await expect(runner.push('sum', [1])).resolves.toBe(1);
        await expect(runner.push('scheduleUnrelatedThrow')).resolves.toBe('scheduled');

        await new Promise(resolve => setTimeout(resolve, 200));

        await expect(runner.push('sum', [2, 3])).resolves.toBe(5);
    });
});

describe('a worker that never loads', () => {
    function makeBrokenRunner(): WorkerRunner {
        const runner = createWorkerRunner(
            () => new Worker(new URL('./fixtures/no-such-worker.ts', import.meta.url))
        );

        live.push(runner);

        return runner;
    }

    it('rejects the call in flight and every call after it, rather than hanging', async () => {
        const runner = makeBrokenRunner();

        await expect(runner.push('sum', [1])).rejects.toThrow(/worker failed/);

        await expect(runner.push('sum', [1])).rejects.toThrow(
            /call terminate\(\) before pushing again/
        );
        expect(runner.size).toBe(0);
    });
});

describe('cancellation against a real worker', () => {
    it('rejects at once and lets the generator run its finally in the worker', async () => {
        const runner = makeRunner();
        const controller = new AbortController();
        const forever = runner.push('forever', undefined, { signal: controller.signal });

        await new Promise(resolve => setTimeout(resolve, 50));
        controller.abort();

        await expect(forever).rejects.toMatchObject({ name: 'AbortError' });

        await expect(runner.push('cleanupRan')).resolves.toBe(true);
    });

    it('clear() rejects everything in flight and leaves the worker usable', async () => {
        const runner = makeRunner();
        const forever = runner.push('forever');

        await new Promise(resolve => setTimeout(resolve, 50));
        runner.clear();

        await expect(forever).rejects.toMatchObject({ name: 'AbortError' });
        await expect(runner.push('sum', [5])).resolves.toBe(5);
    });
});

describe('transferables', () => {
    it('hands a buffer to the worker instead of copying it', async () => {
        const runner = makeRunner();
        const buffer = new ArrayBuffer(1024);

        const seen = await runner.push('byteLengthOf', buffer, { transfer: [buffer] });

        expect(seen).toBe(1024);
        expect(buffer.byteLength).toBe(0);
    });

    it('rejects a payload whose buffer was already transferred away', async () => {
        const runner = makeRunner();
        const buffer = new ArrayBuffer(8);

        await runner.push('byteLengthOf', buffer, { transfer: [buffer] });

        await expect(runner.push('byteLengthOf', buffer, { transfer: [buffer] })).rejects.toThrow(
            /could not be sent to the worker/
        );
    });

    it('hands a result back by transfer, detaching it in the worker', async () => {
        const runner = makeRunner();
        const buffer = (await runner.push('makeBuffer', 2048)) as ArrayBuffer;

        expect(buffer.byteLength).toBe(2048);
        expect(new Uint8Array(buffer)[0]).toBe(7);
        await expect(runner.push('keptByteLength')).resolves.toBe(0);
    });
});

describe('does it actually keep the main thread free?', () => {
    const supportsLongtask =
        typeof PerformanceObserver !== 'undefined' &&
        (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask');

    async function observeLongTasks(work: () => Promise<void> | void): Promise<number[]> {
        const durations: number[] = [];
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) durations.push(entry.duration);
        });

        observer.observe({ type: 'longtask' });
        await work();
        await new Promise(resolve => setTimeout(resolve, 200));
        observer.disconnect();

        return durations;
    }

    it.skipIf(!supportsLongtask)(
        'the negative control DOES produce a long task (otherwise this proves nothing)',
        async () => {
            const durations = await observeLongTasks(() => {
                busyWait(180);
            });

            expect(durations.some(duration => duration >= 50)).toBe(true);
        }
    );

    it.skipIf(!supportsLongtask)(
        'the same 180ms of work inside the worker produces no long task here',
        async () => {
            const runner = makeRunner();
            await runner.push('sum', [1]);

            const durations = await observeLongTasks(async () => {
                await expect(runner.push('burn', 180)).resolves.toBe('burned');
            });

            expect(durations.filter(duration => duration >= 50)).toEqual([]);
        }
    );

    it('rendering keeps getting frames while the worker chews through work', async () => {
        const runner = makeRunner();
        let frames = 0;
        let running = true;
        const onFrame = () => {
            frames++;

            if (running) requestAnimationFrame(onFrame);
        };

        requestAnimationFrame(onFrame);
        await runner.push('burn', 150);
        running = false;

        expect(frames).toBeGreaterThanOrEqual(3);
    });
});
