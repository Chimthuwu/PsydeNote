import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PopoutApp from './PopoutApp';
import './styles.css';

// One bundle, two roots. Main runs the pop-out window on the same page with
// `#popout` in the URL (see src/main/popout.ts) so there's nothing extra to
// build or ship.
const isPopout = window.location.hash.replace('#', '') === 'popout';

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>{isPopout ? <PopoutApp /> : <App />}</React.StrictMode>,
  );
}
