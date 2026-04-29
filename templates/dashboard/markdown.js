// markdown.js -- Markdown-to-HTML for dashboard pages.
// Pipes vendored marked through vendored DOMPurify so dangerous HTML
// in MD source cannot reach innerHTML. Exposes window.markdownToHtml
// and window.escapeHtml so existing call sites in dashboard.js and
// the page templates need no API change beyond loading this file as
// an ES module.

import { marked } from "./vendor/marked.esm.js";
import DOMPurify from "./vendor/purify.es.js";

window.markdownToHtml = (md) =>
    DOMPurify.sanitize(marked.parse(md ?? "", { gfm: true }));

window.escapeHtml = (str) => {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
};
