/**
 * Check evidence.
 *
 * Each check runs in turn against the report the agent produced and the state
 * of the worktree, and leaves a line of evidence behind. Every second pass the
 * agent lists a blocker and still claims success — `verdict_consistent` and
 * `disapproval_halts` are exactly what a claim like that is for, and the phase
 * aborts instead of flowing on into a commit.
 *
 * Mirrors the GateReport / GateCheck shape in
 * apps/desktop/src/main/engine/gates.ts.
 */

import { useEffect, useState } from 'react';
import { CHECK_RUN } from '../../data/foundry';
import { useInView, useReducedMotion } from '../../hooks';

type CheckState = 'idle' | 'run' | 'pass' | 'fail';

const FINISHED: CheckState[] = CHECK_RUN.checks.map(() => 'pass');

export function CheckEvidenceDemo() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.25);

  const [states, setStates] = useState<CheckState[]>(() =>
    reduced ? FINISHED : CHECK_RUN.checks.map(() => 'idle'),
  );
  const [verdict, setVerdict] = useState<'accepted' | 'halted' | null>(reduced ? 'accepted' : null);
  /** which pass we are on — every other one fails, so the failure path is
   *  visible without the visitor having to do anything */
  const [pass, setPass] = useState(true);

  useEffect(() => {
    if (reduced || !inView) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    setStates(CHECK_RUN.checks.map(() => 'idle'));
    setVerdict(null);

    let t = 420;
    let failed = false;

    CHECK_RUN.checks.forEach((check, i) => {
      const willFail = !pass && Boolean(check.fail);
      at(t, () => setStates((prev) => prev.map((s, j) => (j === i ? 'run' : s))));
      t += 320 + i * 90;
      at(t, () => {
        setStates((prev) =>
          prev.map((s, j) => {
            if (j !== i) return s;
            return willFail ? 'fail' : 'pass';
          }),
        );
      });
      if (willFail) failed = true;
      t += 240;
    });

    at(t + 260, () => setVerdict(failed ? 'halted' : 'accepted'));
    at(t + 3600, () => setPass((p) => !p));

    return () => timers.forEach(clearTimeout);
  }, [pass, inView, reduced]);

  const claim = pass ? CHECK_RUN.claim : CHECK_RUN.badClaim;

  return (
    <div ref={ref} className="grid grid-cols-1 md:grid-cols-2">
      {/* ── what the agent claimed ───────────────────────────────────── */}
      <div className="p-[22px]">
        <span className="label-sm mb-[14px] block text-text-faint">What the agent reported</span>
        <div className="font-mono text-[11.5px] leading-[1.75] text-text-dim">
          <span className="text-text-faint">{'{'}</span>
          {claim.map(([k, v]) => {
            const contradicts = !pass && (k === 'approved' || k === 'blocking');
            return (
              <div key={k} className="pl-4">
                <span className="text-text-faint">&quot;{k}&quot;</span>
                <span className="text-text-ghost">: </span>
                <span className={contradicts ? 'text-red' : 'text-green'}>{v}</span>
                <span className="text-text-ghost">,</span>
              </div>
            );
          })}
          <span className="text-text-faint">{'}'}</span>
        </div>

        <span className="label-sm mb-[10px] mt-[22px] block text-text-faint">
          Declared artifacts
        </span>
        <div className="font-mono text-[11.5px] leading-[1.75] text-text-dim">
          {CHECK_RUN.files.map((f) => (
            <div key={f}>
              <span className="text-text-ghost">· </span>
              {f}
            </div>
          ))}
        </div>

        <p className="mt-[22px] max-w-[46ch] border-t border-line-faint pt-[14px] text-[12.5px] leading-[1.6] text-text-faint">
          A check is a function, not a judgement. It takes the report the agent produced and the
          state of the worktree, and returns checks with evidence attached. The agent does not get a
          vote on whether its own work passed.
        </p>
      </div>

      {/* ── what the checks found ────────────────────────────────────── */}
      <div className="border-t border-line bg-bg-panel p-[22px] md:border-l md:border-t-0">
        <span className="label-sm mb-2 block text-text-faint">What the checks found</span>

        {CHECK_RUN.checks.map((check, i) => {
          const state = states[i];
          const open = state === 'pass' || state === 'fail';
          return (
            <div
              key={check.name}
              className="flex gap-[11px] border-t border-line-faint py-[13px] first:border-t-0"
            >
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
                    <path
                      d="M3 3 L9 9 M9 3 L3 9"
                      stroke="currentColor"
                      strokeWidth={2.2}
                      strokeLinecap="round"
                    />
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
          } ${verdict === 'halted' ? 'border-l-2 border-l-red' : 'border-l-2 border-l-green'}`}
        >
          <span
            className={`flex-none font-mono text-[14px] font-semibold uppercase tracking-[0.18em] ${
              verdict === 'halted' ? 'text-red' : 'text-green'
            }`}
          >
            {verdict ?? ''}
          </span>
          <span className="text-[12.5px] leading-[1.5] text-text-dim">
            {verdict === 'halted'
              ? 'The phase failed. The evidence is kept, nothing is committed, and no pull request is opened.'
              : verdict === 'accepted'
                ? 'All checks passed. The phase result is recorded and the run moves on to its commit.'
                : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
