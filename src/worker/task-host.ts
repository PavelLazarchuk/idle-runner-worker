import {
    type CallMessage,
    type InboundMessage,
    type OutboundMessage,
    UNDELIVERABLE_OP,
    type UndeliverableMessage,
    describeValue,
    isAbortMessage,
    toWireError,
} from '../shared/protocol';
import type { WorkerTask, WorkerTasks } from '../shared/types';
import { devWarn } from '../shared/dev';
import { hostNow } from './clock';
import { unwrapTransfer } from './transfer';
import { yieldToEventLoop } from './yield';

const DEFAULT_SLICE_MS = 16;

export interface WorkerScope {
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'messageerror', listener: () => void): void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface TaskHostOptions {
    yieldControl?: () => Promise<void>;
    now?: () => number;
    sliceMs?: number;
}

export interface TaskHost {
    register(tasks: WorkerTasks): void;
}

interface RunningCall {
    _id: number;
    _aborted: boolean;
}

function isGenerator(value: unknown): value is Generator<unknown, unknown, unknown> {
    const candidate = value as Record<PropertyKey, unknown> | null;

    return (
        typeof candidate?.next === 'function' &&
        typeof candidate?.throw === 'function' &&
        typeof candidate?.return === 'function' &&
        typeof candidate?.[Symbol.iterator] === 'function'
    );
}

function isAsyncGenerator(value: unknown): boolean {
    const candidate = value as Record<PropertyKey, unknown> | null;

    return (
        typeof candidate?.next === 'function' &&
        typeof candidate?.[Symbol.asyncIterator] === 'function'
    );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

export function installTaskHost(scope: WorkerScope, options: TaskHostOptions = {}): TaskHost {
    const yieldControl = options.yieldControl ?? yieldToEventLoop;
    const now = options.now ?? hostNow;
    const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
    const tasks = new Map<string, WorkerTask>();
    const queue: CallMessage[] = [];
    let running: RunningCall | null = null;
    let pumping = false;

    const post = (
        message: OutboundMessage | UndeliverableMessage,
        transfer: Transferable[]
    ): { _error: unknown } | null => {
        try {
            scope.postMessage(message, transfer);

            return null;
        } catch (error) {
            return { _error: error };
        }
    };

    const fail = (id: number, error: unknown): void => {
        if (!post({ id, ok: false, error: toWireError(error) }, [])) return;

        post({ id, ok: false, error: { name: 'Error', message: describeValue(error) } }, []);
    };

    const succeed = (id: number, name: string, result: unknown): void => {
        const { _value, _list } = unwrapTransfer(result);
        const failure = post({ id, ok: true, value: _value }, _list);

        if (!failure) return;

        fail(
            id,
            new Error(
                `result of task "${name}" could not be sent to the main thread: ${describeValue(failure._error)}`
            )
        );
    };

    const closeGenerator = (generator: Generator<unknown, unknown, unknown>): void => {
        try {
            generator.return(undefined);
        } catch {
            devWarn('generator cleanup threw');
        }
    };

    const drive = async (
        generator: Generator<unknown, unknown, unknown>,
        state: RunningCall
    ): Promise<unknown> => {
        for (;;) {
            const sliceEnd = now() + sliceMs;

            do {
                const step = generator.next();

                if (step.done) return step.value;
            } while (now() < sliceEnd);

            await yieldControl();

            if (state._aborted) {
                closeGenerator(generator);

                return undefined;
            }
        }
    };

    const runCall = async (call: CallMessage): Promise<void> => {
        const task = tasks.get(call.name);

        if (!task) {
            fail(call.id, new Error(`unknown task "${call.name}"`));

            return;
        }

        const state: RunningCall = { _id: call.id, _aborted: false };
        running = state;

        try {
            let result: unknown = task(call.payload);

            if (isGenerator(result)) {
                result = await drive(result, state);
            } else if (isAsyncGenerator(result)) {
                throw new Error(
                    `task "${call.name}" returned an async generator, which is not supported; use a generator function or an async function`
                );
            } else if (isThenable(result)) {
                result = await result;
            }

            if (state._aborted) return;

            succeed(call.id, call.name, result);
        } catch (error) {
            if (state._aborted) return;

            fail(call.id, error);
        } finally {
            running = null;
        }
    };

    const pump = async (): Promise<void> => {
        if (pumping) return;

        pumping = true;

        try {
            for (;;) {
                const call = queue.shift();

                if (!call) return;

                await runCall(call);
            }
        } finally {
            pumping = false;
        }
    };

    const abort = (id: number): void => {
        if (running?._id === id) {
            running._aborted = true;

            return;
        }

        const index = queue.findIndex(call => call.id === id);

        if (index !== -1) queue.splice(index, 1);
    };

    scope.addEventListener('message', event => {
        const data = event.data as InboundMessage | null;

        if (typeof data?.id !== 'number') return;

        if (isAbortMessage(data)) {
            abort(data.id);

            return;
        }

        queue.push(data);
        void pump();
    });

    scope.addEventListener('messageerror', () => {
        post({ op: UNDELIVERABLE_OP }, []);
    });

    return {
        register(next: WorkerTasks): void {
            for (const name of Object.keys(next)) {
                const task = next[name];

                if (typeof task !== 'function') {
                    devWarn(`task "${name}" is not a function; ignored`);
                    continue;
                }
                if (tasks.has(name)) devWarn(`task "${name}" was redefined`);

                tasks.set(name, task);
            }
        },
    };
}
