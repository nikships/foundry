/**
 * Smith — propose → approve.
 *
 * A terminal running the operator's own agent with the foundry-smith skill
 * loaded. It reads through the CLI, then proposes a pipeline edit and BLOCKS:
 * the command does not return until a human decides. The approve/reject
 * buttons here are the real contract, not decoration — rejecting writes
 * nothing and hands the rejection back to the agent.
 *
 * Structure generated with Magic Patterns and adapted: framer-motion's
 * useReducedMotion swapped for the local hook, and playback gated on
 * visibility. Protocol details mirror skills/foundry-smith/SKILL.md.
 */

import { useEffect, useState } from 'react';
import { CheckIcon, XIcon } from 'lucide-react';
import { SMITH_LINES, SMITH_APPROVED, SMITH_REJECTED } from '../../data/site';
import type { SmithLine, SmithLineKind } from '../../data/site';
import { useInView, useReducedMotion } from '../../hooks';

const LINE_COLOR: Record<SmithLineKind, string> = {
  cmd: 'var(--text)',
  out: 'var(--text-dim)',
  note: 'var(--purple)',
  pending: 'var(--amber)',
  ok: 'var(--green)',
  err: 'var(--red)',
};

type Decision = 'none' | 'approved' | 'rejected';

function Line({ line }: { line: SmithLine }) {
  return (
    <div className="flex gap-2 py-[3px] font-mono text-[11px] leading-[1.6]">
      <span className="w-[10px] flex-none" style={{ color: line.kind === 'cmd' ? 'var(--accent)' : 'transparent' }}>
        $
      </span>
      <span className="min-w-0 flex-1 break-words" style={{ color: LINE_COLOR[line.kind] }}>
        {line.text}
      </span>
    </div>
  );
}

export function SmithApprovalDemo() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [shown, setShown] = useState(reduced ? SMITH_LINES.length : 0);
  const [decision, setDecision] = useState<Decision>('none');

  /* type the transcript out, one line at a time, only while on screen */
  useEffect(() => {
    if (reduced || !inView || shown >= SMITH_LINES.length) return;
    const id = window.setTimeout(() => setShown((n) => n + 1), shown === 0 ? 480 : 620);
    return () => window.clearTimeout(id);
  }, [shown, reduced, inView]);

  /* after a decision, hold the result and then start over */
  useEffect(() => {
    if (decision === 'none') return;
    const id = window.setTimeout(() => {
      setDecision('none');
      setShown(reduced ? SMITH_LINES.length : 0);
    }, 6000);
    return () => window.clearTimeout(id);
  }, [decision, reduced]);

  const blocked = shown >= SMITH_LINES.length && decision === 'none';
  const tail: SmithLine[] =
    decision === 'approved' ? SMITH_APPROVED : decision === 'rejected' ? SMITH_REJECTED : [];

  const BTN =
    'flex items-center gap-2 rounded-sm border px-[11px] py-[6px] font-mono text-[10px] uppercase tracking-label transition-colors duration-fast ease-mech';

  return (
    <div ref={ref} className="overflow-hidden rounded-lg border border-line bg-bg-input">
      <div className="flex items-center gap-3 border-b border-line bg-bg-titlebar px-4 py-[10px]">
        <span className="flex items-center gap-[7px]" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-[9px] w-[9px] rounded-full border border-[#2e2e2e]" />
          ))}
        </span>
        <span className="font-mono text-[11px] text-text-dim">zsh — ~/code/foundry — smith</span>
      </div>

      <div className="min-h-[300px] px-4 py-3">
        {SMITH_LINES.slice(0, shown).map((l, i) => (
          <Line key={i} line={l} />
        ))}
        {tail.map((l, i) => (
          <Line key={`tail-${i}`} line={l} />
        ))}
        {blocked ? (
          <span className="mt-1 inline-block h-[13px] w-[7px] animate-pulse-soft bg-amber" aria-hidden="true" />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-bg-panel px-4 py-3">
        <span className="flex min-w-0 flex-col">
          <span
            className="font-mono text-[10px] uppercase tracking-eyebrow"
            style={{ color: blocked ? 'var(--amber)' : 'var(--text-ghost)' }}
          >
            {blocked
              ? 'proposal pending — foundry'
              : decision === 'approved'
                ? 'approved — saved'
                : decision === 'rejected'
                  ? 'rejected — nothing written'
                  : 'no open proposal'}
          </span>
          <span className="truncate font-mono text-[11px] text-text-dim">
            pipeline edit · plan-build-test · +1 code phase
          </span>
        </span>

        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={!blocked}
            onClick={() => setDecision('rejected')}
            className={`${BTN} border-line ${
              blocked ? 'cursor-pointer text-text-dim hover:border-red hover:text-red' : 'cursor-not-allowed text-text-ghost'
            }`}
          >
            <XIcon size={11} />
            Reject
          </button>
          <button
            type="button"
            disabled={!blocked}
            onClick={() => setDecision('approved')}
            className={`${BTN} ${
              blocked
                ? 'cursor-pointer border-accent bg-accent text-[#0a0503]'
                : 'cursor-not-allowed border-line text-text-ghost'
            }`}
          >
            <CheckIcon size={11} />
            Approve
          </button>
        </span>
      </div>
    </div>
  );
}
