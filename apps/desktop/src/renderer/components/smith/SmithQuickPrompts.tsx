import { SMITH_QUICK_PROMPTS } from '../../view-models/smith-chat-view.js';
import { SMITH_QUICK_PROMPTS_LABEL } from '../../view-models/smith-copy.js';
import { Button } from '../ui/Button.js';
import styles from './SmithQuickPrompts.module.css';

/**
 * One-tap entry points for Smith's full user-level access: assigned Linear
 * work + status, orchestrator plans, saved pipelines, context refresh, and
 * the voice-key state. A tap prefills the composer — it never sends — so the
 * operator confirms or edits the prompt before Smith proposes anything, and
 * the same phrasing works spoken through `smith_work` in voice mode.
 */
export default function SmithQuickPrompts({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (prompt: string) => void;
}): React.JSX.Element {
  return (
    <div className={styles.quick} role="group" aria-label="Smith quick prompts">
      <span className={styles.label}>{SMITH_QUICK_PROMPTS_LABEL}</span>
      {SMITH_QUICK_PROMPTS.map((item) => (
        <Button
          key={item.id}
          size="sm"
          variant="ghost"
          disabled={disabled}
          title={item.hint}
          onClick={() => onPick(item.prompt)}
          data-testid={`smith-quick-prompt-${item.id}`}
        >
          {item.label}
        </Button>
      ))}
    </div>
  );
}
