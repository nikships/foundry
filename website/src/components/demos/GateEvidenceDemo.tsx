/**
 * Gate evidence.
 *
 * Each gate runs in turn against the envelope's claim and the state of the
 * worktree, and leaves a line of evidence behind. Every second pass fails
 * diff_matches_claims on purpose, because that is the whole point: the agent's
 * claim and git's answer are compared, and the agent does not get a vote.
 *
 * Mirrors the GateResult shape in src/main/engine/gates.ts.
 */

import { useEffect, useState } from 'react';
import { GATE_RUN } from '../../data/foundry';
import { useInView, useReducedMotion } from '../../hooks';

type CheckState = 'idle' | 'run' | 'pass' | 'fail';

const FINISHED: CheckState[] = GATE_RUN.checks.map(() => 'pass');

export function GateEvidenceDemo() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.25);

  const [states, setStates] = useState<CheckState[]>(() => (reduced ? FINISHED : GATE_RUN.checks.map(() => 'idle')));
  const [verdict, setVerdict] = useState<'accepted' | 'rejected' | null>(reduced ? 'accepted' : null);
  /** which pass we are on — every other one fails, so the failure path is
   *  visible without the visitor having to do anything */
  const [pass, setPass] = useState(true);

  useEffect(() => {
    if (reduced || !inView) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    setStates(GATE_RUN.checks.map(() => 'idle'));
    setVerdict(null);

    let t = 420;
    let failedAt = -1;

    GATE_RUN.checks.forEach((check, i) => {
      const willFail = !pass && Boolean(check.fail);
      at(t, () => setStates((prev) => prev.map((s, j) => (j === i ? 'run' : s))));
      t += 320 + i * 90;
      at(t, () => {
        if (failedAt >= 0) return;
        if (willFail) failedAt = i;
        setStates((prev) => prev.map((s, j) => (j === i ? (willFail ? 'fail' : 'pass') : s)));
      });
      t += 240;
    });

    at(t + 260, () => setVerdict(pass ? 'accepted' : 'rejected'));
    at(t + 3400, () => setPass((p) => !p));

    return () => timers.forEach(clearTimeout);
  }, [pass, inView, reduced]);

  return (
    <div ref={ref} className="grid grid-cols-1 md:grid-cols-2">
      {/* ── what the agent claimed ───────────────────────────────────── */}
      <div className="p-[22px]">
        <span className="label-sm mb-[14px] block text-text-faint">What the agent claimed</span>
        <div className="font-mono text-[11.5px] leading-[1.75] text-text-dim">
          <span className="text-text-faint">{'{'}</span>
          {GATE_RUN.claim.map(([k, v]) => (
            <div key={k} className="pl-4">
              <span className="text-text-faint">&quot;{k}&quot;</span>
              <span className="text-text-ghost">: </span>
              <span className="text-green">&quot;{v}&quot;</span>
              <span className="text-text-ghost">,</span>
            </div>
          ))}
          <span className="text-text-faint">{'}'}</span>
        </div>

        <span className="label-sm mb-[10px] mt-[22px] block text-text-faint">Declared artifacts</span>
        <div className="font-mono text-[11.5px] leading-[1.75] text-text-dim">
          {GATE_RUN.files.map((f) => (
            <div key={f}>
              <span className="text-text-ghost">· </span>
              {f}
            </div>
          ))}
        </div>
      </div>

      {/* ── what the gates found ─────────────────────────────────────── */}
      <div className="border-t border-line bg-bg-panel p-[22px] md:border-l md:border-t-0">
        <span className="label-sm mb-2 block text-text-faint">What the gates found</span>

        {GATE_RUN.checks.map((check, i) => {
          const state = states[i];
          const open = state === 'pass' || state === 'fail';
          return (
            <div key={check.name} className="flex gap-[11px] border-t border-line-faint py-[13px] first:border-t-0">
              <span
                className={`mt-px grid h-[15px] w-[15px] flex-none place-items-center rounded-[2px] border transition-colors duration-normal ease-mech ${
                  state === 'run'
                    ? 'animate-pulse-soft border-accent text-transparent'
                    : state === 'pass'
                      ? 'border-green text-green'
                      : state === 'fail'
                        ? 'border-red text-red'
                        : 'border-line-strong text-transparent'
                }`}
              >
                <svg viewBox="0 0 12 12" className="h-[9px] w-[9px]" aria-hidden="true">
                  {state === 'fail' ? (
                    <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
                  ) : (
                    <polyline
                      points="2,6.4 4.8,9 10,3.2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.4}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  )}
                </svg>
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-[10px]">
                  <span
                    className={`font-mono text-[12px] transition-colors duration-normal ease-mech ${
                      state === 'idle' ? 'text-text-faint' : 'text-text'
                    }`}
                  >
                    {check.name}
                  </span>
                  <span className="ml-auto flex-none font-mono text-[10px] text-text-ghost">
                    {open ? `${check.ms}ms` : ''}
                  </span>
                </div>

                <div
                  className={`overflow-hidden font-mono text-[10.5px] leading-[1.65] transition-[max-height,margin-top] duration-slow ease-mech ${
                    open ? 'mt-[7px] max-h-[120px]' : 'mt-0 max-h-0'
                  } ${state === 'fail' ? 'text-red' : 'text-text-faint'}`}
                >
                  {state === 'fail' ? check.fail : check.pass}
                </div>
              </div>
            </div>
          );
        })}

        <div
          className={`mt-5 flex items-center gap-3 rounded-sm border border-line px-4 py-[14px] transition-[opacity,transform] duration-slow ease-mech ${
            verdict ? 'translate-y-0 opacity-100' : 'translate-y-[6px] opacity-0'
          } ${verdict === 'rejected' ? 'border-l-2 border-l-red' : 'border-l-2 border-l-green'}`}
        >
          <span
            className={`font-mono text-[15px] font-semibold uppercase tracking-[0.2em] ${
              verdict === 'rejected' ? 'text-red' : 'text-green'
            }`}
          >
            {verdict ?? ''}
          </span>
          <span className="text-[12.5px] text-text-dim">
            {verdict === 'rejected'
              ? 'A gate failed. The phase is marked failed, the evidence is kept, and the builder gets it back.'
              : verdict === 'accepted'
                ? 'All gates passed. The phase result is recorded and the run moves on.'
                : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
