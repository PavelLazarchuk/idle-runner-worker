import type {
    AnyWorkerTask,
    WorkerPoolOptions,
    WorkerPushOptions,
    WorkerRunner,
    WorkerTasks,
} from '../shared/types';
import { createWorkerRunner } from './worker-runner';
import { devWarn } from '../shared/dev';

const MAX_DEFAULT_SIZE = 4;

declare const navigator: { hardwareConcurrency?: number } | undefined;

function defaultSize(): number {
    const cores = typeof navigator === 'undefined' ? undefined : navigator?.hardwareConcurrency;

    if (typeof cores !== 'number' || !Number.isFinite(cores)) return 2;

    return Math.max(1, Math.min(MAX_DEFAULT_SIZE, Math.floor(cores) - 1));
}

function resolveSize(size: number | undefined): number {
    if (size === undefined) return defaultSize();

    if (!Number.isFinite(size) || size < 1) {
        devWarn('size must be a finite number >= 1; using 1');

        return 1;
    }

    return Math.floor(size);
}

/**
 * A `WorkerRunner` backed by several workers, so calls run in parallel instead of
 * queueing behind each other in one thread. Same interface as
 * {@link createWorkerRunner} — the same `factory`, the same task registry, the same
 * `push` — so it is a drop-in replacement once one thread stops being enough.
 *
 * ```ts
 * const runner = createWorkerPool<typeof tasks>(
 *     () => new Worker(new URL('./tasks.worker.ts', import.meta.url), { type: 'module' }),
 *     { size: 4 }
 * );
 * ```
 *
 * Each call goes to the least busy worker, ties to the earliest one, which is what
 * keeps the pool at a single thread until real concurrency asks for another. Workers
 * share nothing: a task that relies on state left behind by an earlier call must not
 * run on a pool.
 */
export function createWorkerPool<T extends Record<keyof T, AnyWorkerTask> = WorkerTasks>(
    factory: () => Worker,
    options: WorkerPoolOptions = {}
): WorkerRunner<T> {
    const { size, ...runnerOptions } = options;
    const workers: WorkerRunner<T>[] = [];

    for (let i = resolveSize(size); i > 0; i--) {
        workers.push(createWorkerRunner<T>(factory, runnerOptions));
    }

    const leastBusy = (): WorkerRunner<T> => {
        let best = workers[0]!;

        for (const candidate of workers) {
            if (candidate.size === 0) return candidate;
            if (candidate.size < best.size) best = candidate;
        }

        return best;
    };

    const pool = {
        push(name: string, payload?: unknown, pushOptions?: WorkerPushOptions): Promise<unknown> {
            return (leastBusy() as unknown as WorkerRunner).push(name, payload, pushOptions);
        },
        clear(reason?: unknown): void {
            for (const worker of workers) worker.clear(reason);
        },
        terminate(): void {
            for (const worker of workers) worker.terminate();
        },
        get size(): number {
            let total = 0;

            for (const worker of workers) total += worker.size;

            return total;
        },
    };

    return pool as unknown as WorkerRunner<T>;
}
