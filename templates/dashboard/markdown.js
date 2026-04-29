// markdown.js -- Markdown-to-HTML for dashboard pages.
// Pipes vendored marked through vendored DOMPurify so dangerous HTML
// in MD source cannot reach innerHTML. Exposes window.markdownToHtml
// and window.escapeHtml so existing call sites in dashboard.js and
// the page templates need no API change beyond loading this file as
// an ES module.

import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";

// FORBID_ATTR: ["style"] closes the inline-style spoofing vector
// (e.g. <div style="position:fixed;...">). DOMPurify default strips
// <style> tags but leaves the style attribute intact; without this,
// untrusted MD could hide controls or overlay the page via inline
// CSS. FORBID_TAGS: ["style"] is belt-and-braces (already default).
const PURIFY_CONFIG = { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] };

window.markdownToHtml = (md) =>
    DOMPurify.sanitize(marked.parse(md ?? "", { gfm: true }), PURIFY_CONFIG);

window.escapeHtml = (str) => {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
};
