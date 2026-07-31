import { describe, expect, it, vi } from 'vitest';

describe('SSR / Node', () => {
    it('imports without touching a worker global', async () => {
        const module = await import('../src/index');

        expect(typeof module.createWorkerRunner).toBe('function');
        expect(typeof module.defineWorkerTasks).toBe('function');
        expect(typeof module.transfer).toBe('function');
    });

    it('creates no worker until something is pushed', async () => {
        const { createWorkerRunner } = await import('../src/index');
        const factory = vi.fn(() => {
            throw new Error('should not be called');
        });

        const runner = createWorkerRunner(factory);

        expect(factory).not.toHaveBeenCalled();
        expect(runner.size).toBe(0);
    });

    it('rejects a push on the server instead of throwing at import or call time', async () => {
        const { createWorkerRunner } = await import('../src/index');
        const runner = createWorkerRunner(() => {
            const Ctor = (globalThis as Record<string, unknown>).Worker as
                (new () => Worker) | undefined;

            return new Ctor!();
        });

        await expect(runner.push('anything')).rejects.toBeInstanceOf(TypeError);
    });

    it('defineWorkerTasks() warns and no-ops outside a worker', async () => {
        const { defineWorkerTasks } = await import('../src/index');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(() => defineWorkerTasks({ a: () => 1 })).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('outside a worker'));

        warn.mockRestore();
    });

    it('transfer() returns the value itself, so a shared task module stays importable', async () => {
        const { transfer } = await import('../src/index');
        const buffer = new ArrayBuffer(8);

        expect(() => transfer(buffer, [buffer])).not.toThrow();
    });
});
