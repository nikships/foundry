import React, { useState } from 'react';
import { FoundryGlyph } from '../../components/media/BrandIcon.js';
import { OnboardingProvider, useOnboarding } from './OnboardingContext.js';
import { Stepper, type StepId } from './shared.js';
import './onboarding.css';

import WelcomeScreen from './WelcomeScreen.js';
import ProvidersScreen from './ProvidersScreen.js';
import DoctorScreen from './DoctorScreen.js';
import ProjectScreen from './ProjectScreen.js';

const STEP_COMPONENTS: Record<StepId, React.ComponentType> = {
  welcome: WelcomeScreen,
  providers: ProvidersScreen,
  doctor: DoctorScreen,
  project: ProjectScreen,
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
        <Active />
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
