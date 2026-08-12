/**
 * AgentSession transport selection + protocol-failure ladder
 * (architecture §2 / §9.3, VAL-DAEMON-013).
 *
 * Scripted TransportSession stand-ins — no real daemon, no API key, no model.
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSession, type Mode, type OpenDaemonResult } from '../src/main/droid/agent.js';
import type { TransportSession, SessionTool } from '../src/main/droid/sdk/transport.js';
import type { TurnResult } from '../src/main/droid/turn.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { AgentDef, HostInvocableInventory, ToolPolicySpec } from '../src/shared/types.js';

const agent: AgentDef = {
  name: 'scout',
  purpose: 'look around',
  model: 'scripted',
  reasoningEffort: 'off',
  systemPrompt: 'You scout.',
  userPrompt: '{{request}}',
  writes: null,
  envelope: 'none',
  color: '#abc',
};

function emptyUsage(): TurnResult {
  return {
    text: 'ok',
    usage: null,
    reason: 'completed',
    interrupted: false,
    structuredOutput: null,
  };
}

interface ScriptedOpts {
  id?: string;
  /** How many send() calls throw before succeeding. */
  failSends?: number;
  failStart?: boolean;
  tools?: SessionTool[];
}

function scriptedSession(opts: ScriptedOpts = {}): TransportSession & {
  sendCalls: number;
  startCalls: number;
  closed: boolean;
} {
  let fails = opts.failSends ?? 0;
  let alive = true;
  let closed = false;
  const session = {
    sendCalls: 0,
    startCalls: 0,
    get closed() {
      return closed;
    },
    id: opts.id ?? `sess_${Math.random().toString(36).slice(2, 8)}`,
    get alive() {
      return alive && !closed;
    },
    pid: undefined as number | undefined,
    lastUserMessageId: null as string | null,
    availableModels: [],
    activeModel: 'scripted',
    async start() {
      session.startCalls += 1;
      if (opts.failStart) throw new Error('handshake refused');
    },
    async send() {
      session.sendCalls += 1;
      if (fails > 0) {
        fails -= 1;
        throw new Error('protocol boom');
      }
      return emptyUsage();
    },
    async applySettings() {
      return { model: 'scripted' };
    },
    async contextStats() {
      return null;
    },
    async contextBreakdown() {
      return null;
    },
    async compact() {
      return null;
    },
    async getRewindInfo() {
      return null;
    },
    async rewind() {
      return null;
    },
    async listTools() {
      return opts.tools ?? [];
    },
    async interrupt() {},
    async close() {
      closed = true;
      alive = false;
    },
    kill() {
      closed = true;
      alive = false;
    },
    spawnArgs() {
      return [];
    },
  };
  return session;
}

describe('AgentSession transport selection', () => {
  let support: string;
  let tracer: Tracer;
  let worktree: string;
  let runId: string;
  let modes: Mode[];

  beforeEach(() => {
    support = mkdtempSync(join(tmpdir(), 'foundry-agent-transport-'));
    worktree = mkdtempSync(join(tmpdir(), 'foundry-agent-wt-'));
    const db = openDb(projectDbPath(support, 'proj'));
    tracer = new Tracer(db, projectRunsDir(support, 'proj'));
    runId = `run_${Math.random().toString(36).slice(2, 8)}`;
    modes = [];
  });

  afterEach(async () => {
    // nothing to kill — scripted sessions only
  });

  function beginRun(mode: Mode = 'daemon'): void {
    tracer.startRun({
      runId,
      projectId: 'proj',
      pipeline: {
        id: 'p',
        name: 'p',
        description: '',
        acceptance: { kind: 'all_phases_pass' },
        phases: [],
      },
      request: 'go',
      engineer: 'test',
      worktreePath: worktree,
      branch: null,
      baseRef: 'main',
      mode,
    });
  }

  function makeSession(
    overrides: Partial<ConstructorParameters<typeof AgentSession>[1]> & {
      agent?: AgentDef;
    } = {},
  ): AgentSession {
    const { agent: agentOverride, ...deps } = overrides;
    return new AgentSession(agentOverride ?? agent, {
      cliPath: 'droid-not-used',
      runId,
      worktree,
      turnTimeoutMs: 5_000,
      tracer,
      policy: { protectedPaths: [] },
      onModeChange: (mode) => {
        modes.push(mode);
        tracer.setRunMode(runId, mode);
      },
      ...deps,
    });
  }

  it('defaults to daemon mode and keeps it when the daemon session opens', async () => {
    beginRun('daemon');
    const daemon = scriptedSession({ id: 'daemon-1' });
    const session = makeSession({
      transport: 'daemon',
      openDaemonSession: async (): Promise<OpenDaemonResult> => ({
        ok: true,
        session: daemon,
      }),
      openRpcSession: async () => {
        throw new Error('rpc must not open when daemon succeeds');
      },
    });
    expect(session.currentMode).toBe('daemon');

    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });
    const outcome = await session.send('hello', { phaseId });
    expect(outcome.text).toBe('ok');
    expect(session.currentMode).toBe('daemon');
    expect(daemon.sendCalls).toBe(1);
    // Constructor already chose daemon, so onModeChange stays quiet; the run
    // row still reflects the settings default written at startRun.
    expect(modes).toEqual([]);
    expect(tracer.run(runId)!.mode).toBe('daemon');
    expect(tracer.agentSessions(runId)[0]!.mode).toBe('daemon');
    await session.close();
  });

  it('transport=subprocess forces SdkSession and never opens the daemon', async () => {
    beginRun('rpc');
    let daemonOpens = 0;
    const rpc = scriptedSession({ id: 'rpc-1' });
    const session = makeSession({
      transport: 'subprocess',
      openDaemonSession: async () => {
        daemonOpens += 1;
        return { ok: false, reason: 'should not be called' };
      },
      openRpcSession: async () => rpc,
    });
    expect(session.currentMode).toBe('rpc');

    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });
    await session.send('hello', { phaseId });
    expect(daemonOpens).toBe(0);
    expect(session.currentMode).toBe('rpc');
    expect(rpc.sendCalls).toBe(1);
    expect(tracer.run(runId)!.mode).toBe('rpc');
    expect(tracer.agentSessions(runId)[0]!.mode).toBe('rpc');
    await session.close();
  });

  it('falls back to subprocess with a traced warning when the daemon is blocked', async () => {
    beginRun('daemon');
    const rpc = scriptedSession({ id: 'rpc-fallback' });
    const session = makeSession({
      transport: 'daemon',
      openDaemonSession: async () => ({
        ok: false,
        reason: 'daemon connect_failed: refused',
      }),
      openRpcSession: async () => rpc,
    });

    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });
    await session.send('hello', { phaseId });
    expect(session.currentMode).toBe('rpc');
    expect(rpc.sendCalls).toBe(1);
    expect(modes).toEqual(['rpc']);
    expect(tracer.run(runId)!.mode).toBe('rpc');
    expect(tracer.agentSessions(runId)[0]!.mode).toBe('rpc');

    const fallbacks = tracer
      .eventsAfter(runId, 0, 1000)
      .filter((e) => e.type === 'log' && e.name.includes('fallback to subprocess'));
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(fallbacks[0]!.name).toContain('daemon connect_failed');
    await session.close();
  });

  it('fails closed to subprocess when restrictTools cannot be enforced on daemon', async () => {
    beginRun('daemon');
    const rpc = scriptedSession({ id: 'rpc-restrict' });
    // No openDaemonSession seam: production openDaemonProduction short-circuits
    // on restrictTools before any DaemonManager.ensure() / spawn.
    const session = makeSession({
      transport: 'daemon',
      agent: { ...agent, tools: ['Read'] },
      openRpcSession: async () => rpc,
    });

    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });
    await session.send('hello', { phaseId });
    expect(session.currentMode).toBe('rpc');
    expect(rpc.sendCalls).toBe(1);
    const fallbacks = tracer
      .eventsAfter(runId, 0, 1000)
      .filter((e) => e.type === 'log' && e.name.includes('restrictTools'));
    expect(fallbacks.length).toBeGreaterThanOrEqual(1);
    expect(fallbacks[0]!.name).toContain('fallback to subprocess');
    await session.close();
  });

  it('degrades daemon → rpc → oneshot across two protocol strikes (VAL-DAEMON-013)', async () => {
    beginRun('daemon');
    const daemon = scriptedSession({ id: 'd-ladder', failSends: 1 });
    const rpc = scriptedSession({ id: 'r-ladder', failSends: 1 });
    // After two strikes the session is oneshot; without a real CLI the oneshot
    // send fails. Capture that and still verify the ladder via mode + events.

    const session = makeSession({
      transport: 'daemon',
      openDaemonSession: async () => ({ ok: true, session: daemon }),
      openRpcSession: async () => rpc,
    });
    expect(session.currentMode).toBe('daemon');

    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });

    await session.send('hello', { phaseId }).catch((e: Error) => e);

    // Initial daemon is the constructor default (no onModeChange); transitions
    // fire only for the falls: daemon→rpc, then rpc→oneshot.
    expect(modes).toEqual(['rpc', 'oneshot']);
    expect(session.currentMode).toBe('oneshot');
    expect(daemon.sendCalls).toBe(1);
    expect(rpc.sendCalls).toBe(1);
    expect(tracer.run(runId)!.mode).toBe('oneshot');
    expect(tracer.agentSessions(runId)[0]!.mode).toBe('oneshot');

    const events = tracer.eventsAfter(runId, 0, 1000).filter((e) => e.type === 'log');
    const subprocessFallback = events.filter((e) => e.name.includes('fallback to subprocess'));
    const oneshotFallback = events.filter((e) => e.name.includes('fallback to one-shot'));
    expect(subprocessFallback.length).toBeGreaterThanOrEqual(1);
    expect(oneshotFallback.length).toBeGreaterThanOrEqual(1);
    // Ordering: subprocess fallback (daemon→rpc) before oneshot fallback.
    const subIdx = events.findIndex((e) => e.name.includes('fallback to subprocess'));
    const oneIdx = events.findIndex((e) => e.name.includes('fallback to one-shot'));
    expect(subIdx).toBeGreaterThanOrEqual(0);
    expect(oneIdx).toBeGreaterThan(subIdx);

    await session.close();
  });

  it('stays on daemon when there are zero protocol strikes', async () => {
    beginRun('daemon');
    const daemon = scriptedSession({ id: 'd-stable' });
    const session = makeSession({
      transport: 'daemon',
      openDaemonSession: async () => ({ ok: true, session: daemon }),
      openRpcSession: async () => {
        throw new Error('rpc must not open on a healthy daemon path');
      },
    });
    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });
    await session.send('one', { phaseId });
    await session.send('two', { phaseId });
    expect(session.currentMode).toBe('daemon');
    expect(daemon.sendCalls).toBe(2);
    expect(modes.filter((m) => m === 'rpc' || m === 'oneshot')).toEqual([]);
    await session.close();
  });

  it('a single daemon strike falls to rpc and completes the turn there', async () => {
    beginRun('daemon');
    const daemon = scriptedSession({ id: 'd-one-strike', failSends: 1 });
    const rpc = scriptedSession({ id: 'r-recover' });
    const session = makeSession({
      transport: 'daemon',
      openDaemonSession: async () => ({ ok: true, session: daemon }),
      openRpcSession: async () => rpc,
    });
    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: 'scout',
      description: 'd',
    });
    const outcome = await session.send('hello', { phaseId });
    expect(outcome.text).toBe('ok');
    expect(session.currentMode).toBe('rpc');
    expect(daemon.sendCalls).toBe(1);
    expect(rpc.sendCalls).toBe(1);
    expect(modes).toEqual(['rpc']);
    expect(tracer.run(runId)!.mode).toBe('rpc');
    await session.close();
  });
  /**
   * Per-agent host isolation, at the session level: the overlay is built before
   * the first turn spawns anything, the operator is told what was withheld, and
   * the temp directory is gone once the session closes.
   */
  describe('host invocable isolation', () => {
    function inventoryWith(
      overrides: Partial<HostInvocableInventory> = {},
    ): HostInvocableInventory {
      return {
        skills: [],
        droids: [],
        mcpServers: [],
        factoryDir: '/fake/.factory',
        warnings: [],
        ...overrides,
      };
    }

    it('builds an ephemeral home, traces what it withheld, and removes it on close', async () => {
      beginRun('rpc');
      const home = mkdtempSync(join(tmpdir(), 'foundry-iso-home-'));
      const overlayRoot = mkdtempSync(join(tmpdir(), 'foundry-iso-tmp-'));
      mkdirSync(join(home, '.factory', 'droids'), { recursive: true });
      writeFileSync(join(home, '.factory', 'droids', 'reviewer.md'), '# reviewer\n', 'utf8');

      const rpc = scriptedSession({ id: 'rpc-iso' });
      const session = makeSession({
        transport: 'subprocess',
        openRpcSession: async () => rpc,
        overlayHomeDir: home,
        overlayTmpRoot: overlayRoot,
        hostInvocables: inventoryWith({
          droids: [
            {
              id: 'reviewer',
              name: 'reviewer',
              description: 'reviews',
              location: join(home, '.factory', 'droids', 'reviewer.md'),
            },
          ],
        }),
      });

      const phaseId = tracer.openPhase({
        runId,
        seq: 0,
        name: 'scout',
        kind: 'agent',
        owner: 'scout',
        description: 'd',
      });
      await session.send('hello', { phaseId });

      // The overlay exists while the session does.
      expect(readdirSync(overlayRoot).some((d) => d.startsWith('foundry-home-'))).toBe(true);
      const isolation = tracer
        .eventsAfter(runId, 0, 1000)
        .filter((e) => e.name.includes('isolation'));
      expect(isolation.length).toBe(1);
      expect(JSON.stringify(isolation[0]!.payload)).toContain('reviewer');

      await session.close();
      // …and not after.
      expect(readdirSync(overlayRoot).some((d) => d.startsWith('foundry-home-'))).toBe(false);
    });

    it('builds nothing on a host with nothing to withhold', async () => {
      beginRun('rpc');
      const overlayRoot = mkdtempSync(join(tmpdir(), 'foundry-iso-none-'));
      const rpc = scriptedSession({ id: 'rpc-clean' });
      const session = makeSession({
        transport: 'subprocess',
        openRpcSession: async () => rpc,
        overlayTmpRoot: overlayRoot,
        hostInvocables: inventoryWith(),
      });
      const phaseId = tracer.openPhase({
        runId,
        seq: 0,
        name: 'scout',
        kind: 'agent',
        owner: 'scout',
        description: 'd',
      });
      await session.send('hello', { phaseId });
      expect(readdirSync(overlayRoot)).toEqual([]);
      expect(
        tracer.eventsAfter(runId, 0, 1000).filter((e) => e.name.includes('isolation')),
      ).toEqual([]);
      await session.close();
    });
  });
  /**
   * Phase narrowing at the session level: the policy reaches the transport that
   * can enforce it, and a phase that narrows is refused rather than run wide on
   * one that cannot.
   */
  describe('per-phase tool policy', () => {
    /** A scripted session that records the narrowings it was handed. */
    function enforcing(): TransportSession & { policies: (ToolPolicySpec | null)[] } {
      const base = scriptedSession({ id: 'rpc-policy' });
      const policies: (ToolPolicySpec | null)[] = [];
      return Object.assign(base, {
        policies,
        async setPhaseToolPolicy(policy: ToolPolicySpec | null) {
          policies.push(policy);
        },
      });
    }

    function phaseId(): string {
      return tracer.openPhase({
        runId,
        seq: 0,
        name: 'scout',
        kind: 'agent',
        owner: 'scout',
        description: 'd',
      });
    }

    it('hands the phase narrowing to a transport that can enforce it', async () => {
      beginRun('rpc');
      const rpc = enforcing();
      const session = makeSession({ transport: 'subprocess', openRpcSession: async () => rpc });

      await session.send('hello', { phaseId: phaseId(), toolPolicy: { profile: 'read-only' } });
      expect(rpc.policies).toEqual([{ profile: 'read-only' }]);

      // Same policy again is not re-sent; a different one is.
      await session.send('again', { phaseId: phaseId(), toolPolicy: { profile: 'read-only' } });
      expect(rpc.policies).toHaveLength(1);
      await session.send('third', { phaseId: phaseId(), toolPolicy: null });
      expect(rpc.policies).toEqual([{ profile: 'read-only' }, null]);
      await session.close();
    });

    it('refuses a narrowing phase when the transport cannot enforce it', async () => {
      beginRun('rpc');
      // No setPhaseToolPolicy: this transport has no way to apply a narrowing.
      const rpc = scriptedSession({ id: 'rpc-blind' });
      const session = makeSession({ transport: 'subprocess', openRpcSession: async () => rpc });

      await expect(
        session.send('hello', { phaseId: phaseId(), toolPolicy: { profile: 'read-only' } }),
      ).rejects.toThrow(/cannot enforce a narrower tool policy/);
      // Failing closed means the turn does not run at all.
      expect(rpc.sendCalls).toBe(0);
      await session.close();
    });

    it('leaves a non-narrowing phase alone on the same transport', async () => {
      beginRun('rpc');
      const rpc = scriptedSession({ id: 'rpc-plain' });
      const session = makeSession({ transport: 'subprocess', openRpcSession: async () => rpc });
      const outcome = await session.send('hello', { phaseId: phaseId(), toolPolicy: null });
      expect(outcome.text).toBe('ok');
      expect(rpc.sendCalls).toBe(1);
      await session.close();
    });

    it('keeps a profiled agent off the daemon, which cannot enforce it', async () => {
      beginRun('daemon');
      let daemonOpens = 0;
      const rpc = enforcing();
      const session = makeSession({
        agent: { ...agent, toolProfile: 'read-only' },
        transport: 'daemon',
        // Production would consult openDaemonProduction, which fails closed for a
        // profile; the seam stands in for it so the decision is observable here.
        openDaemonSession: async () => {
          daemonOpens += 1;
          return { ok: false, reason: 'daemon cannot enforce a tool profile (no listTools)' };
        },
        openRpcSession: async () => rpc,
      });
      await session.send('hello', { phaseId: phaseId() });
      expect(daemonOpens).toBe(1);
      expect(session.currentMode).toBe('rpc');
      const fallbacks = tracer
        .eventsAfter(runId, 0, 1000)
        .filter((e) => e.name.includes('fallback to subprocess'));
      expect(fallbacks.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(fallbacks[0]!.payload)).toContain('tool profile');
      await session.close();
    });
  });
});
