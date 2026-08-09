import { useBrandedAsset } from '../../hooks/useBrandedAsset.js';
import { useOnboarding } from './OnboardingContext.js';
import { Button } from '../../components/ui/Button.js';

export type StepId = 'welcome' | 'factory' | 'roster' | 'clis' | 'doctor' | 'project';

export const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'factory', label: 'Factory' },
  { id: 'roster', label: 'Roster' },
  { id: 'clis', label: 'CLIs' },
  { id: 'doctor', label: 'Ready' },
  { id: 'project', label: 'Project' },
];

export const BUILTIN_AGENTS: { name: string; role: string }[] = [
  { name: 'refiner', role: 'Sharpens the ask' },
  { name: 'planner', role: 'Shapes the work' },
  { name: 'builder', role: 'Writes the code' },
  { name: 'scout', role: 'Maps the repo' },
  { name: 'finisher', role: 'Holds the bar' },
  { name: 'reviewer', role: 'Judges the diff' },
  { name: 'documenter', role: 'Leaves the trail' },
];

export const CONCEPTS: { art: string; title: string; body: string }[] = [
  {
    art: 'concepts/pipeline.png',
    title: 'Pipelines are data',
    body: 'Reorder phases, swap agents, add a reviewer. No scripts to rewrite.',
  },
  {
    art: 'concepts/envelope.png',
    title: 'Typed envelopes',
    body: 'Every agent reply is structured. Code decides if it counts.',
  },
  {
    art: 'concepts/gate.png',
    title: 'Gates leave evidence',
    body: 'A green gate says what it checked, not only that it passed.',
  },
];

export function sceneForStep(step: StepId): string {
  if (step === 'welcome') return 'scenes/onboarding-hero.png';
  if (step === 'factory') return 'scenes/pipeline-designer.png';
  if (step === 'roster') return 'scenes/run-success.png';
  if (step === 'clis') return 'scenes/onboarding-hero.png';
  if (step === 'doctor') return 'scenes/empty-state.png';
  return 'scenes/pipeline-designer.png';
}

export function SceneArt({
  path,
  className,
}: {
  path: string;
  className?: string;
}): React.JSX.Element {
  const src = useBrandedAsset(path);
  const placeholderStyle: React.CSSProperties = {
    border: '1px solid var(--line)',
    borderRadius: 'var(--r)',
    overflow: 'hidden',
    background: 'var(--bg-base)',
  };
  if (!src)
    return <div className={`scene-art placeholder ${className ?? ''}`} style={placeholderStyle} />;
  return <img className={`scene-art ${className ?? ''}`} src={src} alt="" />;
}

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
        <Button type="button" variant="ghost" disabled={busy} onClick={back}>
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
