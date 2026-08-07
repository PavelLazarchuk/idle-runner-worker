/* eslint-disable @typescript-eslint/no-explicit-any */

export type WorkerTask = (payload: any) => any;

export type AnyWorkerTask = (...args: any[]) => any;

/* eslint-enable @typescript-eslint/no-explicit-any */

export type WorkerTasks = Record<string, WorkerTask>;

export type WorkerResult<R> =
    R extends Generator<unknown, infer V, unknown> ? Awaited<V> : Awaited<R>;

type FirstParam<F extends AnyWorkerTask> =
    Parameters<F> extends readonly [] ? undefined : Parameters<F>[0];

type PayloadIsOptional<F extends AnyWorkerTask> =
    [] extends Parameters<F> ? true : undefined extends FirstParam<F> ? true : false;

export type WorkerPushArgs<F extends AnyWorkerTask> =
    Parameters<F> extends [unknown, unknown, ...unknown[]]
        ? [payload: 'this task takes more than one argument; a worker task receives one payload']
        : PayloadIsOptional<F> extends true
          ? [payload?: FirstParam<F>, options?: WorkerPushOptions]
          : [payload: FirstParam<F>, options?: WorkerPushOptions];

export interface WorkerPushOptions {
    signal?: AbortSignal;
    transfer?: Transferable[];
}

export interface WorkerRunnerOptions {
    onError?: (error: unknown) => void;
    autoRestart?: boolean;
    maxRestarts?: number;
}

export interface WorkerPoolOptions extends WorkerRunnerOptions {
    size?: number;
}

export interface WorkerRunner<T extends Record<keyof T, AnyWorkerTask> = WorkerTasks> {
    push<K extends keyof T & string>(
        name: K,
        ...args: WorkerPushArgs<T[K]>
    ): Promise<WorkerResult<ReturnType<T[K]>>>;
    clear(reason?: unknown): void;
    terminate(): void;
    readonly size: number;
}
