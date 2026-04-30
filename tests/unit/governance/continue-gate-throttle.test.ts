/**
 * Regression tests for bug #3: continue-gate-integration synthetic token estimate
 * caused the guidance gate's budget-slope detector to fire on legitimate one-off
 * MCP tool calls.
 *
 * Original symptom: `coverage_analyze_sublinear` (and any other domain MCP tool)
 * returned `Task blocked by governance: Budget acceleration detected (slope: 500.0000 > 0.02)`
 * after as few as 2 tool invocations.
 *
 * Root cause: continue-gate-integration.ts passed `totalTokensUsed: history.length * 500`
 * to the guidance gate. Linear regression on (step, 500*step) yields slope = 500,
 * far above the 0.02 default threshold.
 *
 * Fix: pin `totalTokensUsed = 0` and `budgetRemaining.tokens = MAX_SAFE_INTEGER`
 * until real token telemetry is wired in. Other guidance checks (coherence,
 * uncertainty, rework) still operate on real signals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  governanceFlags,
  continueGateIntegration,
} from '../../../src/governance/index.js';

describe('ContinueGateIntegration — budget-slope must not fire on synthetic data (bug #3)', () => {
  beforeEach(() => {
    governanceFlags.reset();
    continueGateIntegration.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not block successive distinct tool calls with budget-slope reason', async () => {
    const agentId = 'budget-slope-regression-agent';
    // Simulate a sequence of 5 distinct successful MCP tool calls — exactly
    // the kind of activity that previously tripped the slope detector.
    const baseTime = Date.now() - 10_000;
    const actions = [
      'mcp:coverage_analyze_sublinear',
      'mcp:test_generate_enhanced',
      'mcp:fleet_status',
      'mcp:agent_list',
      'mcp:fleet_health',
    ];
    actions.forEach((actionType, i) => {
      continueGateIntegration.recordAction({
        agentId,
        actionType,
        target: 'src/' + i,
        success: true,
        timestamp: baseTime + i * 200,
      });
    });

    const decision = await continueGateIntegration.evaluate(agentId);

    // Must not be blocked at all.
    expect(decision.shouldContinue).toBe(true);
    // And specifically must not cite budget acceleration / slope.
    if (decision.reason) {
      expect(decision.reason.toLowerCase()).not.toMatch(/budget acceleration|slope/);
    }
  });

  it('still blocks legitimate consecutive-identical actions (local detection unchanged)', async () => {
    // The fix must not weaken local loop detection — agents that hammer the
    // same target repeatedly should still be flagged.
    const flags = governanceFlags.getFlags().continueGate;
    const agentId = 'consecutive-identical-agent';
    const sameAction = { actionType: 'file:edit', target: 'same-file.ts', success: false };
    for (let i = 0; i < flags.maxConsecutiveRetries + 1; i++) {
      continueGateIntegration.recordAction({
        agentId,
        ...sameAction,
        timestamp: Date.now() - 1000 + i * 10,
      });
    }

    const decision = await continueGateIntegration.evaluate(agentId);

    expect(decision.reason).toBeDefined();
    expect(decision.reason).toMatch(/consecutive|retries/i);
  });

  it('throttle decision (if it fires from non-budget signals) is treated as soft, not block', async () => {
    // Even though we expect throttle to be rare after the fix, the mapping
    // contract is: throttle means shouldContinue:true with a throttleMs hint.
    // Only pause/stop should block. Verify by directly invoking the private
    // mapper through a faked decision.
    // (Black-box approach: drive the integration with a high-rework history
    // that tends to produce a non-continue decision.)
    const agentId = 'rework-heavy-agent';
    const baseTime = Date.now() - 10_000;
    // Mix of failures so reworkRatio is high but actions differ
    for (let i = 0; i < 8; i++) {
      continueGateIntegration.recordAction({
        agentId,
        actionType: `mcp:tool-${i}`,
        target: `src/${i}`,
        success: false, // forces rework ratio = 1.0
        timestamp: baseTime + i * 100,
      });
    }

    const decision = await continueGateIntegration.evaluate(agentId);

    // High rework ratio should ultimately produce a block decision (pause/stop)
    // OR continue. We assert a structural invariant: if reason mentions throttle
    // (slow down), shouldContinue must be true; if it mentions pause/stop or
    // exceeded thresholds, shouldContinue may be false. Either way the result
    // is internally consistent.
    if (decision.reason && /throttle|slow down/i.test(decision.reason)) {
      expect(decision.shouldContinue).toBe(true);
    }
  });

  it('does not produce a budget-acceleration error message for any small history', async () => {
    // Any history length from 1 to 20 must not produce "budget acceleration"
    // because the synthetic estimate has been removed.
    for (const len of [1, 2, 3, 5, 10, 20]) {
      const agentId = `len-${len}-agent`;
      for (let i = 0; i < len; i++) {
        continueGateIntegration.recordAction({
          agentId,
          actionType: `mcp:tool-${i}`,
          target: `src/${i}`,
          success: true,
          timestamp: Date.now() - 5000 + i * 100,
        });
      }
      const decision = await continueGateIntegration.evaluate(agentId);
      if (decision.reason) {
        expect(decision.reason.toLowerCase()).not.toMatch(/budget acceleration|slope/);
      }
    }
  });
});
