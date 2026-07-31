class TransferredResult {
    constructor(
        readonly _value: unknown,
        readonly _list: Transferable[]
    ) {}
}

export function transfer<T>(value: T, transferables: Transferable[]): T {
    return new TransferredResult(value, transferables) as unknown as T;
}

export function unwrapTransfer(result: unknown): { _value: unknown; _list: Transferable[] } {
    return result instanceof TransferredResult ? result : { _value: result, _list: [] };
}
