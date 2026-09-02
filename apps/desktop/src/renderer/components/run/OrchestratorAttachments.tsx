import type { PlanImageAttachment } from '@shared/types.js';
import styles from './OrchestratorAttachments.module.css';

export default function OrchestratorAttachments({
  images,
  onRemove,
}: {
  images: readonly PlanImageAttachment[];
  onRemove: (index: number) => void;
}): React.JSX.Element | null {
  if (images.length === 0) return null;
  return (
    <ul className={styles.row} data-testid="run-request-attachments">
      {images.map((image, index) => (
        <li key={`${image.name ?? image.mediaType}-${index}`} className={styles.chip}>
          <img
            className={styles.thumb}
            src={`data:${image.mediaType};base64,${image.data}`}
            alt=""
            data-testid="run-request-attachment"
          />
          <span className={styles.name}>{image.name ?? `Pasted image ${index + 1}`}</span>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove ${image.name ?? `Pasted image ${index + 1}`}`}
            onClick={() => onRemove(index)}
            data-testid="run-request-attachment-remove"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
