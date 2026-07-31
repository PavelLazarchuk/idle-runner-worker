interface ClockHost {
    performance?: { now(): number };
}

export function hostNow(): number {
    const perf = (globalThis as ClockHost).performance;

    return perf ? perf.now() : Date.now();
}
