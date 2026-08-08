import type { PipelineDef } from '@shared/types.js';
import { useApp } from '../stores/app.js';
import { phaseKindColor } from '../derive.js';

export default function PipelineRibbon({ pipeline }: { pipeline: PipelineDef }): React.JSX.Element {
  const { agentColor } = useApp();
  const colorFor = (phase: PipelineDef['phases'][number]): string =>
    phaseKindColor(phase.kind, agentColor(phase.agent ?? null));

  return (
    <>
      <div className="ribbon" title={pipeline.phases.map((p) => p.name).join(' → ')}>
        {pipeline.phases.map((phase, i) => {
          const color = colorFor(phase);
          let connector: React.ReactNode = null;
          if (phase.feedbackTo) {
            connector = (
              <span className="loop" title={`sends failures back to ${phase.feedbackTo}`}>
                ↩
              </span>
            );
          } else if (i < pipeline.phases.length - 1) {
            connector = <span className="arrow">→</span>;
          }
          return (
            <span key={phase.name} style={{ display: 'contents' }}>
              <span
                className="chip"
                style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, color }}
              >
                {phase.name}
              </span>
              {connector}
            </span>
          );
        })}
      </div>
      <style>{`
        .ribbon { display: flex; align-items: center; gap: var(--s1); overflow: hidden; min-width: 0; }
        .chip { padding: 2px var(--s2); border: 1px solid; border-radius: var(--r-sm); font-size: var(--text-xs); white-space: nowrap; }
        .arrow, .loop { color: var(--text-ghost); font-size: var(--text-xs); }
        .loop { color: var(--amber); }
      `}</style>
    </>
  );
}
