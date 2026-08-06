import { statusColor, statusWord } from '../format.js';

export default function StatusBadge({ status, label, dot = true }: { status: string; label?: string; dot?: boolean }): React.JSX.Element {
  const color = statusColor(status);
  const text = label ?? statusWord(status);
  const spinning = status === 'running';
  return (
    <>
      <span className="badge" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
        {dot && <span className={`dot ${spinning ? 'spinning' : ''}`} style={{ background: color }} />}
        {text}
      </span>
      <style>{`
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 2px 8px;
          border-radius: var(--r-full);
          font-size: var(--text-xs);
          font-weight: 500;
          white-space: nowrap;
        }
        .dot {
          width: 6px;
          height: 6px;
          border-radius: var(--r-full);
          flex: none;
        }
        .dot.spinning {
          animation: pulse 1.4s var(--ease) infinite;
        }
      `}</style>
    </>
  );
}
