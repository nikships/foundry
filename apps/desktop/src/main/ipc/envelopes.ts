import type { EnvelopeDef } from '@shared/types.js';
import { IPC, type SaveResult } from '@shared/ipc-contract.js';
import { exampleFor } from '../engine/envelopes.js';
import { validate as validateEnvelope } from '../store/envelopes.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'envelopes' | 'roster' | 'pipelines' | 'projects' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.envelopesList, () => ctx.envelopes.list());

  handle(IPC.envelopesSave, (def: EnvelopeDef): SaveResult<EnvelopeDef[]> => {
    const result = ctx.envelopes.save(def);
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.envelopes };
  });

  handle(IPC.envelopesRemove, (name: string) => {
    const envelopes = ctx.envelopes.remove(name);
    notifySettings(ctx);
    return envelopes;
  });

  handle(IPC.envelopesDuplicate, (name: string) => {
    const copy = ctx.envelopes.duplicate(name);
    if (copy) notifySettings(ctx);
    return copy;
  });

  handle(IPC.envelopesUsage, (name: string) => {
    const agents = new Set<string>();
    const phases: { pipeline: string; phase: string }[] = [];

    const scanRoster = (list: { name: string; envelope: string }[]) => {
      for (const agent of list) {
        if (agent.envelope === name) agents.add(agent.name);
      }
    };
    const scanPipelines = (
      list: { name: string; phases: { name: string; envelope?: string }[] }[],
    ) => {
      for (const pipeline of list) {
        for (const phase of pipeline.phases) {
          if (phase.envelope === name) {
            phases.push({ pipeline: pipeline.name, phase: phase.name });
          }
        }
      }
    };

    // App-level library is shared, so every scope that can name it is scanned.
    scanRoster(ctx.roster.list());
    scanPipelines(ctx.pipelines.list());
    for (const project of ctx.projects.list()) {
      if (project.ownRoster) {
        scanRoster(ctx.roster.list({ projectId: project.id, ownRoster: true }));
      }
      if (project.ownPipelines) {
        scanPipelines(ctx.pipelines.list({ projectId: project.id, ownPipelines: true }));
      }
    }

    return { agents: [...agents].sort(), phases };
  });

  handle(IPC.envelopesValidate, (def: EnvelopeDef) => {
    const issues = validateEnvelope(def);
    // Example comes from the same path the agent sees, even when the def is
    // still invalid — the editor can show what it would produce once fixed.
    const example = exampleFor(def.name, undefined, [def]);
    return { issues, example };
  });

  handle(IPC.envelopesPreview, (name: string) => exampleFor(name, undefined, ctx.envelopes.list()));
}
