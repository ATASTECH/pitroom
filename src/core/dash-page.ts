// The HTML shell `pitroom dash` serves. The page itself is the React app in ui/, bundled by
// scripts/build.mjs into dist/ui/ (app.js, app.css). One tiny inline script sets the theme before the
// first paint; its hash is in the Content-Security-Policy, so nothing else may run inline.
export const THEME_SCRIPT = "(function(){try{var t=localStorage.getItem('pitroom-theme');var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){}})()";

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23ff6a2b'/%3E%3Cpath d='M9 8h4v4H9zm8 0h4v4h-4zm-4 4h4v4h-4zm8 0h4v4h-4zM9 16h4v4H9zm8 0h4v4h-4zm-4 4h4v4h-4zm8 0h4v4h-4z' fill='%23fff'/%3E%3C/svg%3E";

export const PAGE = `<!doctype html>
<html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>Pitroom</title><link rel="icon" href="${ICON}">
<script>${THEME_SCRIPT}</script><link rel="stylesheet" href="/assets/app.css"></head>
<body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;

/** Shown when the package was built without the dashboard files (running from source without a build). */
export const MISSING = `<!doctype html><meta charset="utf-8"><title>Pitroom</title><body style="font:15px system-ui;padding:3rem;max-width:40rem;margin:auto"><h1>Pitroom dash</h1><p>The dashboard files are missing (dist/ui). Run <code>npm run build</code> in the Pitroom repository, or reinstall the package.</p></body>`;
