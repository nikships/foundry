import React, { useState } from 'react';
import { CliIcon } from '../../components/BrandIcon.js';
import { OnboardingProvider } from './OnboardingContext.js';
import { Stepper } from './shared.js';
import { useOnboarding } from './OnboardingContext.js';
import './onboarding.css';

import WelcomeScreen from './WelcomeScreen.js';
import FactoryScreen from './FactoryScreen.js';
import RosterScreen from './RosterScreen.js';
import CliScreen from './CliScreen.js';
import DoctorScreen from './DoctorScreen.js';
import ProjectScreen from './ProjectScreen.js';

const STEP_COMPONENTS: Record<string, React.ComponentType> = {
  welcome: WelcomeScreen,
  factory: FactoryScreen,
  roster: RosterScreen,
  clis: CliScreen,
  doctor: DoctorScreen,
  project: ProjectScreen,
};

function OnboardingShellInner(): React.JSX.Element {
  const { step, stepIndex, canLeaveDoctor, go, entered } = useOnboarding();
  const Active = STEP_COMPONENTS[step] ?? WelcomeScreen;
  return (
    <div className={`ob-shell ${entered ? 'in' : ''}`}>
      <div className="ob-stage" aria-hidden>
        <div className="ob-orb ob-orb-a" />
        <div className="ob-orb ob-orb-b" />
        <div className="ob-orb ob-orb-c" />
        <div className="ob-grid" />
      </div>
      <header className="ob-top">
        <div className="ob-brand">
          <CliIcon vendor="droid" size={20} />
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
