/**
 * Casting a run.
 *
 * Model and reasoning effort are set per agent, and any phase may override the
 * agent's choice — so one run can span five providers. Foundry keeps no model
 * allowlist of its own: an id is an opaque `provider/model` string, and
 * anything the install can reach is selectable anywhere a model is chosen.
 *
 * The failover strip is the real behaviour in
 * apps/desktop/src/main/pi/model-failover.ts: when a model exhausts its
 * retries, the turn continues on the next reachable model with the
 * conversation and tool results intact, and the fallback gets its own budget.
 */

import { useEffect, useState } from 'react';
import { CAST, agentColor } from '../../data/foundry';
import { useInView, useReducedMotion } from '../../hooks';

type Phase = 'idle' | 'running' | 'failed' | 'failing-over' | 'recovered' | 'done';

/** Which seat we knock over to show failover. `build`, because it is the expensive one. */
const VICTIM = 2;
const FALLBACK = 'claude-opus-5';

export function ModelCastingDemo() {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [active, setActive] = useState(reduced ? CAST.length : -1);
  const [phase, setPhase] = useState<Phase>(reduced ? 'done' : 'idle');

  useEffect(() => {
    if (reduced || !inView) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    setActive(-1);
    setPhase('idle');

    let t = 500;
    CAST.forEach((_, i) => {
      at(t, () => {
        setActive(i);
        setPhase('running');
      });
      t += 900;

      if (i === VICTIM) {
        at(t, () => setPhase('failed'));
        t += 1100;
        at(t, () => setPhase('failing-over'));
        t += 1300;
        at(t, () => setPhase('recovered'));
        t += 900;
      }
    });

    at(t, () => {
      setActive(CAST.length);
      setPhase('done');
    });
    at(t + 3200, () => {
      setActive(-1);
      setPhase('idle');
    });

    return () => timers.forEach(clearTimeout);
  }, [inView, reduced]);

  const failoverOn = phase === 'failed' || phase === 'failing-over' || phase === 'recovered';

  return (
    <div ref={ref}>
      <div className="grid grid-cols-1">
        {CAST.map((seat, i) => {
          const done = i < active || phase === 'done';
          const current = i === active && phase !== 'done';
          const victim = i === VICTIM && failoverOn;
          const swapped = i === VICTIM && (phase === 'recovered' || phase === 'done');

          const dot = victim
            ? phase === 'recovered'
              ? 'var(--green)'
              : 'var(--red)'
            : current
              ? 'var(--accent)'
              : done
                ? 'var(--green)'
                : 'var(--text-ghost)';

          return (
            <div
              key={seat.phase}
              className={`grid grid-cols-[16px_minmax(0,150px)_minmax(0,1fr)] items-start gap-x-[14px] gap-y-1 border-t border-line-faint px-[18px] py-[13px] transition-colors duration-normal ease-mech first:border-t-0 md:grid-cols-[16px_minmax(0,150px)_minmax(0,200px)_minmax(0,1fr)] ${
                current ? 'bg-bg-raised' : ''
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-[6px] h-[7px] w-[7px] flex-none rounded-full ${current || phase === 'failing-over' ? 'animate-pulse-soft' : ''}`}
                style={{ background: dot }}
              />

              <span className="min-w-0">
                <span className="block truncate font-mono text-[12.5px] text-text">
                  {seat.phase}
                </span>
                <span
                  className="mt-[3px] block truncate font-mono text-[10px] uppercase tracking-label"
                  style={{ color: agentColor(seat.agent) }}
                >
                  {seat.agent}
                </span>
              </span>

              <span className="col-start-2 min-w-0 md:col-start-auto">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={`font-mono text-[12px] transition-colors duration-normal ease-mech ${
                      swapped ? 'text-text-ghost line-through' : 'text-text-dim'
                    }`}
                  >
                    {seat.model}
                  </span>
                  {swapped ? (
                    <span className="font-mono text-[12px] text-green">→ {FALLBACK}</span>
                  ) : null}
                </span>
                <span className="mt-[3px] block font-mono text-[9.5px] uppercase tracking-label text-text-ghost">
                  {swapped ? 'Claude' : seat.vendor}
                </span>
              </span>

              <span className="col-start-2 text-[12.5px] leading-[1.55] text-text-faint md:col-start-auto">
                {victim && phase !== 'recovered'
                  ? phase === 'failed'
                    ? 'gpt-5.6-sol failed after 5 retries'
                    : 'continuing this turn on the next reachable model — conversation and tool results intact'
                  : seat.why}
              </span>
            </div>
          );
        })}
      </div>

      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-[18px] py-[12px] transition-colors duration-normal ease-mech ${
          failoverOn ? 'bg-red-dim' : ''
        }`}
      >
        <span
          className={`font-mono text-[10px] uppercase tracking-eyebrow ${failoverOn ? 'text-red' : 'text-text-ghost'}`}
        >
          {failoverOn ? 'failover' : 'six phases, five providers, one run'}
        </span>
        <span className="text-[12.5px] leading-[1.5] text-text-dim">
          {failoverOn
            ? 'A provider going down degrades a run’s speed, not its outcome.'
            : 'Set a model per agent, override it per phase. Nobody’s roster is hardcoded, including this one.'}
        </span>
      </div>
    </div>
  );
}
