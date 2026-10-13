const paths = {
  history: <><path d="M3 11a9 9 0 1 1 2 7M3 5v6h6M12 7v5l3 2" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 7.5-2" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  reset: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" /></>,
  undo: <><path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 7 7v4" /></>,
  redo: <><path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0-7 7v4" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01" /></>,
  adjust: <><path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10" /><circle cx="12" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8" cy="8" r="2" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
  split: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 2v20m-5-8-2-2 2-2m10 4 2-2-2-2" /></>,
  compare: <><rect x="3" y="4" width="7" height="16" rx="1" /><rect x="14" y="4" width="7" height="16" rx="1" /></>,
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 8l8 8m0-8-8 8" />,
  'zoom-in': <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6M6 10h8m-4-4v8" /></>,
  'zoom-out': <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6M6 10h8" /></>,
  pixels: <><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M12 4v16M4 12h16" /></>,
}

export default function ActionIcon({ name, className = '' }) {
  return <svg className={`action-icon ${className}`} width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {paths[name] || paths.more}
  </svg>
}
