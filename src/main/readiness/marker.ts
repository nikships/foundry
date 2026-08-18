/**
 * `.agents/agent-ready.json` — portable proof a repo can host agent-driven work.
 *
 * The committed file on the project's base ref is the source of truth: run
 * worktrees branch from that ref, so a marker only present in the operator's
 * current checkout proves nothing about what a run would inherit. App-side
 * flags only cache a successful read. A missing, corrupt, or schema-mismatched
 * file is not ready.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { refExists, showFileAtRef } from '../engine/git.js';
import {
  READINESS_CRITERION_IDS,
  type AgentReadyMarker,
  type AgentReadyStack,
  type ReadinessCriterion,
  type ReadinessCriterionId,
  type ReadinessEvaluation,
} from '@shared/types.js';

export const AGENT_READY_PATH = join('.agents', 'agent-ready.json');
export const MARKER_SCHEMA_VERSION = 1 as const;

const criterionSchema = z.object({
  id: z.enum(READINESS_CRITERION_IDS),
  status: z.enum(['pass', 'fail', 'n/a']),
  measurement: z.record(z.string(), z.unknown()).optional(),
  notes: z.string(),
});

const markerSchema = z.object({
  schemaVersion: z.literal(MARKER_SCHEMA_VERSION),
  generatedAt: z.string().min(1),
  commit: z.string().min(1),
  agent: z.object({
    harness: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1),
  }),
  verdict: z.literal('ready'),
  summary: z.string().min(1),
  stack: z.object({
    languages: z.array(z.string()),
    monorepo: z.boolean(),
    packages: z.array(z.string()),
  }),
  criteria: z.array(criterionSchema).min(READINESS_CRITERION_IDS.length),
});

export interface MarkerRead {
  ok: boolean;
  marker: AgentReadyMarker | null;
  detail: string;
  /** Where the answer came from, so the UI can explain a base-ref failure. */
  source?: 'base-ref' | 'worktree';
  /** The ref the marker was read from, when it was read from git. */
  ref?: string;
}

export function markerFilePath(repo: string): string {
  return join(repo, AGENT_READY_PATH);
}

/**
 * A ready marker must name every criterion, and none may still be `fail`.
 * N/A is an adaptation with reasoning, not a skip.
 */
export function validateMarker(raw: unknown): MarkerRead {
  const parsed = markerSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? first.path.join('.') : 'marker';
    return {
      ok: false,
      marker: null,
      detail: first ? `${where}: ${first.message}` : 'marker failed schema validation',
    };
  }
  const seen = new Set<ReadinessCriterionId>();
  for (const criterion of parsed.data.criteria) {
    if (seen.has(criterion.id)) {
      return { ok: false, marker: null, detail: `duplicate criterion "${criterion.id}"` };
    }
    seen.add(criterion.id);
    if (criterion.status === 'fail') {
      return {
        ok: false,
        marker: null,
        detail: `criterion "${criterion.id}" is fail; a ready marker cannot contain failures`,
      };
    }
  }
  for (const id of READINESS_CRITERION_IDS) {
    if (!seen.has(id)) {
      return { ok: false, marker: null, detail: `missing criterion "${id}"` };
    }
  }
  return { ok: true, marker: parsed.data, detail: 'valid agent-ready marker' };
}

export function parseMarkerText(text: string): MarkerRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    return { ok: false, marker: null, detail: `not valid JSON: ${(e as Error).message}` };
  }
  return validateMarker(raw);
}

export function readMarker(repo: string): MarkerRead {
  const file = markerFilePath(repo);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, marker: null, detail: `missing ${AGENT_READY_PATH}` };
  }
  return parseMarkerText(text);
}

async function readAtRef(repo: string, ref: string, note: string): Promise<MarkerRead> {
  const text = await showFileAtRef(repo, ref, AGENT_READY_PATH);
  if (text === null) {
    return {
      ok: false,
      marker: null,
      source: 'base-ref',
      ref,
      detail: `${AGENT_READY_PATH} is not committed on ${ref}${note}`,
    };
  }
  const parsed = parseMarkerText(text);
  return {
    ...parsed,
    source: 'base-ref',
    ref,
    detail: parsed.ok ? `${parsed.detail} on ${ref}${note}` : `${parsed.detail} (on ${ref}${note})`,
  };
}

/**
 * The authoritative readiness answer: the marker as committed on `baseRef`.
 *
 * Run worktrees are created from the base ref, so that is the only tree whose
 * marker describes what a run will actually see.
 *
 * When the base ref cannot be resolved (misconfigured, renamed, or deleted),
 * the answer comes from `HEAD` rather than the working checkout, because
 * `addWorktree()` branches from HEAD in exactly that situation — HEAD is what a
 * run would inherit. Reading the filesystem there would report ready off an
 * uncommitted marker, which is the failure this whole path exists to prevent.
 * The bare filesystem is used only for a repo with no commits at all, where
 * there is no tree to read.
 */
export async function readMarkerAtBaseRef(repo: string, baseRef: string): Promise<MarkerRead> {
  const ref = baseRef.trim();
  if (ref && (await refExists(repo, ref))) return readAtRef(repo, ref, '');

  const why = ref ? `base ref "${ref}" does not resolve` : 'no base ref configured';
  if (await refExists(repo, 'HEAD')) {
    return readAtRef(repo, 'HEAD', `; ${why}, so HEAD was used`);
  }
  const local = readMarker(repo);
  return {
    ...local,
    source: 'worktree',
    ...(ref ? { ref } : {}),
    detail: `${local.detail} (${why} and the repository has no commits)`,
  };
}

export function serializeMarker(marker: AgentReadyMarker): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

export function writeMarker(repo: string, marker: AgentReadyMarker): string {
  const file = markerFilePath(repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeMarker(marker));
  return file;
}

export function markerFromEvaluation(
  evaluation: ReadinessEvaluation,
  meta: {
    commit: string;
    generatedAt: string;
    model: string;
    reasoningEffort: string;
  },
): AgentReadyMarker {
  const criteria: ReadinessCriterion[] = evaluation.criteria.map((c) => ({
    ...c,
    status: c.status === 'fail' ? 'n/a' : c.status,
  }));
  const stack: AgentReadyStack = evaluation.stack;
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    generatedAt: meta.generatedAt,
    commit: meta.commit,
    agent: { harness: 'pi', model: meta.model, reasoningEffort: meta.reasoningEffort },
    verdict: 'ready',
    summary: evaluation.summary,
    stack,
    criteria,
  };
}
