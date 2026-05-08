/**
 * Shared RVF Adapter Singleton
 *
 * Provides a single RvfNativeAdapter instance for .agentic-qe/patterns.rvf.
 * Used by both the kernel (agent branching) and DreamEngine (COW dreams)
 * to avoid dual file handles to the same .rvf file.
 *
 * Returns null when native bindings are unavailable — callers degrade
 * gracefully.
 *
 * @module integrations/ruvector/shared-rvf-adapter
 */

import type { RvfNativeAdapter } from './rvf-native-adapter.js';

let sharedAdapter: RvfNativeAdapter | null = null;
let initAttempted = false;

/**
 * Get or create the shared RvfNativeAdapter singleton for patterns.rvf.
 *
 * @param dataDir - Data directory (default: .agentic-qe)
 * @param dimensions - Vector dimensions (default: 384)
 * @returns The shared adapter, or null if native bindings are unavailable
 */
export function getSharedRvfAdapter(
  dataDir = '.agentic-qe',
  dimensions = 384,
): RvfNativeAdapter | null {
  if (initAttempted) return sharedAdapter;
  initAttempted = true;

  try {
    // Dynamic require to match the bundled build pattern used elsewhere
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isRvfNativeAvailable, createRvfStore, openRvfStore } = require('./rvf-native-adapter.js');

    if (!isRvfNativeAvailable()) {
      console.warn(
        '[RVF] Native bindings unavailable — agent branching and dream COW disabled. ' +
        'Install @ruvector/rvf-node to enable.',
      );
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const rvfPath = path.join(dataDir, 'patterns.rvf');

    // Open-or-create with a try-ladder rather than `existsSync` gate.
    // Reasons:
    //  1. RVF native's `RvfDatabase.create()` throws `0x0303 FsyncFailed`
    //     when the target file already exists (verified against both 0.1.7
    //     and 0.1.8 native binaries on linux-arm64). Earlier init phases
    //     legitimately produce patterns.rvf, so subsequent CLI / MCP boot
    //     would crash without this guard. (Jordi #439 / RUFLO P020.)
    //  2. A bare `existsSync(...) ? open : create` is racy across
    //     processes — two parallel `aqe` invocations during init can both
    //     observe absent and both call `create`, with the second hitting
    //     FsyncFailed regardless. The try-ladder degrades to whichever
    //     path the OS actually permits.
    sharedAdapter = openOrCreateRvf(openRvfStore, createRvfStore, rvfPath, dimensions);
    return sharedAdapter;
  } catch (error) {
    console.warn(
      '[RVF] Shared adapter init failed:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Race-tolerant open-or-create.
 * Tries open first (cheap, succeeds for the common case where init has
 * already produced the file). On open failure we attempt create. On the
 * concurrent-create loser, create itself fails with `FsyncFailed`; we
 * retry open once more. Any final exception bubbles up to the caller.
 *
 * Also asserts `dim()` matches the caller-requested `dimensions` after
 * open so silent dimension drift between releases / configs is detected
 * — a bad-dim file is closed and create() is attempted (fail-loud rather
 * than corrupt-silently, which would manifest as wrong vector hits later).
 */
function openOrCreateRvf(
  openFn: (p: string) => RvfNativeAdapter,
  createFn: (p: string, dim: number) => RvfNativeAdapter,
  rvfPath: string,
  dimensions: number,
): RvfNativeAdapter {
  // Pass 1: try to open whatever's there.
  let opened: RvfNativeAdapter | null = null;
  try {
    opened = openFn(rvfPath);
  } catch {
    opened = null;
  }

  if (opened) {
    const actualDim = opened.dimension();
    if (actualDim === dimensions) return opened;
    console.warn(
      `[RVF] patterns.rvf dimension mismatch: file=${actualDim} requested=${dimensions} — ` +
        'closing and degrading. Delete the .rvf file to recreate at the requested dim.',
    );
    try { opened.close(); } catch { /* best-effort */ }
    // Don't auto-recreate over a dim-mismatched file. Surface to caller via
    // throw so getSharedRvfAdapter logs and returns null (degrade to SQLite).
    throw new Error(
      `RVF dimension mismatch (file=${actualDim}, requested=${dimensions})`,
    );
  }

  // Pass 2: open failed → try create.
  try {
    return createFn(rvfPath, dimensions);
  } catch (createErr) {
    // Pass 3: create failed (likely FsyncFailed because a peer process won
    // the race). Try open one more time.
    try {
      const reopened = openFn(rvfPath);
      if (reopened.dimension() !== dimensions) {
        try { reopened.close(); } catch { /* best-effort */ }
        throw new Error(
          `RVF dimension mismatch after race (file=${reopened.dimension()}, requested=${dimensions})`,
        );
      }
      return reopened;
    } catch {
      // Fall through with the more informative original error.
      throw createErr instanceof Error ? createErr : new Error(String(createErr));
    }
  }
}

/** Close the shared adapter and reset the singleton. */
export function resetSharedRvfAdapter(): void {
  if (sharedAdapter) {
    try { sharedAdapter.close(); } catch { /* best effort */ }
    sharedAdapter = null;
  }
  initAttempted = false;
}
