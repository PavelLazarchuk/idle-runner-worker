export const ABORT_OP = 'abort';
export const UNDELIVERABLE_OP = 'undeliverable';

export interface CallMessage {
    id: number;
    name: string;
    payload?: unknown;
}

export interface AbortMessage {
    id: number;
    op: typeof ABORT_OP;
}

export type InboundMessage = CallMessage | AbortMessage;

export interface WireErrorLike {
    name: string;
    message: string;
    stack?: string;
}

export interface WireErrorRaw {
    raw: unknown;
}

export type WireError = WireErrorLike | WireErrorRaw;

export interface OkMessage {
    id: number;
    ok: true;
    value: unknown;
}

export interface FailMessage {
    id: number;
    ok: false;
    error: WireError;
}

export interface UndeliverableMessage {
    op: typeof UNDELIVERABLE_OP;
}

export type OutboundMessage = OkMessage | FailMessage;

export function isAbortMessage(message: InboundMessage): message is AbortMessage {
    return (message as AbortMessage).op === ABORT_OP;
}

export function isUndeliverableMessage(
    message: OutboundMessage | UndeliverableMessage | null
): message is UndeliverableMessage {
    return (message as UndeliverableMessage | null)?.op === UNDELIVERABLE_OP;
}

export function toWireError(error: unknown): WireError {
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack };
    }

    return { raw: error };
}

export function fromWireError(wire: WireError): unknown {
    const errorLike = wire as WireErrorLike;

    if (typeof errorLike?.message !== 'string') return (wire as WireErrorRaw)?.raw;

    const error = new Error(errorLike.message);
    error.name = errorLike.name;

    if (errorLike.stack) error.stack = errorLike.stack;

    return error;
}

export function describeValue(value: unknown): string {
    try {
        return String(value);
    } catch {
        return 'unprintable value';
    }
}
