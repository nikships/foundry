import { useBrandedAsset } from '../hooks/useBrandedAsset.js';

export default function EmptyState({
  art,
  title,
  body,
  children,
}: {
  art?: string;
  title: string;
  body: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  const src = useBrandedAsset(art ?? null);
  return (
    <>
      <div className="empty">
        {src && <img src={src} alt="" />}
        <h2>{title}</h2>
        <p>{body}</p>
        {children}
      </div>
      <style>{`
        .empty {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--s3);
          padding: var(--s12) var(--s6);
          text-align: center;
        }
        .empty img {
          width: 220px;
          height: 220px;
          object-fit: contain;
          opacity: 0.75;
          margin-bottom: var(--s2);
        }
        .empty h2 {
          font-size: var(--text-lg);
          font-weight: 600;
        }
        .empty p {
          max-width: 42ch;
          color: var(--text-dim);
          font-size: var(--text-sm);
          line-height: var(--leading-loose);
        }
      `}</style>
    </>
  );
}
