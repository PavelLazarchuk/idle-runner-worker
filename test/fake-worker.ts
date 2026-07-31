type Listener = (event: unknown) => void;

export interface PostedMessage {
    message: Record<string, unknown>;
    transfer: Transferable[] | undefined;
}

export class FakeWorker {
    readonly posted: PostedMessage[] = [];
    terminated = false;
    postError: unknown = null;

    private readonly listeners = new Map<string, Set<Listener>>();

    postMessage(message: unknown, transfer?: Transferable[]): void {
        if (this.postError) throw this.postError;

        this.posted.push({ message: message as Record<string, unknown>, transfer });
    }

    addEventListener(type: string, listener: Listener): void {
        let bucket = this.listeners.get(type);

        if (!bucket) this.listeners.set(type, (bucket = new Set()));

        bucket.add(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.get(type)?.delete(listener);
    }

    terminate(): void {
        this.terminated = true;
    }

    get asWorker(): Worker {
        return this as unknown as Worker;
    }

    get messages(): Record<string, unknown>[] {
        return this.posted.map(entry => entry.message);
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }

    idOf(index = 0): number {
        return this.messages[index]!.id as number;
    }

    reply(message: unknown): void {
        this.emit('message', { data: message });
    }

    emitError(message: string, filename?: string, lineno?: number): void {
        this.emit('error', { message, filename, lineno });
    }

    emitMessageError(): void {
        this.emit('messageerror', { data: null });
    }

    private emit(type: string, event: unknown): void {
        for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }
}
