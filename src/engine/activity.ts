// When the models were last used, for the idle unload (entrypoints/background.ts).
// Only real inference counts -- text checks and voice clips -- not tab
// switches or page messages: with dozens of tabs open those never stop, and
// the models (hundreds of MB to GBs of WASM/GPU memory) would never unload.

let last = 0;
let running = 0;

/** Wrap a model call: counts as activity at its start and its end. */
export async function trackInference<T>(work: () => Promise<T>): Promise<T> {
  running++;
  last = Date.now();
  try {
    return await work();
  } finally {
    running--;
    last = Date.now();
  }
}

/** True when models have been used, nothing is running, and the last use was `minutes` ago or more. */
export function idleFor(minutes: number, now = Date.now()): boolean {
  return minutes > 0 && last > 0 && running === 0 && now - last >= minutes * 60_000;
}

/** After an unload: nothing loaded, so no further unloads until the next use. */
export function markUnloaded(): void {
  last = 0;
}
