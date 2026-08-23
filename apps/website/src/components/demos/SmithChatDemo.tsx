/**
 * Smith — the native operator chat.
 *
 * Not a terminal, not a skill, not a CLI. Smith is a chat inside the app on the
 * bundled pi runtime: reads answer immediately, and every privileged action
 * stops at one inline approval card whose executor never leaves the main
 * process. Approving mints a receipt from the executor's real result, because
 * approval is not the same thing as success.
 *
 * Mirrors apps/desktop/src/renderer/components/smith/SmithTranscript.tsx,
 * SmithProposalCard.tsx and SmithActionReceipt.tsx.
 */

import { useEffect, useState } from 'react';
import { CheckIcon, XIcon } from 'lucide-react';
import { SMITH_LEAD, SMITH_PENDING, SMITH_APPROVED, SMITH_REJECTED } from '../../data/foundry';
import type { SmithRow } from '../../data/foundry';
import { useInView, useReducedMotion } from '../../hooks';

type Decision = 'none' | 'approved' | 'rejected';

/** The proposed phase the card is asking about. */
const PROPOSED = [
  ['name', 'lint'],
  ['kind', 'code'],
  ['command', '{ ref: "lint" }'],
  ['feedbackTo', 'build'],
] as const;

function Row({ row }: { row: SmithRow }) {
  if (row.kind === 'user') {
    return (
      <div className="mb-3 flex justify-end">
        <p className="max-w-[85%] rounded border border-accent/35 bg-accent-dim px-[13px] py-[9px] text-[12.5px] leading-[1.55] text-text">
          {row.text}
        </p>
      </div>
    );
  }

  if (row.kind === 'tool') {
    return (
      <div className="flex gap-2 py-[2px] font-mono text-[10.5px] leading-[1.6] text-text-faint">
        <span className="flex-none text-text-ghost">·</span>
        <span className="min-w-0 break-words">{row.text}</span>
      </div>
    );
  }

  if (row.kind === 'note') {
    return (
      <p className="py-[6px] text-[12.5px] leading-[1.6] text-text-dim">{row.text}</p>
    );
  }

  if (row.kind === 'artifact') {
    const [label, ...rest] = row.text.split(' · ');
    return (
      <div className="my-2 overflow-hidden rounded border border-line bg-bg-raised">
        <div className="flex items-center gap-2 border-b border-line-faint px-[11px] py-[7px]">
          <span className="rounded-[2px] border border-purple/40 px-[5px] font-mono text-[9px] uppercase tracking-label text-purple">
            {label}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-text-dim">
            {rest.join(' · ')}
          </span>
        </div>
        <p className="px-[11px] py-[9px] text-[11.5px] leading-[1.5] text-text-faint">
          A typed inline card, not parsed out of Markdown. Presentation only — it performs no write.
        </p>
      </div>
    );
  }

  if (row.kind === 'receipt') {
    return (
      <div className="my-2 flex items-start gap-[9px] rounded border border-line border-l-2 border-l-green bg-bg-raised px-[11px] py-[9px]">
        <span className="mt-[3px] flex-none font-mono text-[9px] uppercase tracking-label text-green">
          ✓
        </span>
        <span className="min-w-0 break-words font-mono text-[11px] leading-[1.55] text-text-dim">
          {row.text}
        </span>
      </div>
    );
  }

  return (
    <div className="my-2 flex items-start gap-[9px] rounded border border-line border-l-2 border-l-red bg-bg-raised px-[11px] py-[9px]">
      <span className="mt-[3px] flex-none font-mono text-[9px] uppercase tracking-label text-red">
        ✕
      </span>
      <span className="min-w-0 break-words font-mono text-[11px] leading-[1.55] text-text-dim">
        {row.text}
      </span>
    </div>
  );
}

export function SmithChatDemo() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [shown, setShown] = useState(reduced ? SMITH_LEAD.length : 0);
  const [decision, setDecision] = useState<Decision>('none');

  /* stream the transcript out, one row at a time, only while on screen */
  useEffect(() => {
    if (reduced || !inView || shown >= SMITH_LEAD.length) return;
    const id = window.setTimeout(() => setShown((n) => n + 1), shown === 0 ? 460 : 560);
    return () => window.clearTimeout(id);
  }, [shown, reduced, inView]);

  /* after a decision, hold the result and then start over */
  useEffect(() => {
    if (decision === 'none') return;
    const id = window.setTimeout(() => {
      setDecision('none');
      setShown(reduced ? SMITH_LEAD.length : 0);
    }, 6500);
    return () => window.clearTimeout(id);
  }, [decision, reduced]);

  const blocked = shown >= SMITH_LEAD.length && decision === 'none';
  const tail: SmithRow[] =
    decision === 'approved' ? SMITH_APPROVED : decision === 'rejected' ? SMITH_REJECTED : [];

  const BTN =
    'flex items-center gap-[6px] rounded-sm border px-[11px] py-[6px] font-mono text-[10px] uppercase tracking-label transition-colors duration-fast ease-mech';

  return (
    <div ref={ref} className="overflow-hidden rounded-lg border border-line-strong bg-bg-void">
      {/* the app's own titlebar band, not a terminal chrome */}
      <div className="flex h-10 items-center gap-3 border-b border-line bg-bg-titlebar px-3">
        <span className="flex gap-[7px]" aria-hidden="true">
          <i className="h-[10px] w-[10px] rounded-full bg-[#3b2320]" />
          <i className="h-[10px] w-[10px] rounded-full bg-[#3a3222]" />
          <i className="h-[10px] w-[10px] rounded-full bg-[#22301f]" />
        </span>
        <span className="mx-auto truncate font-mono text-[10.5px] uppercase tracking-eyebrow text-text-faint">
          Foundry — Smith
        </span>
        <span className="flex items-center gap-[10px] font-mono text-[10px] uppercase tracking-label text-text-faint">
          foundry
        </span>
      </div>

      {/* fixed height: the pane must not resize when the card is answered */}
      <div className="h-[420px] overflow-y-auto px-4 py-[14px]">
        {SMITH_LEAD.slice(0, shown).map((r, i) => (
          <Row key={i} row={r} />
        ))}

        {/* the one approval slot */}
        {blocked ? (
          <div className="mt-3 overflow-hidden rounded border border-amber/45 bg-bg-raised">
            <div className="flex flex-wrap items-center gap-2 border-b border-line-faint bg-amber-dim px-[11px] py-[8px]">
              <span className="rounded-[2px] border border-amber/50 px-[5px] font-mono text-[9px] uppercase tracking-label text-amber">
                approval required
              </span>
              <span className="min-w-0 truncate font-mono text-[10.5px] text-text-dim">
                {SMITH_PENDING.text}
              </span>
            </div>
            <div className="px-[11px] py-[10px] font-mono text-[10.5px] leading-[1.7] text-text-dim">
              {PROPOSED.map(([k, v]) => (
                <div key={k}>
                  <span className="text-text-faint">{k}</span>
                  <span className="text-text-ghost">: </span>
                  <span className="text-green">{v}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-faint px-[11px] py-[9px]">
              <span className="font-mono text-[9.5px] uppercase tracking-label text-text-ghost">
                nothing is written until you decide
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDecision('rejected')}
                  className={`${BTN} cursor-pointer border-line text-text-dim hover:border-red hover:text-red`}
                >
                  <XIcon size={11} />
                  Reject
                </button>
                <button
                  type="button"
                  onClick={() => setDecision('approved')}
                  className={`${BTN} cursor-pointer border-accent bg-accent text-[#0a0503]`}
                >
                  <CheckIcon size={11} />
                  Approve
                </button>
              </span>
            </div>
          </div>
        ) : null}

        {tail.map((r, i) => (
          <Row key={`tail-${i}`} row={r} />
        ))}
      </div>

      <div className="flex items-center gap-3 border-t border-line bg-bg-panel px-4 py-[11px]">
        <span className="min-w-0 flex-1 truncate rounded-sm border border-line bg-bg-input px-[10px] py-[7px] font-mono text-[11px] text-text-ghost">
          Ask Smith anything about foundry…
        </span>
        <span className="flex-none rounded-sm border border-line px-[11px] py-[6px] font-mono text-[10px] uppercase tracking-label text-text-ghost">
          Send
        </span>
      </div>
    </div>
  );
}
