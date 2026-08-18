/**
 * Live readiness sessions, keyed by project. Separate from RunRegistry on
 * purpose: a readiness check has no trace rows and must not look like a run.
 */

import type {
  AppSettings,
  ProjectDef,
  ReadinessInspectResult,
  ReadinessState,
} from '@shared/types.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { readMarkerAtBaseRef } from './marker.js';
import { createAgentRemediator, resolveReadinessModel } from './remediator.js';
import { ReadinessSession, type ReadinessIo } from './session.js';
import * as ghLib from '../system/gh.js';
import type { PrMergeView } from './merge.js';

const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 20;

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
  private readonly sessions = new Map<string, ReadinessSession>();
  private readonly endedAt = new Map<string, number>();

  constructor(
    private readonly oneShot: OneShotFactory,
    private readonly onProgress: (state: ReadinessState) => void,
  ) {}

  get(projectId: string): ReadinessState | null {
    return this.sessions.get(projectId)?.snapshot() ?? null;
  }

  session(projectId: string): ReadinessSession | null {
    return this.sessions.get(projectId) ?? null;
  }

  open(
    project: ProjectDef,
    settings: AppSettings,
    persist: (project: ProjectDef) => void,
    io?: ReadinessIo,
  ): ReadinessSession {
    this.sweep();
    const existing = this.sessions.get(project.id);
    if (existing) {
      const phase = existing.snapshot().phase;
      if (phase !== 'complete' && phase !== 'skipped' && phase !== 'failed') return existing;
    }
    const session = new ReadinessSession({
      project,
      settings,
      persist,
      io: io ?? defaultReadinessIo(this.oneShot),
      onChange: (state) => {
        if (state.phase === 'complete' || state.phase === 'skipped' || state.phase === 'failed') {
          this.endedAt.set(state.projectId, Date.now());
        }
        this.onProgress(state);
      },
    });
    this.sessions.set(project.id, session);
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
    const session = this.sessions.get(projectId);
    if (!session) return false;
    session.cancel();
    return true;
  }

  cancelAll(): void {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
    this.endedAt.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, at] of this.endedAt) {
      if (now - at < KEEP_MS) continue;
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
    if (this.sessions.size <= MAX_KEPT) return;
    const finished = [...this.endedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of finished.slice(0, this.sessions.size - MAX_KEPT)) {
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
  }
}
