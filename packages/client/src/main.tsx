import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createServiceConnector } from './connection/connection.ts';
import { buildConfig } from './config.ts';
import { createPreferencesProfileStore } from './storage/profileStore.ts';
import './styles.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('缺少 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App
      dependencies={{
        store: createPreferencesProfileStore(),
        connect: createServiceConnector(),
        policy: { allowInsecure: buildConfig.allowInsecure },
        defaultServiceAddress: buildConfig.defaultServiceAddress,
      }}
    />
  </StrictMode>,
);
