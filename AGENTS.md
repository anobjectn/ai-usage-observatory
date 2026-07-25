# Repository agent guidance

## Keep the local app running

Assume the user normally has AI Usage Observatory open in a local browser tab.

- Before starting or stopping a server, check whether the app is already reachable on the development port (`5173`) or production port (`4318`).
- Reuse a healthy running app. Do not restart it merely to run checks or pick up changes that hot reload can apply.
- Never use broad process-kill commands. If a process must be replaced, target only the process started for this repository.
- Prefer checks that do not stop the shared development server. Keep temporary test servers separate from it.
- At the end of implementation work, leave the app reachable. If it was running when work began, preserve it; if work or prior agent activity left it stopped, start `bun run dev` and leave it running unless the user explicitly asks otherwise.
- Report the final local URL and whether the app was preserved, restarted, or started.
