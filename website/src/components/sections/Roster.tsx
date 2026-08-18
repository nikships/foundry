/**
 * The crew. The eight agents Foundry ships with, their real envelopes,
 * reasoning budgets and write boundaries, and a line from each system prompt.
 *
 * Mirrors src/renderer/screens/RosterScreen.tsx.
 */

import { useState } from 'react';
import { AGENTS, ENVELOPE_BLURBS } from '../../data/foundry';
import type { Agent } from '../../data/foundry';

function AgentAvatar({ agent, size }: { agent: Agent; size: number }) {
  const [imgError, setImgError] = useState(false);
  const initial = agent.name === 'pr_writer' ? 'PR' : agent.name.slice(0, 1).toUpperCase();

  if (imgError) {
    return (
      <div
        className="flex flex-none items-center justify-center rounded border font-mono font-semibold"
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderColor: `color-mix(in srgb, ${agent.color} 40%, transparent)`,
          background: `color-mix(in srgb, ${agent.color} 14%, var(--bg-raised))`,
          color: agent.color,
          fontSize: `${Math.round(size * (initial.length > 1 ? 0.34 : 0.42))}px`,
        }}
      >
        {initial}
      </div>
    );
  }

  return (
    <img
      src={`/media/agents/${agent.name}.webp`}
      alt={`${agent.name} agent portrait`}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setImgError(true)}
      className="flex-none rounded border border-line bg-black object-cover"
      style={{ width: `${size}px`, height: `${size}px` }}
    />
  );
}

export function Roster() {
  const [selected, setSelected] = useState(2); // builder
  const agent = AGENTS[selected];

  const boundary =
    agent.writes === null
      ? 'the whole worktree'
      : agent.writes.length
        ? agent.writes.join('  ')
        : 'nothing — read-only';

  return (
    <div className="grid grid-cols-1 overflow-hidden rounded border border-line md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.35fr)]">
      <div className="border-b border-line bg-bg-panel md:border-b-0 md:border-r">
        {AGENTS.map((a, i) => (
          <button
            key={a.name}
            type="button"
            aria-selected={i === selected}
            onClick={() => setSelected(i)}
            className={`grid w-full grid-cols-[30px_34px_minmax(0,1fr)_auto] items-center gap-3 border-t border-line-faint border-l-2 px-4 py-[13px] text-left transition-colors duration-fast ease-mech first:border-t-0 ${
              i === selected
                ? 'border-l-accent bg-bg-raised'
                : 'border-l-transparent hover:bg-bg-hover'
            }`}
          >
            <span className="font-mono text-[10px] tracking-[0.1em] text-text-ghost">
              {String(i + 1).padStart(2, '0')}
            </span>
            <AgentAvatar agent={a} size={34} />
            <span className="min-w-0">
              <span className="block text-[14.5px] font-medium text-text">{a.name}</span>
              <span className="mt-[2px] block text-[12.5px] leading-[1.45] text-text-dim">{a.tagline}</span>
            </span>
            <span className="font-mono text-[9.5px] uppercase tracking-label text-text-ghost">{a.envelope}</span>
          </button>
        ))}
      </div>

      <div className="flex min-h-[420px] flex-col p-[26px]">
        <div className="flex items-start gap-4">
          <AgentAvatar agent={agent} size={76} />
          <div>
            <div className="text-[24px] font-semibold tracking-tight" style={{ color: agent.color }}>
              {agent.name}
            </div>
            <p className="mt-[6px] max-w-[46ch] text-[14.5px] leading-[1.55] text-text-dim">{agent.purpose}</p>
          </div>
        </div>

        <div className="mt-6 grid gap-px overflow-hidden rounded-sm border border-line-faint bg-line-faint [grid-template-columns:repeat(auto-fit,minmax(128px,1fr))]">
          <Fact k="model" v="inherit" />
          <Fact k="reasoning" v={agent.effort} />
          <Fact k="envelope" v={agent.envelope} />
          <Fact k="writes" v={boundary} />
        </div>

        <div className="mt-[22px] rounded-sm border border-line border-l-2 border-l-accent bg-bg-panel px-4 py-[14px]">
          <span className="label-sm mb-[7px] block text-text-faint">From the system prompt</span>
          <p className="text-[13.5px] leading-[1.65] text-text-dim">{agent.prompt}</p>
        </div>

        <div className="mt-[18px]">
          <span className="label-sm mb-[6px] block text-text-faint">{agent.envelope} envelope</span>
          <p className="text-[13px] leading-[1.6] text-text-faint">{ENVELOPE_BLURBS[agent.envelope]}</p>
        </div>
      </div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="bg-bg-base px-[13px] py-3">
      <div className="font-mono text-[9px] uppercase tracking-eyebrow text-text-ghost">{k}</div>
      <div className="mt-[5px] break-words font-mono text-[12px] text-text">{v}</div>
    </div>
  );
}
