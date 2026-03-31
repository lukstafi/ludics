// Shared navigation — single source of truth for all dashboard pages
(function () {
    const pages = [
        { href: 'index.html', label: 'Dashboard' },
        { href: 'terminal.html', label: 'Mag' },
        { href: '#', label: 't3code', id: 't3code-link' },
        { href: 'terminals.html', label: 'Terminals' },
        { href: 'ntfy.html', label: 'ntfy' },
        { href: 'tasks.html', label: 'Tasks' },
        { href: 'briefing.html', label: 'Briefing' },
    ];
    const current = window.location.pathname.split('/').pop() || 'index.html';
    const nav = document.querySelector('.nav-links');
    if (!nav) return;
    // Keep the h1, replace everything else
    const h1 = nav.querySelector('h1');
    nav.innerHTML = '';
    if (h1) nav.appendChild(h1);
    for (const p of pages) {
        const a = document.createElement('a');
        a.href = p.href;
        a.textContent = p.label;
        if (p.id) a.id = p.id;
        if (current === p.href) a.className = 'active';
        nav.appendChild(a);
    }

    // Update t3code link from data — works on all pages
    const dataPath = 'data/';
    fetch(dataPath + 't3code.json')
        .then(r => r.ok ? r.json() : null)
        .then(data => {
            if (!data) return;
            const link = document.getElementById('t3code-link');
            if (!link) return;
            if (data.available && data.webUrl) {
                link.href = data.webUrl;
                link.title = 't3code Web client';
                link.style.opacity = '';
                link.style.pointerEvents = '';
            } else {
                link.style.opacity = '0.4';
                link.style.pointerEvents = 'none';
                link.title = 't3code server not running';
            }
        })
        .catch(() => { /* ignore */ });
})();
