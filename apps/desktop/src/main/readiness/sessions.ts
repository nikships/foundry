/**
 * Live readiness sessions, keyed by project. Separate from RunRegistry on
 * purpose: a readiness check has no trace rows and must not look like a run.
 *
 * Sweep and keep-limits live on SessionRegistry. Inspect/evaluate/makeReady
 * stay here because they are a state machine, not a one-shot start().
 */

import type {
  AppSettings,
  ProjectDef,
  ReadinessInspectResult,
  ReadinessState,
} from '@shared/types.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { SessionRegistry } from '../session/registry.js';
import { readMarkerAtBaseRef } from './marker.js';
import { createAgentRemediator, resolveReadinessModel } from './remediator.js';
import { ReadinessSession, type ReadinessIo } from './session.js';
import * as ghLib from '../system/gh.js';
import type { PrMergeView } from './merge.js';

/**
 * The single readiness verdict. Reads the marker from the project's base ref —
 * the ref run worktrees branch from — so a feature branch that never carried
 * the marker still reports ready, and a marker that only exists in the working
 * checkout never does.
 */
export async function inspectProject(project: ProjectDef): Promise<ReadinessInspectResult> {
  const read = await readMarkerAtBaseRef(project.path, project.baseRef);
  return {
    projectId: project.id,
    markerValid: read.ok,
    marker: read.marker,
    markerDetail: read.detail,
    skipped: !!project.readinessSkipped,
    validatedCache: !!project.readinessValidated,
    ready: read.ok,
    markerSource: read.source,
    markerRef: read.ref,
  };
}

export function defaultReadinessIo(oneShot: OneShotFactory): ReadinessIo {
  return {
    remediator: createAgentRemediator({ oneShot }),
    openPr: (repo, input) => ghLib.openPr(repo, input),
    viewPrMerge: async (repo, ref): Promise<PrMergeView | null> => {
      const viewed = await ghLib.viewPrMergeState(repo, ref);
      return viewed;
    },
  };
}

export class ReadinessSessions {
  private readonly registry = new SessionRegistry<ReadinessSession>();

  constructor(
    private readonly oneShot: OneShotFactory,
    private readonly onProgress: (state: ReadinessState) => void,
  ) {}

  get(projectId: string): ReadinessState | null {
    return this.registry.get(projectId)?.snapshot() ?? null;
  }

  session(projectId: string): ReadinessSession | null {
    return this.registry.get(projectId) ?? null;
  }

  open(
    project: ProjectDef,
    settings: AppSettings,
    persist: (project: ProjectDef) => void,
    io?: ReadinessIo,
  ): ReadinessSession {
    this.registry.sweep();
    const existing = this.registry.get(project.id);
    if (existing) {
      const phase = existing.snapshot().phase;
      // needs_continue is parked, not finished: keep the session so Continue
      // reuses the worktree. Treating it like failed would open a new session
      // and throw the paid work away.
      if (phase !== 'complete' && phase !== 'skipped' && phase !== 'failed') return existing;
    }
    const session = new ReadinessSession({
      project,
      settings,
      persist,
      io: io ?? defaultReadinessIo(this.oneShot),
      onChange: (state) => {
        if (state.phase === 'complete' || state.phase === 'skipped' || state.phase === 'failed') {
          this.registry.markEnded(state.projectId);
        }
        this.onProgress(state);
      },
    });
    this.registry.add(project.id, session);
    return session;
  }

  applyModel(
    session: ReadinessSession,
    settings: AppSettings,
    opts?: { model?: string; reasoningEffort?: AppSettings['readinessReasoningEffort'] },
  ): void {
    const resolved = resolveReadinessModel(settings, opts);
    session.configure(resolved);
  }

  cancel(projectId: string): boolean {
    return this.registry.cancel(projectId);
  }

  cancelAll(): void {
    this.registry.cancelAll();
  }
}
