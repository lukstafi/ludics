// adapter-link.js — shared adapter-aware navigation link
// Included by all dashboard HTML pages to update the t3code/terminals nav link
// based on the active adapter mode (from data/adapter.json).
(async function updateAdapterLink() {
    try {
        const resp = await fetch('data/adapter.json');
        if (!resp.ok) return;
        const data = await resp.json();
        const link = document.getElementById('t3code-link');
        if (!link) return;
        if (data.adapter === 'tmux') {
            link.textContent = 'Terminals';
            link.href = 'terminals.html';
            link.title = 'Agent terminals (tmux+ttyd)';
            link.style.opacity = '';
        } else if (data.t3codeAvailable && data.t3codeWebUrl) {
            link.href = data.t3codeWebUrl;
            link.title = 't3code Web client';
            link.style.opacity = '';
        } else {
            link.style.opacity = '0.4';
            link.title = 't3code not available';
        }
    } catch { /* ignore */ }
})();
