import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';

export default function AgentAvatar({
  name,
  size = 28,
}: {
  name: string | null;
  size?: number;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const [src, setSrc] = useState('');
  const color = agentColor(name);
  const initial = (name ?? '?').slice(0, 1).toUpperCase();

  useEffect(() => {
    if (!name) {
      setSrc('');
      return;
    }
    void api.app.assetUrl(`agents/${name}.png`).then(setSrc);
  }, [name]);

  return (
    <>
      <span
        className={`avatar ${src ? 'emblem' : ''}`}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderColor: `color-mix(in srgb, ${color} ${src ? 72 : 45}%, transparent)`,
          background: src ? 'var(--bg-void)' : `color-mix(in srgb, ${color} 14%, var(--bg-raised))`,
          color,
          fontSize: `${Math.round(size * 0.42)}px`,
        }}
        title={name ?? undefined}
      >
        {src ? <img src={src} alt={name ?? ''} /> : initial}
      </span>
      <style>{`
        .avatar {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--r-full);
          border: 1px solid;
          overflow: hidden;
          flex: none;
          font-weight: 600;
        }
        .avatar.emblem {
          box-shadow: 0 0 0 1px var(--bg-void), var(--shadow-sm);
        }
        .avatar img {
          width: 118%;
          height: 118%;
          object-fit: cover;
        }
      `}</style>
    </>
  );
}
