import type {
  ProjectDef,
  ReadinessAskAnswer,
  ReadinessInspectResult,
  ReadinessState,
  ReasoningEffort,
} from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifySettings } from './shared.js';
import { inspectProject } from '../readiness/sessions.js';

type Ctx = Pick<AppContext, 'projects' | 'settings' | 'readiness' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  const persist = (project: ProjectDef): void => {
    ctx.projects.save(project);
    notifySettings(ctx);
  };

  const projectOf = (projectId: string) => ctx.projects.get(projectId);

  handle(IPC.readinessInspect, (projectId: string): ReadinessInspectResult | null => {
    const project = projectOf(projectId);
    if (!project) return null;
    const result = inspectProject(project);
    if (result.ready && (!project.readinessValidated || project.readinessSkipped)) {
      persist({ ...project, readinessValidated: true, readinessSkipped: false });
    } else if (!result.ready && project.readinessValidated) {
      persist({ ...project, readinessValidated: false });
    }
    const latest = projectOf(projectId) ?? project;
    return inspectProject(latest);
  });

  handle(
    IPC.readinessEvaluate,
    async (
      projectId: string,
      opts?: { model?: string; reasoningEffort?: ReasoningEffort; saveAsDefault?: boolean },
    ): Promise<{ sessionId: string } | { error: string }> => {
      const project = projectOf(projectId);
      if (!project) return { error: 'project not found' };
      if (opts?.saveAsDefault) {
        const patch: { readinessModel?: string; readinessReasoningEffort?: ReasoningEffort } = {};
        if (opts.model) patch.readinessModel = opts.model;
        if (opts.reasoningEffort) patch.readinessReasoningEffort = opts.reasoningEffort;
        ctx.settings.patch(patch);
        notifySettings(ctx);
      }
      const settings = ctx.settings.get();
      const session = ctx.readiness.open(project, settings, persist);
      ctx.readiness.applyModel(session, settings, opts);
      const current = session.snapshot();
      if (current.phase === 'idle') session.inspect();
      if (session.snapshot().phase === 'complete') {
        return { sessionId: session.sessionId };
      }
      void session.evaluate();
      return { sessionId: session.sessionId };
    },
  );

  handle(
    IPC.readinessMakeReady,
    async (projectId: string): Promise<{ sessionId: string } | { error: string }> => {
      const project = projectOf(projectId);
      if (!project) return { error: 'project not found' };
      const settings = ctx.settings.get();
      const session = ctx.readiness.open(project, settings, persist);
      if (session.snapshot().phase === 'idle') session.inspect();
      void session.makeReady();
      return { sessionId: session.sessionId };
    },
  );

  handle(IPC.readinessCancel, (projectId: string) => ctx.readiness.cancel(projectId));

  handle(IPC.readinessGet, (projectId: string): ReadinessState | null =>
    ctx.readiness.get(projectId),
  );

  handle(IPC.readinessSkip, (projectId: string): ReadinessState | null => {
    const project = projectOf(projectId);
    if (!project) return null;
    const settings = ctx.settings.get();
    const session = ctx.readiness.open(project, settings, persist);
    return session.skip();
  });

  handle(
    IPC.readinessRetry,
    async (projectId: string): Promise<{ sessionId: string } | { error: string }> => {
      const project = projectOf(projectId);
      if (!project) return { error: 'project not found' };
      const settings = ctx.settings.get();
      const session = ctx.readiness.open(project, settings, persist);
      void session.retry();
      return { sessionId: session.sessionId };
    },
  );

  handle(IPC.readinessConfirmMerge, async (projectId: string): Promise<ReadinessState | null> => {
    const session = ctx.readiness.session(projectId);
    if (!session) return null;
    return session.confirmMerge();
  });

  handle(IPC.readinessAnswerAsk, (projectId: string, answers: ReadinessAskAnswer[]): boolean => {
    const session = ctx.readiness.session(projectId);
    if (!session) return false;
    return session.answerAsk(answers);
  });

  handle(IPC.readinessDismiss, (projectId: string): boolean => {
    const session = ctx.readiness.session(projectId);
    if (!session) return false;
    session.dismiss();
    return true;
  });
}
