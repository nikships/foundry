import { useBrandedAsset } from '../../hooks/useBrandedAsset.js';

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
  { name: 'planner', role: 'Shapes the work' },
  { name: 'builder', role: 'Writes the code' },
  { name: 'scout', role: 'Maps the repo' },
  { name: 'reviewer', role: 'Judges the diff' },
  { name: 'documenter', role: 'Leaves the trail' },
];

export const CONCEPTS: { art: string; title: string; body: string }[] = [
  { art: 'concepts/pipeline.png', title: 'Pipelines are data', body: 'Reorder phases, swap agents, add a reviewer. No scripts to rewrite.' },
  { art: 'concepts/envelope.png', title: 'Typed envelopes', body: 'Every agent reply is structured. Code decides if it counts.' },
  { art: 'concepts/gate.png', title: 'Gates leave evidence', body: 'A green gate says what it checked, not only that it passed.' },
];

export function sceneForStep(step: StepId): string {
  if (step === 'welcome') return 'scenes/onboarding-hero.png';
  if (step === 'factory') return 'scenes/pipeline-designer.png';
  if (step === 'roster') return 'scenes/run-success.png';
  if (step === 'clis') return 'scenes/onboarding-hero.png';
  if (step === 'doctor') return 'scenes/empty-state.png';
  return 'scenes/pipeline-designer.png';
}

export function SceneArt({ path, className }: { path: string; className?: string }): React.JSX.Element {
  const src = useBrandedAsset(path);
  if (!src) return <div className={`scene-art placeholder ${className ?? ''}`} />;
  return <img className={`scene-art ${className ?? ''}`} src={src} alt="" />;
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
