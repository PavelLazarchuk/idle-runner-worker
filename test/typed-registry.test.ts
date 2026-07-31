import { describe, expect, expectTypeOf, it } from 'vitest';

import { createWorkerRunner } from '../src/main/worker-runner';
import { FakeWorker } from './fake-worker';

export const tasks = {
    buildIndex: (products: string[]) => ({ size: products.length }),
    downscale: function* (photos: number[]) {
        yield;

        return photos.map(String);
    },
    ping: () => 'pong',
    later: async (value: number) => value * 2,
    greet: (name?: string) => `hello ${name ?? 'world'}`,
};

describe('typed task registry', () => {
    it('infers payload and result types per task name', () => {
        const worker = new FakeWorker();
        const runner = createWorkerRunner<typeof tasks>(() => worker.asWorker);

        expectTypeOf(runner.push('buildIndex', ['a', 'b'])).toEqualTypeOf<
            Promise<{ size: number }>
        >();
        expectTypeOf(runner.push('downscale', [1, 2])).toEqualTypeOf<Promise<string[]>>();
        expectTypeOf(runner.push('later', 1)).toEqualTypeOf<Promise<number>>();
        expectTypeOf(runner.push('ping')).toEqualTypeOf<Promise<string>>();
    });

    it('rejects unknown names, wrong payloads and missing payloads at compile time', () => {
        const worker = new FakeWorker();
        const runner = createWorkerRunner<typeof tasks>(() => worker.asWorker);

        // @ts-expect-error unknown task name
        void runner.push('nope');
        // @ts-expect-error payload is required for this task
        void runner.push('buildIndex');
        // @ts-expect-error wrong payload type
        void runner.push('buildIndex', 42);

        expect(worker.messages).toHaveLength(3);
    });

    it('lets a task with an optional payload be called either way', () => {
        const worker = new FakeWorker();
        const runner = createWorkerRunner<typeof tasks>(() => worker.asWorker);

        expectTypeOf(runner.push('greet')).toEqualTypeOf<Promise<string>>();
        expectTypeOf(runner.push('greet', 'ada')).toEqualTypeOf<Promise<string>>();

        // @ts-expect-error the payload is optional, not untyped
        void runner.push('greet', 42);

        expect(worker.messages).toHaveLength(3);
    });

    it('reports an unsupported task shape at the call, not against the whole registry', () => {
        interface Awkward {
            fine: (value: number) => number;
            twoArgs: (a: number, b: string) => string;
        }
        const worker = new FakeWorker();

        const runner = createWorkerRunner<Awkward>(() => worker.asWorker);

        expectTypeOf(runner.push('fine', 1)).toEqualTypeOf<Promise<number>>();

        // @ts-expect-error a worker task receives a single payload
        void runner.push('twoArgs', 1);

        expect(worker.messages).toHaveLength(2);
    });

    it('still works untyped, with the loose registry as the default', async () => {
        const worker = new FakeWorker();
        const runner = createWorkerRunner(() => worker.asWorker);
        const promise = runner.push('anything', { some: 'payload' });

        worker.reply({ id: 1, ok: true, value: 'fine' });

        await expect(promise).resolves.toBe('fine');
    });
});
