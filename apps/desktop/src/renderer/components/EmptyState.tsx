import { useBrandedAsset } from '../hooks/useBrandedAsset.js';
import styles from './EmptyState.module.css';

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
    <div className={styles.empty}>
      {src && <img src={src} alt="" />}
      <h2>{title}</h2>
      <p>{body}</p>
      {children}
    </div>
  );
}
