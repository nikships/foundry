import { useOnboarding } from './OnboardingContext.js';
import { Button } from '../../components/ui/Button.js';

export type StepId = 'welcome' | 'providers' | 'doctor' | 'project';

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'providers', label: 'Providers' },
  { id: 'doctor', label: 'Ready' },
  { id: 'project', label: 'Project' },
];

/**
 * The one footer every onboarding screen renders. Back sits far left, the
 * primary action sits far right, both pinned to the bottom of the shell via
 * `margin-top: auto` so they never move between steps. The slot between is
 * for step-specific status text only — never buttons.
 */
export function StepFooter({
  nextLabel = 'Continue',
  onNext,
  nextDisabled = false,
  nextTitle,
  busy = false,
  hint,
  showBack = true,
}: {
  nextLabel?: string;
  onNext?: () => void;
  nextDisabled?: boolean;
  nextTitle?: string;
  busy?: boolean;
  hint?: string;
  showBack?: boolean;
}): React.JSX.Element {
  const { next, back } = useOnboarding();
  return (
    <div className="ob-foot">
      {showBack ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={back}
          data-testid="onboarding-back"
        >
          Back
        </Button>
      ) : null}
      <span className="ob-grow" />
      {hint ? <span className="ob-foot-hint">{hint}</span> : null}
      <Button
        type="button"
        variant="primary"
        disabled={nextDisabled || busy}
        title={nextTitle}
        onClick={onNext ?? next}
        data-testid="onboarding-next"
      >
        {busy ? 'Saving…' : nextLabel}
        {!busy ? <span aria-hidden="true"> →</span> : null}
      </Button>
    </div>
  );
}

export function Stepper({
  stepIndex,
  canLeaveDoctor,
  currentStep,
  onGo,
}: {
  stepIndex: number;
  canLeaveDoctor: boolean;
  currentStep: StepId;
  onGo: (i: number) => void;
}): React.JSX.Element {
  return (
    <nav className="ob-stepper" aria-label="Onboarding steps">
      {STEPS.map((s, i) => (
        <button
          key={s.id}
          type="button"
          className={`ob-step-pill ${i === stepIndex ? 'on' : ''} ${i < stepIndex ? 'done' : ''}`}
          data-testid={`onboarding-step-${s.id}`}
          onClick={() => {
            if (i > stepIndex && currentStep === 'doctor' && !canLeaveDoctor) return;
            if (i > stepIndex + 1) return;
            onGo(i);
          }}
        >
          <span className="ob-dot" />
          <span className="ob-label">{s.label}</span>
        </button>
      ))}
    </nav>
  );
}
