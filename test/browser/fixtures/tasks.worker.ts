import { defineWorkerTasks, transfer } from '../../../src/index';

let cleanupRan = false;
let kept: ArrayBuffer | null = null;

function busyWait(ms: number): void {
    const start = performance.now();

    while (performance.now() - start < ms) {
        // burn
    }
}

defineWorkerTasks({
    sum: (numbers: number[]) => numbers.reduce((total, n) => total + n, 0),

    boom: () => {
        throw new RangeError('worker exploded');
    },

    throwString: () => {
        throw 'not an error';
    },

    later: async (value: string) => {
        await Promise.resolve();

        return `${value}!`;
    },

    squares: function* (count: number) {
        const out: number[] = [];

        for (let i = 0; i < count; i++) {
            out.push(i * i);
            yield;
        }

        return out;
    },

    forever: function* () {
        try {
            for (;;) yield;
        } finally {
            cleanupRan = true;
        }
    },

    cleanupRan: () => cleanupRan,

    scheduleUnrelatedThrow: () => {
        setTimeout(() => {
            throw new Error('a stray timer, unrelated to any task');
        }, 10);

        return 'scheduled';
    },

    byteLengthOf: (buffer: ArrayBuffer) => buffer.byteLength,

    makeBuffer: (size: number) => {
        kept = new ArrayBuffer(size);
        new Uint8Array(kept).fill(7);

        return transfer(kept, [kept]);
    },

    keptByteLength: () => (kept ? kept.byteLength : -1),

    streamy: async function* () {
        yield 1;

        return 'never gets here';
    },

    burn: function* (totalMs: number) {
        const start = performance.now();

        while (performance.now() - start < totalMs) {
            busyWait(3);
            yield;
        }

        return 'burned';
    },
});
