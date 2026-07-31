import type { WorkerTask, WorkerTasks } from '../shared/types';
import { type TaskHost, type WorkerScope, installTaskHost } from './task-host';
import { devWarn } from '../shared/dev';

interface MaybeWorkerScope {
    postMessage?: unknown;
    addEventListener?: unknown;
    window?: unknown;
}

function isWorkerScope(scope: MaybeWorkerScope): boolean {
    return (
        typeof scope.postMessage === 'function' &&
        typeof scope.addEventListener === 'function' &&
        typeof scope.window === 'undefined'
    );
}

let host: TaskHost | null = null;

export function defineWorkerTasks<T extends Record<keyof T, WorkerTask>>(tasks: T): void {
    if (!isWorkerScope(globalThis as MaybeWorkerScope)) {
        devWarn('defineWorkerTasks() was called outside a worker; no tasks registered');

        return;
    }

    host ??= installTaskHost(globalThis as unknown as WorkerScope);
    host.register(tasks as WorkerTasks);
}
