import { createRoot } from 'react-dom/client';
import App from './App.js';
import './design/tokens.css';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');
createRoot(container).render(<App />);
