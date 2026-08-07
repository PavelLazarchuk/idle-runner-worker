import { describe, expect, it, vi } from 'vitest';

import { createWorkerRunner } from '../src/main/worker-runner';
import { FakeWorker } from './fake-worker';

function makeRunner(options?: Parameters<typeof createWorkerRunner>[1]) {
    const workers: FakeWorker[] = [];
    const runner = createWorkerRunner(() => {
        const worker = new FakeWorker();
        workers.push(worker);

        return worker.asWorker;
    }, options);

    return { runner, workers };
}

describe('autoRestart', () => {
    it('rejects the calls in flight and serves the next push from a fresh worker', async () => {
        const { runner, workers } = makeRunner({ autoRestart: true });

        const doomed = runner.push('a');
        doomed.catch(() => {});
        workers[0]!.emitError('script failed to load', 'tasks.worker.js', 1);

        await expect(doomed).rejects.toThrow(/the next push starts a fresh worker/);

        const retried = runner.push('b');
        expect(workers).toHaveLength(2);
        workers[1]!.reply({ id: workers[1]!.idOf(0), ok: true, value: 'recovered' });
        await expect(retried).resolves.toBe('recovered');
    });

    it('never retries the call that died with the worker', async () => {
        const { runner, workers } = makeRunner({ autoRestart: true });

        runner.push('poison', { payload: 1 }).catch(() => {});
        workers[0]!.emitError('boom');
        runner.push('other').catch(() => {});

        expect(workers[1]!.messages.map(message => message.name)).toEqual(['other']);
    });

    it('terminates and unhooks the dead worker instead of leaking it', async () => {
        const { runner, workers } = makeRunner({ autoRestart: true });

        runner.push('a').catch(() => {});
        workers[0]!.emitError('boom');

        expect(workers[0]!.terminated).toBe(true);
        expect(workers[0]!.listenerCount('message')).toBe(0);
        expect(workers[0]!.listenerCount('error')).toBe(0);
    });

    it('gives up after maxRestarts consecutive failures', async () => {
        const { runner, workers } = makeRunner({ autoRestart: true, maxRestarts: 2 });

        for (let attempt = 0; attempt < 2; attempt++) {
            runner.push('a').catch(() => {});
            workers[attempt]!.emitError('boom');
        }

        const last = runner.push('a');
        last.catch(() => {});
        workers[2]!.emitError('boom');

        await expect(last).rejects.toThrow(/after 2 restart\(s\)/);
        await expect(runner.push('a')).rejects.toThrow(/call terminate\(\) before pushing again/);
        expect(workers).toHaveLength(3);
    });

    it('leaves a worker that has already answered alone: its errors are not restarts', async () => {
        const onError = vi.fn();
        const { runner, workers } = makeRunner({ autoRestart: true, onError });

        const answered = runner.push('a');
        workers[0]!.reply({ id: workers[0]!.idOf(0), ok: true, value: 'alive' });
        await expect(answered).resolves.toBe('alive');

        const inFlight = runner.push('b');
        workers[0]!.emitError('stray timer blew up');

        expect(workers).toHaveLength(1);
        expect(workers[0]!.terminated).toBe(false);
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('uncaught error') })
        );

        workers[0]!.reply({ id: workers[0]!.idOf(1), ok: true, value: 'still serving' });
        await expect(inFlight).resolves.toBe('still serving');
    });

    it('terminate() clears the restart budget too', async () => {
        const { runner, workers } = makeRunner({ autoRestart: true, maxRestarts: 1 });

        runner.push('a').catch(() => {});
        workers[0]!.emitError('boom');
        runner.terminate();

        const doomed = runner.push('b');
        doomed.catch(() => {});
        workers[1]!.emitError('boom');

        await expect(doomed).rejects.toThrow(/the next push starts a fresh worker/);
    });

    it('is off by default: the runner still parks itself as crashed', async () => {
        const { runner, workers } = makeRunner();

        runner.push('a').catch(() => {});
        workers[0]!.emitError('boom');

        await expect(runner.push('b')).rejects.toThrow(/call terminate\(\) before pushing again/);
        expect(workers).toHaveLength(1);
    });

    it('warns and uses the default on a bad maxRestarts', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        makeRunner({ autoRestart: true, maxRestarts: -1 });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxRestarts'));
        warn.mockRestore();
    });

    it('maxRestarts: 0 disables restarting even when autoRestart is on', async () => {
        const { runner, workers } = makeRunner({ autoRestart: true, maxRestarts: 0 });

        const doomed = runner.push('a');
        doomed.catch(() => {});
        workers[0]!.emitError('boom');

        await expect(doomed).rejects.toThrow(/no longer usable/);
    });
});
