import { createRoot } from 'react-dom/client';
import App from './App.js';
import './design/tokens-base.css';
import './design/tokens-factory.css';
import './design/factory/factory.css';

// `data-brand` is set before render so the FOUC guard in index.html releases
// only once the Factory token sheet is already imported — no palette flashes.
document.documentElement.setAttribute('data-brand', 'factory');
document.documentElement.style.colorScheme = 'dark';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');
createRoot(container).render(<App />);
