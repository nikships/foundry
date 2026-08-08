import { createRoot } from 'react-dom/client';
import App from './App.js';
import { resolveBrand } from './hooks/useBrand.js';
import './design/tokens-base.css';

// Exactly one brand's sheets are ever fetched, so Prism's shader chrome never
// ships to a Murmur window and vice versa. `data-brand` is set only after they
// resolve, which is what releases the FOUC guard in index.html.
const brand = resolveBrand();
if (brand === 'prism') {
  await Promise.all([
    import('./design/tokens-prism.css'),
    import('./design/prism/prism.css'),
    import('./design/prism/prism-animations.css'),
  ]);
} else {
  await import('./design/tokens-murmur.css');
}
document.documentElement.setAttribute('data-brand', brand);
document.documentElement.style.colorScheme = 'dark';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');
createRoot(container).render(<App />);
