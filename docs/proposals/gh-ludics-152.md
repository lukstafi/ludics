# Dashboard: add Health tab with health report and ludics doctor output

## Goal

Add a Health tab to the dashboard that surfaces two pieces of operational information currently only accessible via the terminal:
1. The periodic health report (`mag/health-report.md`), rendered as markdown.
2. Cached output of `ludics doctor` (system diagnostics), rendered as preformatted text.

This follows the same pattern as the existing Briefing tab: a template HTML page that fetches a JSON data file and renders its contents.

Ref: https://github.com/lukstafi/ludics/issues/152

## Acceptance Criteria

1. A new `templates/dashboard/health.html` file exists, following the same structure as `briefing.html`. It fetches `data/health.json` and renders two sections: a markdown health report and a preformatted doctor output block.
2. `nav.js` includes a `{ href: 'health.html', label: 'Health' }` entry in the `pages` array, so the Health tab appears in the navigation bar on all dashboard pages.
3. `dashboard.ts` contains a `generateHealthData()` function that:
   - Reads `mag/health-report.md` from the harness directory. If the file does not exist, returns `{ exists: false }` for that section (same pattern as `generateBriefing()`).
   - Runs `ludics doctor` as a subprocess via `Bun.spawnSync` (using `process.execPath` with `["doctor"]` args), captures stdout, and includes a timeout (e.g., 10 seconds) to prevent hangs.
   - Caches the doctor subprocess output with a TTL of ~300 seconds, so repeated `dashboardGenerate()` calls within 5 minutes reuse the cached result.
   - Returns a JSON shape: `{ healthReport: { exists: boolean, content: string, date: string|null }, doctor: { output: string, timestamp: string } }`.
4. `dashboardGenerate()` writes `data/health.json` using the output of `generateHealthData()`, alongside the other JSON files.
5. When `mag/health-report.md` does not exist, the health report section shows a placeholder message (e.g., "No health report available yet").
6. When the doctor subprocess fails or times out, the doctor section shows a fallback message (e.g., "Doctor check failed") rather than crashing.
7. `dashboardInstall()` requires no changes -- it already copies all files recursively from the templates directory.
8. The health report section reuses the existing `markdown.js` `markdownToHtml()` function for rendering.

## Context

**Closest analogue**: `templates/dashboard/briefing.html` + `generateBriefing()` in `src/dashboard.ts` (line 936-948). The Health tab is structurally almost identical, but with two content sections instead of one.

**Navigation**: `templates/dashboard/nav.js` (line 3-11) defines the `pages` array. Adding one entry is sufficient -- the nav script dynamically builds the header on all pages.

**Data generation**: `dashboardGenerate()` in `src/dashboard.ts` (line 952-1002) writes all JSON files. The health JSON should be added after the existing entries.

**Doctor function**: `magDoctor()` in `src/mag.ts` (line 2784+) writes to `console.log` and calls `process.exit(1)` on failure. Spawning as a subprocess avoids the exit call and captures output cleanly. Pattern: `Bun.spawnSync([process.execPath, "doctor"], { stdout: "pipe", stderr: "pipe" })`.

**Health report format**: `mag/health-report.md` has a date header pattern `# Health Check - 2026-04-04 07:57` -- extract the timestamp similarly to how `generateBriefing()` extracts the briefing date.

**Install**: `dashboardInstall()` (line 1031+) uses recursive directory copy (`copyDir`), so any new file in `templates/dashboard/` is automatically included.

## Approach

*Suggested approach -- agents may deviate if they find a better path.*

### A. Create `templates/dashboard/health.html`

Clone `briefing.html` and adapt:
- Title: "ludics Health"
- Two content sections in main: `#health-report` (markdown, uses `markdownToHtml`) and `#doctor-output` (`<pre>` block)
- CSS classes: reuse `.briefing-content` styles (rename to generic or duplicate as `.health-content`), add `.doctor-output` with monospace/pre styling
- Fetch `data/health.json`, render both sections
- Placeholder states for each section independently (health report may exist while doctor fails, or vice versa)

### B. Update `templates/dashboard/nav.js`

Add one entry to the `pages` array:
```js
{ href: 'health.html', label: 'Health' },
```
Place it after the Briefing entry (last position is fine).

### C. Add `generateHealthData()` to `src/dashboard.ts`

```ts
// Module-level cache for doctor output
let doctorCache: { output: string; timestamp: string; cachedAt: number } | null = null;
const DOCTOR_CACHE_TTL = 300_000; // 5 minutes

function generateHealthData(): Record<string, unknown> {
  // Health report
  const reportFile = join(harnessDir(), "mag", "health-report.md");
  let healthReport: Record<string, unknown>;
  if (existsSync(reportFile)) {
    const content = readFileSync(reportFile, "utf-8");
    let date: string | null = null;
    const dateMatch = content.match(/^# Health Check - (.+)$/m);
    if (dateMatch) date = dateMatch[1]!;
    healthReport = { exists: true, content, date };
  } else {
    healthReport = { exists: false, content: "", date: null };
  }

  // Doctor output (cached)
  const now = Date.now();
  if (!doctorCache || now - doctorCache.cachedAt > DOCTOR_CACHE_TTL) {
    try {
      const result = Bun.spawnSync([process.execPath, "doctor"], {
        stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      doctorCache = {
        output: result.stdout.toString(),
        timestamp: new Date().toISOString(),
        cachedAt: now,
      };
    } catch {
      doctorCache = {
        output: "Doctor check failed",
        timestamp: new Date().toISOString(),
        cachedAt: now,
      };
    }
  }

  return { healthReport, doctor: { output: doctorCache.output, timestamp: doctorCache.timestamp } };
}
```

### D. Add to `dashboardGenerate()`

After the briefing.json write (line 984-985), add:
```ts
writeFileSync(join(dataDir, "health.json"), JSON.stringify(generateHealthData(), null, 2));
console.error("  health.json");
```

## Scope

**In scope:**
- 1 new template file (`health.html`)
- 2 existing file edits (`nav.js`, `dashboard.ts`)

**Out of scope:**
- Changes to `magDoctor()` itself (no refactoring to make it return a string)
- Changes to `dashboard-server.ts` (static serving already handles new JSON files)
- Changes to `dashboardInstall()` (recursive copy already handles new files)
- Health report generation logic (separate trigger concern)
