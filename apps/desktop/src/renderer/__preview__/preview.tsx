/* Temporary onboarding preview harness. Not part of the app; delete when done. */
import './stub.js';
import { createRoot } from 'react-dom/client';
import { Component, useState } from 'react';
import { AppProvider } from '../stores/app.js';
import OnboardingShell from '../screens/onboarding/OnboardingShell.js';
import '../design/tokens-base.css';
import '../design/tokens-prism.css';
import '../design/prism/prism.css';
import '../design/prism/prism-animations.css';

document.documentElement.setAttribute('data-brand', 'prism');
document.documentElement.style.colorScheme = 'dark';

class Boundary extends Component<{ children: React.ReactNode }, { err: Error | null }> {
  override state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error): { err: Error } {
    return { err };
  }
  override render(): React.ReactNode {
    const { err } = this.state;
    if (err)
      return (
        <pre id="boom" style={{ color: '#fff', padding: 20, whiteSpace: 'pre-wrap' }}>
          {String(err.stack ?? err.message)}
        </pre>
      );
    return this.props.children;
  }
}

function Preview(): React.JSX.Element {
  const [n, setN] = useState(0);
  return (
    <div className="shell">
      <div className="titlebar" />
      <Boundary>
        <AppProvider>
          <OnboardingShell key={n} onDone={() => setN((v) => v + 1)} />
        </AppProvider>
      </Boundary>
      <style>{`
        .shell { display: flex; height: 100%; background: var(--bg-base); }
        .titlebar { position: fixed; top: 0; left: 0; right: 0; height: var(--titlebar-h); z-index: 50; pointer-events: none; }
      `}</style>
    </div>
  );
}

createRoot(document.getElementById('app')!).render(<Preview />);
