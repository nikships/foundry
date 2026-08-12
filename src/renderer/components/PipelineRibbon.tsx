import type { PipelineDef } from '@shared/types.js';
import { useApp } from '../stores/app.js';
import { phaseKindColor } from '../derive.js';
import styles from './PipelineRibbon.module.css';

export default function PipelineRibbon({ pipeline }: { pipeline: PipelineDef }): React.JSX.Element {
  const { agentColor } = useApp();
  const colorFor = (phase: PipelineDef['phases'][number]): string =>
    phaseKindColor(phase.kind, agentColor(phase.agent ?? null));

  return (
    <div className={styles.ribbon} title={pipeline.phases.map((p) => p.name).join(' → ')}>
      {pipeline.phases.map((phase, i) => {
        const color = colorFor(phase);
        let connector: React.ReactNode = null;
        if (phase.feedbackTo) {
          connector = (
            <span className={styles.loop} title={`sends failures back to ${phase.feedbackTo}`}>
              ↩
            </span>
          );
        } else if (i < pipeline.phases.length - 1) {
          connector = <span className={styles.arrow}>→</span>;
        }
        return (
          <span key={phase.name} style={{ display: 'contents' }}>
            <span
              className={styles.chip}
              style={{ borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, color }}
            >
              {phase.name}
            </span>
            {connector}
          </span>
        );
      })}
    </div>
  );
}
