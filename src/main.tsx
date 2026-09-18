import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { applyTheme, resolveInitialTheme } from './theme';

// Applied synchronously, before the first paint, so the page never flashes
// the wrong theme.
applyTheme(resolveInitialTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
