# Proposal: Embed ntfy.sh app in dashboard iframe tab

**Task:** gh-ludics-52
**Effort:** small
**Files changed:** 6 modified, 1 new

## Changes

### New: `templates/dashboard/ntfy.html`
Full-viewport iframe page embedding the ntfy.sh web app, same pattern as `terminal.html`. Fetches URL from `data/ntfy.json`.

### Modified: `src/dashboard.ts`
Added `generateNtfy()` — reads `config.notifications.app_url` (default `https://ntfy.sh/app`), writes `ntfy.json`.

### Modified: nav bars (4 files)
Added "ntfy" link to `index.html`, `terminal.html`, `tasks.html`, `briefing.html`. Nav order: Dashboard | Terminal | t3code | ntfy | Tasks | Briefing.

### Modified: `templates/harness/config.yaml`
Added commented-out `app_url` option under `notifications:`.

## Activation
```bash
ludics dashboard install && ludics dashboard generate
```
