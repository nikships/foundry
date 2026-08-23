import { createRoot } from 'react-dom/client';
import App from './App.js';
import './design/tokens-base.css';
import './design/tokens-factory.css';
import './design/factory/factory.css';

// Safe startup fallback. AppProvider replaces this with persisted settings and
// marks the document ready before the renderer becomes visible.
document.documentElement.setAttribute('data-brand', 'factory');
document.documentElement.setAttribute('data-theme', 'dark');
document.documentElement.style.colorScheme = 'dark';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');
createRoot(container).render(<App />);
