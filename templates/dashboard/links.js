// links.js -- centralized URL builders for dashboard task/proposal links
//
// Every client-side call site that emits a link to task.html or proposal.html
// routes through these helpers so the encoding choice (encodeURIComponent)
// and absolute-path shape live in one place. Server-side mirrors live in
// src/dashboard.ts (taskLink / proposalLink).
//
// Loaded as a classic <script> before dashboard.js / inline scripts that need
// the helpers. Top-level function declarations so callers don't have to
// plumb them through closures.

function taskLink(id) {
    return `/task.html?task=${encodeURIComponent(id)}`;
}

function proposalLink(id) {
    return `/proposal.html?task=${encodeURIComponent(id)}`;
}
