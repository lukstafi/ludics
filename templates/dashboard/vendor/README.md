# Vendored browser libraries

Files in this directory are statically served to the dashboard at
http://localhost:7678/ and copied verbatim by `dashboardInstall` in
`src/dashboard.ts` to `~/self-improve/harness/dashboard/vendor/`.

## marked.esm.js

- **Package**: marked
- **Version**: 18.0.2
- **License**: MIT (header preserved at top of file)
- **Upstream**: https://github.com/markedjs/marked
- **Source**: copied from `node_modules/marked/lib/marked.esm.js`
  after `bun add marked`. Equivalent CDN URL for offline mirroring:
  https://cdn.jsdelivr.net/npm/marked@18.0.2/lib/marked.esm.js

## purify.es.js

- **Package**: dompurify
- **Version**: 3.4.3 (pinned transitively via `isomorphic-dompurify@3.10.0`)
- **License**: Apache-2.0 OR MPL-2.0 (header preserved at top of file)
- **Upstream**: https://github.com/cure53/DOMPurify
- **Source**: copied from `node_modules/dompurify/dist/purify.es.mjs`.
  Equivalent CDN URL:
  https://cdn.jsdelivr.net/npm/dompurify@3.4.3/dist/purify.es.mjs

## To bump

1. `bun add marked@latest isomorphic-dompurify@latest`.
2. `cp node_modules/marked/lib/marked.esm.js templates/dashboard/vendor/marked.esm.js`.
3. `cp node_modules/dompurify/dist/purify.es.mjs templates/dashboard/vendor/purify.es.js`.
4. Update the version numbers above to match.
5. Run `bun run lint:vendor-sync` to verify the vendored copies match
   the locked npm copies byte-for-byte. The lint refreshes
   `node_modules/` itself via `bun install --frozen-lockfile`, so it
   catches drift even on a stale checkout. CI runs the same lint, so
   any skew will fail loudly.
6. Re-run `bun test templates/dashboard/markdown.test.ts` to confirm
   the fixture set still passes against the new versions.

The npm-installed versions (used by the Bun-runnable test) and the
vendored copies (served to the browser) **must** stay in sync. The
test imports `marked` from npm and `isomorphic-dompurify` from npm,
which means a version skew between npm and vendored files would not
be caught by the test alone — `lint:vendor-sync` enforces alignment
in CI; the steps above keep it green.
