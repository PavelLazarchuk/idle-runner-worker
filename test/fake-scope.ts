import type { WorkerScope } from '../src/worker/task-host';

export interface PostedResult {
    message: Record<string, unknown>;
    transfer: Transferable[] | undefined;
}

export class FakeScope implements WorkerScope {
    readonly posted: PostedResult[] = [];
    postError: unknown = null;

    private listener: ((event: { data: unknown }) => void) | null = null;
    private errorListener: (() => void) | null = null;

    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    addEventListener(type: 'messageerror', listener: () => void): void;
    addEventListener(type: 'message' | 'messageerror', listener: (event: never) => void): void {
        if (type === 'message') this.listener = listener as (event: { data: unknown }) => void;
        if (type === 'messageerror') this.errorListener = listener as () => void;
    }

    postMessage(message: unknown, transfer?: Transferable[]): void {
        if (this.postError) throw this.postError;

        this.posted.push({ message: message as Record<string, unknown>, transfer });
    }

    get messages(): Record<string, unknown>[] {
        return this.posted.map(entry => entry.message);
    }

    get listenerCount(): number {
        return this.listener ? 1 : 0;
    }

    send(message: unknown): void {
        this.listener?.({ data: message });
    }

    sendUndeserialisable(): void {
        this.errorListener?.();
    }
}

export class ManualYield {
    private waiters: Array<() => void> = [];

    readonly yieldControl = (): Promise<void> =>
        new Promise<void>(resolve => {
            this.waiters.push(resolve);
        });

    get pending(): number {
        return this.waiters.length;
    }

    release(): void {
        const batch = this.waiters;
        this.waiters = [];

        for (const resolve of batch) resolve();
    }
}

export function tick(): Promise<void> {
    return new Promise<void>(resolve => {
        setTimeout(resolve, 0);
    });
}

export async function step(manual: ManualYield, steps = 1): Promise<void> {
    for (let i = 0; i < steps; i++) {
        manual.release();
        await tick();
    }
}
