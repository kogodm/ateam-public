import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerPwa } from './mobile';
import './styles.css';

registerPwa();

// Kill the webview's default right-click menu ("Reload" etc.) app-wide —
// our own context menus (file lists, terminal) handle right-click where it
// means something. Editable fields keep the native Cut/Copy/Paste menu.
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null;
  if (t?.closest('input, textarea, [contenteditable="true"]')) return;
  e.preventDefault();
});

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);
