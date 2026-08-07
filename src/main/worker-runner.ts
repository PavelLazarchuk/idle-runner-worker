import {
    ABORT_OP,
    type OutboundMessage,
    type UndeliverableMessage,
    describeValue,
    fromWireError,
    isUndeliverableMessage,
} from '../shared/protocol';
import type {
    AnyWorkerTask,
    WorkerPushOptions,
    WorkerRunner,
    WorkerRunnerOptions,
    WorkerTasks,
} from '../shared/types';
import { createAbortError } from '../shared/abort-error';
import { devWarn } from '../shared/dev';

const DEFAULT_MAX_RESTARTS = 3;

function resolveMaxRestarts(maxRestarts: number | undefined): number {
    if (maxRestarts === undefined) return DEFAULT_MAX_RESTARTS;

    if (!Number.isFinite(maxRestarts) || maxRestarts < 0) {
        devWarn(`maxRestarts must be a finite number >= 0; using ${DEFAULT_MAX_RESTARTS}`);

        return DEFAULT_MAX_RESTARTS;
    }

    return Math.floor(maxRestarts);
}

// Internal members are _-prefixed so the build can mangle them.
interface PendingCall {
    _resolve: (value: unknown) => void;
    _reject: (reason: unknown) => void;
    _signal: AbortSignal | null;
    _onAbort: (() => void) | null;
}

/**
 * The main-thread half. Owns exactly one worker per runner, created lazily on the
 * first `push` — which is what keeps the module importable on a server, and what
 * keeps a runner that is never used from costing a thread.
 */
export function createWorkerRunner<T extends Record<keyof T, AnyWorkerTask> = WorkerTasks>(
    factory: () => Worker,
    options: WorkerRunnerOptions = {}
): WorkerRunner<T> {
    const onError = options.onError ?? null;
    const autoRestart = options.autoRestart === true;
    const maxRestarts = resolveMaxRestarts(options.maxRestarts);
    const pending = new Map<number, PendingCall>();
    let worker: Worker | null = null;
    let crashMessage: string | null = null;
    let everAnswered = false;
    let restarts = 0;
    let nextId = 1;

    const detach = (call: PendingCall): void => {
        if (call._signal && call._onAbort) {
            call._signal.removeEventListener('abort', call._onAbort);
        }

        call._signal = null;
        call._onAbort = null;
    };

    const handleMessage = (event: MessageEvent): void => {
        const data = event.data as OutboundMessage | UndeliverableMessage | null;

        everAnswered = true;

        if (isUndeliverableMessage(data)) {
            rejectAll(
                new Error(
                    'the worker could not deserialise the payload of a call; every call in flight was rejected, because the lost one cannot be identified'
                ),
                false
            );

            return;
        }

        if (typeof data?.id !== 'number' || typeof data.ok !== 'boolean') return;

        const call = pending.get(data.id);

        if (!call) return;

        pending.delete(data.id);
        detach(call);

        if (data.ok) {
            call._resolve(data.value);
        } else {
            call._reject(fromWireError(data.error));
        }
    };

    const rejectAll = (reason: unknown, notifyWorker: boolean): void => {
        if (pending.size === 0) return;

        const entries = [...pending];
        pending.clear();

        for (const [id, call] of entries) {
            detach(call);

            if (notifyWorker) postAbort(id);

            call._reject(reason);
        }
    };

    const handleWorkerError = (event: ErrorEvent): void => {
        const where = event.filename ? ` (${event.filename}:${event.lineno})` : '';
        const detail = `${event.message || 'uncaught error'}${where}`;

        if (everAnswered) {
            reportError(new Error(`uncaught error in the worker: ${detail}`));

            return;
        }

        if (autoRestart && restarts < maxRestarts) {
            restarts++;
            disposeWorker();
            rejectAll(
                new Error(
                    `worker failed: ${detail}; every call in flight was rejected and the next push starts a fresh worker`
                ),
                false
            );

            return;
        }

        const exhausted = autoRestart ? ` after ${restarts} restart(s)` : '';
        crashMessage = `worker failed: ${detail}; the worker is no longer usable${exhausted} — call terminate() before pushing again`;

        rejectAll(new Error(crashMessage), false);
    };

    const disposeWorker = (): void => {
        const target = worker;
        worker = null;
        everAnswered = false;

        if (!target) return;

        target.removeEventListener('message', handleMessage);
        target.removeEventListener('messageerror', handleMessageError);
        target.removeEventListener('error', handleWorkerError);
        target.terminate();
    };

    const handleMessageError = (): void => {
        everAnswered = true;

        rejectAll(new Error('worker sent a message that could not be deserialised'), false);
    };

    const ensureWorker = (): Worker => {
        if (worker) return worker;

        const created = factory();
        created.addEventListener('message', handleMessage);
        created.addEventListener('messageerror', handleMessageError);
        created.addEventListener('error', handleWorkerError);
        worker = created;

        return created;
    };

    const postAbort = (id: number): void => {
        try {
            worker?.postMessage({ id, op: ABORT_OP });
        } catch {
            // empty
        }
    };

    const abortCall = (id: number): void => {
        const call = pending.get(id);

        if (!call) return;

        pending.delete(id);
        detach(call);
        postAbort(id);
        call._reject(createAbortError());
    };

    const reportError = (error: unknown): void => {
        if (!onError || (error as { name?: unknown } | null)?.name === 'AbortError') return;

        try {
            onError(error);
        } catch {
            // empty
        }
    };

    const guard = <V>(promise: Promise<V>): Promise<V> => {
        if (onError) promise.catch(reportError);

        return promise;
    };

    const push = (
        name: string,
        payload?: unknown,
        pushOptions?: WorkerPushOptions
    ): Promise<unknown> => {
        const signal = pushOptions?.signal ?? null;

        if (signal?.aborted) return guard(Promise.reject(createAbortError()));

        if (crashMessage) return guard(Promise.reject(new Error(crashMessage)));

        let target: Worker;

        try {
            target = ensureWorker();
        } catch (error) {
            return guard(Promise.reject(error));
        }

        const id = nextId++;

        return guard(
            new Promise<unknown>((resolve, reject) => {
                const call: PendingCall = {
                    _resolve: resolve,
                    _reject: reject,
                    _signal: signal,
                    _onAbort: null,
                };

                pending.set(id, call);

                if (signal) {
                    const onAbort = () => abortCall(id);
                    call._onAbort = onAbort;
                    signal.addEventListener('abort', onAbort, { once: true });
                }

                try {
                    target.postMessage({ id, name, payload }, pushOptions?.transfer ?? []);
                } catch (error) {
                    pending.delete(id);
                    detach(call);
                    reject(
                        new Error(
                            `payload for task "${name}" could not be sent to the worker: ${describeValue(error)}`
                        )
                    );
                }
            })
        );
    };

    const runner = {
        push,
        clear(reason?: unknown): void {
            rejectAll(reason === undefined ? createAbortError() : reason, true);
        },
        terminate(): void {
            crashMessage = null;
            restarts = 0;

            disposeWorker();
            rejectAll(createAbortError(), false);
        },
        get size(): number {
            return pending.size;
        },
    };

    return runner as unknown as WorkerRunner<T>;
}
