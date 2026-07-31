import { describe, expect, it, vi } from 'vitest';

import { FakeScope, ManualYield, step, tick } from './fake-scope';
import { installTaskHost } from '../src/worker/task-host';
import { transfer } from '../src/worker/transfer';
import type { WorkerTasks } from '../src/shared/types';

function makeHost(tasks: WorkerTasks, sliceMs = 0) {
    const scope = new FakeScope();
    const manual = new ManualYield();
    const host = installTaskHost(scope, { yieldControl: manual.yieldControl, sliceMs });
    host.register(tasks);

    return { scope, manual, host };
}

describe('installTaskHost — plain tasks', () => {
    it('runs a registered task and posts {id, ok, value}', async () => {
        const { scope } = makeHost({ double: (n: number) => n * 2 });

        scope.send({ id: 1, name: 'double', payload: 21 });
        await tick();

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 42 }]);
    });

    it('answers an unknown task name instead of going silent', async () => {
        const { scope } = makeHost({});

        scope.send({ id: 7, name: 'nope' });
        await tick();

        expect(scope.messages[0]).toMatchObject({ id: 7, ok: false });
        expect(scope.messages[0]!.error).toMatchObject({ message: 'unknown task "nope"' });
    });

    it('reports a thrown Error with its name, message and stack', async () => {
        const { scope } = makeHost({
            boom: () => {
                throw new RangeError('too big');
            },
        });

        scope.send({ id: 1, name: 'boom' });
        await tick();

        const error = scope.messages[0]!.error as Record<string, unknown>;

        expect(scope.messages[0]).toMatchObject({ id: 1, ok: false });
        expect(error.name).toBe('RangeError');
        expect(error.message).toBe('too big');
        expect(typeof error.stack).toBe('string');
    });

    it('passes a thrown non-Error value through as raw', async () => {
        const { scope } = makeHost({
            boom: () => {
                throw { code: 42 };
            },
        });

        scope.send({ id: 1, name: 'boom' });
        await tick();

        expect(scope.messages[0]!.error).toEqual({ raw: { code: 42 } });
    });

    it('awaits a task that returns a promise', async () => {
        const { scope } = makeHost({ fetchish: async () => 'resolved' });

        scope.send({ id: 1, name: 'fetchish' });
        await tick();

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 'resolved' }]);
    });

    it('reports a rejected promise as a failure', async () => {
        const { scope } = makeHost({
            fetchish: () => Promise.reject(new Error('offline')),
        });

        scope.send({ id: 1, name: 'fetchish' });
        await tick();

        expect(scope.messages[0]).toMatchObject({ id: 1, ok: false });
        expect(scope.messages[0]!.error).toMatchObject({ message: 'offline' });
    });

    it('turns a non-cloneable result into a failure rather than a lost call', async () => {
        const { scope } = makeHost({ leak: () => () => 'a function' });
        let posts = 0;

        const original = scope.postMessage.bind(scope);
        scope.postMessage = (message: unknown, transferables?: Transferable[]) => {
            if (posts++ === 0) throw new Error('an object could not be cloned');

            original(message, transferables);
        };

        scope.send({ id: 1, name: 'leak' });
        await tick();

        const error = scope.messages[0]!.error as { message: string };

        expect(scope.messages[0]).toMatchObject({ id: 1, ok: false });
        expect(error.message).toContain('result of task "leak" could not be sent');
        expect(error.message).toContain('an object could not be cloned');
    });

    it('rejects an async generator task instead of answering with a bare {}', async () => {
        const { scope } = makeHost({
            streamy: async function* () {
                yield 1;

                return 'done';
            },
        });

        scope.send({ id: 1, name: 'streamy' });
        await tick();

        expect(scope.messages[0]).toMatchObject({ id: 1, ok: false });
        expect(scope.messages[0]!.error).toMatchObject({
            message: expect.stringContaining('async generator'),
        });
    });

    it('returns an iterator as a value instead of mistaking it for a generator', async () => {
        const { scope } = makeHost({ keys: () => new Map([['a', 1]]).keys() });

        scope.send({ id: 1, name: 'keys' });
        await tick();

        const reply = scope.messages[0]!;

        expect(reply).toMatchObject({ id: 1, ok: true });
        expect([...(reply.value as IterableIterator<string>)]).toEqual(['a']);
    });

    it('tells the page when it could not read a payload, rather than leaving the call pending', async () => {
        const { scope } = makeHost({ a: () => 'a' });

        scope.sendUndeserialisable();

        expect(scope.messages).toEqual([{ op: 'undeliverable' }]);
    });

    it('ignores messages that are not calls', async () => {
        const run = vi.fn();
        const { scope } = makeHost({ run });

        scope.send(null);
        scope.send({ name: 'run' });
        scope.send('nonsense');
        await tick();

        expect(run).not.toHaveBeenCalled();
        expect(scope.messages).toEqual([]);
    });

    it('registers a single message listener however often tasks are registered', () => {
        const { scope, host } = makeHost({ a: () => 1 });

        host.register({ b: () => 2 });

        expect(scope.listenerCount).toBe(1);
    });

    it('merges later registrations and warns about a redefinition', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { scope, host } = makeHost({ a: () => 'first' });

        host.register({ a: () => 'second', b: () => 'b' });

        scope.send({ id: 1, name: 'a' });
        scope.send({ id: 2, name: 'b' });
        await tick();

        expect(scope.messages).toEqual([
            { id: 1, ok: true, value: 'second' },
            { id: 2, ok: true, value: 'b' },
        ]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('task "a" was redefined'));

        warn.mockRestore();
    });

    it('ignores a registry entry that is not a function', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { scope } = makeHost({ nope: 42 as unknown as () => void });

        scope.send({ id: 1, name: 'nope' });
        await tick();

        expect(scope.messages[0]!.error).toMatchObject({ message: 'unknown task "nope"' });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not a function'));

        warn.mockRestore();
    });
});

describe('installTaskHost — generator tasks', () => {
    function* counter(steps: number) {
        const seen: number[] = [];

        for (let i = 0; i < steps; i++) {
            seen.push(i);
            yield;
        }

        return seen;
    }

    it('drives a generator to completion and posts its return value', async () => {
        const { scope, manual } = makeHost({ count: (n: number) => counter(n) });

        scope.send({ id: 1, name: 'count', payload: 3 });
        await tick();

        expect(scope.messages).toEqual([]);
        expect(manual.pending).toBe(1);

        await step(manual, 3);

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: [0, 1, 2] }]);
    });

    it('yields once per step with sliceMs=0, and not at all when it never yields', async () => {
        const { scope, manual } = makeHost({
            oneShot: function* () {
                return 'immediate';
            },
        });

        scope.send({ id: 1, name: 'oneShot' });
        await tick();

        expect(manual.pending).toBe(0);
        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 'immediate' }]);
    });

    it('runs many steps per slice when the slice has room', async () => {
        const { scope, manual } = makeHost({ count: () => counter(50) }, 5000);

        scope.send({ id: 1, name: 'count' });
        await tick();

        expect(manual.pending).toBe(0);
        expect(scope.messages[0]).toMatchObject({ id: 1, ok: true });
    });

    it('reports a throw from inside a generator', async () => {
        const { scope, manual } = makeHost({
            boom: function* () {
                yield;
                throw new Error('mid-flight');
            },
        });

        scope.send({ id: 1, name: 'boom' });
        await step(manual, 1);

        expect(scope.messages[0]).toMatchObject({ id: 1, ok: false });
        expect(scope.messages[0]!.error).toMatchObject({ message: 'mid-flight' });
    });
});

describe('installTaskHost — cancellation', () => {
    it('stops a suspended generator, runs its finally and answers nobody', async () => {
        const cleanup = vi.fn();
        const steps = vi.fn();
        const { scope, manual } = makeHost({
            work: function* () {
                try {
                    for (;;) {
                        steps();
                        yield;
                    }
                } finally {
                    cleanup();
                }
            },
        });

        scope.send({ id: 1, name: 'work' });
        await tick();
        await step(manual, 1);

        expect(steps).toHaveBeenCalledTimes(2);

        scope.send({ id: 1, op: 'abort' });
        await step(manual, 1);

        expect(cleanup).toHaveBeenCalledOnce();
        expect(scope.messages).toEqual([]);
        expect(steps).toHaveBeenCalledTimes(2);
    });

    it('drops a queued call that is aborted before it starts', async () => {
        const second = vi.fn(() => 'never');
        const { scope, manual } = makeHost({
            slow: function* () {
                yield;
                yield;

                return 'slow done';
            },
            second,
        });

        scope.send({ id: 1, name: 'slow' });
        scope.send({ id: 2, name: 'second' });
        await tick();

        scope.send({ id: 2, op: 'abort' });
        await step(manual, 3);

        expect(second).not.toHaveBeenCalled();
        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 'slow done' }]);
    });

    it('an abort for an unknown id is harmless', async () => {
        const { scope } = makeHost({ a: () => 'a' });

        scope.send({ id: 999, op: 'abort' });
        scope.send({ id: 1, name: 'a' });
        await tick();

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 'a' }]);
    });

    it('a sync task has already answered before any abort can reach it', async () => {
        const { scope } = makeHost({ quick: () => 'done anyway' });

        scope.send({ id: 1, name: 'quick' });

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 'done anyway' }]);

        scope.send({ id: 1, op: 'abort' });
        await tick();

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: 'done anyway' }]);
    });

    it('cannot interrupt an async task mid-flight, and discards the result it settles with', async () => {
        let settle: (value: string) => void = () => {};
        const { scope } = makeHost({
            slow: () =>
                new Promise<string>(resolve => {
                    settle = resolve;
                }),
        });

        scope.send({ id: 1, name: 'slow' });
        await tick();

        scope.send({ id: 1, op: 'abort' });
        settle('too late');
        await tick();

        expect(scope.messages).toEqual([]);
    });
});

describe('installTaskHost — ordering', () => {
    it('runs calls FIFO, never interleaving a second call into a suspended one', async () => {
        const order: string[] = [];
        const { scope, manual } = makeHost({
            first: function* () {
                order.push('first:start');
                yield;
                order.push('first:end');

                return 1;
            },
            second: () => {
                order.push('second');

                return 2;
            },
        });

        scope.send({ id: 1, name: 'first' });
        scope.send({ id: 2, name: 'second' });
        await tick();

        expect(order).toEqual(['first:start']);

        await step(manual, 2);

        expect(order).toEqual(['first:start', 'first:end', 'second']);
        expect(scope.messages).toEqual([
            { id: 1, ok: true, value: 1 },
            { id: 2, ok: true, value: 2 },
        ]);
    });

    it('keeps pumping calls that arrive while a task is suspended', async () => {
        const { scope, manual } = makeHost({
            slow: function* () {
                yield;

                return 'slow';
            },
            quick: () => 'quick',
        });

        scope.send({ id: 1, name: 'slow' });
        await tick();
        scope.send({ id: 2, name: 'quick' });
        await step(manual, 2);

        expect(scope.messages).toEqual([
            { id: 1, ok: true, value: 'slow' },
            { id: 2, ok: true, value: 'quick' },
        ]);
    });
});

describe('transfer()', () => {
    it('posts the unwrapped value with a transfer list', async () => {
        const buffer = new ArrayBuffer(8);
        const { scope } = makeHost({ decode: () => transfer({ pixels: buffer }, [buffer]) });

        scope.send({ id: 1, name: 'decode' });
        await tick();

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: { pixels: buffer } }]);
        expect(scope.posted[0]!.transfer).toEqual([buffer]);
    });

    it('sends an empty transfer list for an ordinary result', async () => {
        const { scope } = makeHost({ plain: () => 'value' });

        scope.send({ id: 1, name: 'plain' });
        await tick();

        expect(scope.posted[0]!.transfer).toEqual([]);
    });

    it('works from a generator return', async () => {
        const buffer = new ArrayBuffer(4);
        const { scope, manual } = makeHost({
            decode: function* () {
                yield;

                return transfer(buffer, [buffer]);
            },
        });

        scope.send({ id: 1, name: 'decode' });
        await step(manual, 1);

        expect(scope.messages).toEqual([{ id: 1, ok: true, value: buffer }]);
        expect(scope.posted[0]!.transfer).toEqual([buffer]);
    });
});
