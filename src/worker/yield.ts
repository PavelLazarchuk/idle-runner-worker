interface YieldHost {
    MessageChannel?: typeof MessageChannel;
    setTimeout: (callback: () => void, ms: number) => unknown;
}

export function yieldToEventLoop(): Promise<void> {
    const host = globalThis as unknown as YieldHost;

    return new Promise<void>(resolve => {
        if (typeof host.MessageChannel !== 'function') {
            host.setTimeout(resolve, 0);

            return;
        }

        const channel = new host.MessageChannel();

        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };

        channel.port2.postMessage(0);
    });
}
