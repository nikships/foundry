import React, { useState } from 'react';
import { FoundryGlyph } from '../../components/media/FoundryGlyph.js';
import { OnboardingProvider, useOnboarding } from './OnboardingContext.js';
import { Stepper, type StepId } from './shared.js';
import './onboarding.css';

const STEP_COMPONENTS: Record<StepId, React.LazyExoticComponent<React.ComponentType>> = {
  welcome: React.lazy(() => import('./WelcomeScreen.js')),
  providers: React.lazy(() => import('./ProvidersScreen.js')),
  doctor: React.lazy(() => import('./DoctorScreen.js')),
  project: React.lazy(() => import('./ProjectScreen.js')),
};

function OnboardingShellInner(): React.JSX.Element {
  const { step, stepIndex, canLeaveDoctor, go, entered } = useOnboarding();
  const Active = STEP_COMPONENTS[step];
  return (
    <div className={`ob-shell ${entered ? 'in' : ''}`}>
      <div className="ob-backdrop" aria-hidden>
        <div className="ob-grid" />
      </div>
      <header className="ob-top">
        <div className="ob-brand" aria-hidden>
          <FoundryGlyph size={13} />
          <span>Foundry</span>
        </div>
        <Stepper
          stepIndex={stepIndex}
          canLeaveDoctor={canLeaveDoctor}
          currentStep={step}
          onGo={go}
        />
      </header>
      <div className="ob-page" key={step}>
        <React.Suspense fallback={null}>
          <Active />
        </React.Suspense>
      </div>
    </div>
  );
}

export default function OnboardingShell({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [stepIndex, setStepIndex] = useState(0);
  return (
    <OnboardingProvider stepIndex={stepIndex} setStepIndex={setStepIndex} onDone={onDone}>
      <OnboardingShellInner />
    </OnboardingProvider>
  );
}
