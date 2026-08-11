/**
 * Showcase entry. Review surface only — never bundled into the desktop app.
 *
 * `ShowcaseApp` imports the seeded backend itself, so no ordering is required
 * here and this stays a plain mount.
 */
import { createRoot } from 'react-dom/client';
import ShowcaseApp from './ShowcaseApp.js';
import '../design/tokens-base.css';
import '../design/tokens-factory.css';
import '../design/factory/factory.css';
// Last, so it wins over the app shell reset in tokens-base.css.
import './showcase-reset.css';

document.documentElement.setAttribute('data-brand', 'factory');
document.documentElement.style.colorScheme = 'dark';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');
createRoot(container).render(<ShowcaseApp />);
