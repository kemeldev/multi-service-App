const runtime = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};
export const PY_API   = runtime.pyApi   ?? import.meta.env.VITE_PY_API   ?? '/api/py';
export const NODE_API = runtime.nodeApi ?? import.meta.env.VITE_NODE_API ?? '/api/node';
export const POLL_MS  = Number(runtime.pollMs ?? import.meta.env.VITE_POLL_MS ?? 5000);
