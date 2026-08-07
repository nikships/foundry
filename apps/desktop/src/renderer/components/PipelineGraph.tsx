import { useMemo } from 'react';
import type { PipelineDef } from '@shared/types.js';
import { useApp } from '../stores/app.js';

const NODE_W = 128;
const GAP = 28;
const ARC_H = 34;
const KIND_COLOR: Record<string, string> = { code: 'var(--blue)', engineer: 'var(--amber)' };

export default function PipelineGraph({
  pipeline,
  selected,
  onSelect,
}: {
  pipeline: PipelineDef;
  selected: number;
  onSelect: (index: number) => void;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const color = (index: number): string => {
    const phase = pipeline.phases[index]!;
    return phase.kind === 'agent' ? agentColor(phase.agent ?? null) : KIND_COLOR[phase.kind]!;
  };
  const width = Math.max(1, pipeline.phases.length) * (NODE_W + GAP);
  const feedback = useMemo(() => {
    const edges: { from: number; to: number; retries: number }[] = [];
    pipeline.phases.forEach((phase, from) => {
      if (!phase.feedbackTo) return;
      const to = pipeline.phases.findIndex((p) => p.name === phase.feedbackTo);
      if (to >= 0) edges.push({ from, to, retries: phase.feedbackRetries ?? 1 });
    });
    return edges;
  }, [pipeline.phases]);

  const centerOf = (index: number): number => index * (NODE_W + GAP) + NODE_W / 2;
  const arcPath = (from: number, to: number): string => {
    const x1 = centerOf(from);
    const x2 = centerOf(to);
    const lift = ARC_H + Math.abs(from - to) * 4;
    return `M ${x1} ${ARC_H} C ${x1} ${ARC_H - lift}, ${x2} ${ARC_H - lift}, ${x2} ${ARC_H}`;
  };

  return (
    <>
      <div className="graph">
        <svg className="arcs" width={width} height={ARC_H} viewBox={`0 0 ${width} ${ARC_H}`}>
          <defs>
            <marker
              id="fb-arrow"
              viewBox="0 0 8 8"
              refX={4}
              refY={4}
              markerWidth={6}
              markerHeight={6}
              orient="auto"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--amber)" />
            </marker>
          </defs>
          {feedback.map((edge, i) => (
            <path
              key={i}
              d={arcPath(edge.from, edge.to)}
              fill="none"
              stroke="var(--amber)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              markerEnd="url(#fb-arrow)"
              opacity={0.8}
            />
          ))}
        </svg>
        <div className="nodes" style={{ width: `${width}px` }}>
          {pipeline.phases.map((phase, i) => (
            <div
              key={i}
              className="node-wrap"
              style={{ width: `${NODE_W}px`, marginRight: `${GAP}px` }}
            >
              <button
                className={`node ${selected === i ? 'on' : ''}`}
                style={{ borderColor: `color-mix(in srgb, ${color(i)} 50%, transparent)` }}
                onClick={() => onSelect(i)}
              >
                <span className="dot" style={{ background: color(i) }} />
                <span className="node-name">{phase.name}</span>
                <span className="faint node-kind">
                  {phase.kind === 'engineer' ? 'checkpoint' : phase.kind}
                </span>
                {phase.optional && <span className="faint opt">optional</span>}
              </button>
              {i < pipeline.phases.length - 1 && <span className="edge">→</span>}
            </div>
          ))}
        </div>
        {!pipeline.phases.length && <p className="faint none">No phases yet. Add one below.</p>}
      </div>
      <style>{`
        .graph { overflow-x: auto; padding: var(--s2) 0 var(--s3); }
        .arcs { display: block; overflow: visible; }
        .nodes { display: flex; align-items: flex-start; }
        .node-wrap { position: relative; flex: none; }
        .node { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: var(--s2) var(--s3); border: 1px solid; border-radius: var(--r); background: var(--bg-raised); color: inherit; font: inherit; text-align: left; cursor: default; transition: background var(--fast) var(--ease); }
        .node:hover { background: var(--bg-hover); }
        .node.on { background: var(--bg-active); box-shadow: var(--glow-cyan); }
        .dot { width: 7px; height: 7px; border-radius: var(--r-full); }
        .node-name { font-size: var(--text-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
        .node-kind, .opt { font-size: 10px; }
        .opt { color: var(--text-ghost); }
        .edge { position: absolute; right: -20px; top: 50%; transform: translateY(-50%); color: var(--text-ghost); font-size: var(--text-sm); }
        .none { font-size: var(--text-sm); padding: var(--s3) 0; }
      `}</style>
    </>
  );
}
