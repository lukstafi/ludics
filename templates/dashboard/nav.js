// Shared navigation + theme management — runs on every dashboard page
(function () {
    // ── Theme Management ─────────────────────────────────────
    const THEME_KEY = 'ludics-theme';
    const THEMES = ['night', 'day', 'oled'];

    function getStoredTheme() {
        try { return localStorage.getItem(THEME_KEY) || 'night'; } catch { return 'night'; }
    }

    function setTheme(theme) {
        if (!THEMES.includes(theme)) theme = 'night';
        document.documentElement.dataset.theme = theme;
        try { localStorage.setItem(THEME_KEY, theme); } catch { /* storage unavailable */ }
        // Update active state on theme buttons
        document.querySelectorAll('.theme-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.dataset.themeSet === theme);
        });
    }

    // Apply theme immediately to avoid flash
    setTheme(getStoredTheme());

    // ── Navigation ───────────────────────────────────────────
    const pages = [
        { href: 'index.html', label: 'Dashboard' },
        { href: 'mag.html', label: 'Mag' },
        { href: '#', label: 't3code', id: 't3code-link' },
        { href: 'terminals.html', label: 'Terminals' },
        { href: 'ntfy.html', label: 'ntfy' },
        { href: 'tasks.html', label: 'Tasks' },
        { href: 'task-creator.html', label: 'New Task' },
        { href: 'briefing.html', label: 'Briefing' },
        { href: 'health.html', label: 'Health' },
    ];
    var current = window.location.pathname.split('/').pop() || 'index.html';
    var nav = document.querySelector('.nav-links');
    if (!nav) return;

    // Keep the h1, replace everything else
    var h1 = nav.querySelector('h1');
    nav.innerHTML = '';
    if (h1) nav.appendChild(h1);
    for (var i = 0; i < pages.length; i++) {
        var p = pages[i];
        var a = document.createElement('a');
        a.href = p.href;
        a.textContent = p.label;
        if (p.id) a.id = p.id;
        if (current === p.href) a.className = 'active';
        nav.appendChild(a);
    }

    // ── Theme Switcher (inject into status bar) ──────────────
    var statusBar = document.querySelector('.status-bar');
    if (statusBar) {
        var switcher = document.createElement('div');
        switcher.className = 'theme-switcher';
        var currentTheme = getStoredTheme();
        for (var t = 0; t < THEMES.length; t++) {
            var btn = document.createElement('button');
            btn.className = 'theme-btn' + (THEMES[t] === currentTheme ? ' active' : '');
            btn.dataset.themeSet = THEMES[t];
            btn.title = THEMES[t].charAt(0).toUpperCase() + THEMES[t].slice(1) + ' theme';
            btn.textContent = THEMES[t] === 'night' ? 'Night' : THEMES[t] === 'day' ? 'Day' : 'OLED';
            btn.addEventListener('click', (function (theme) {
                return function () { setTheme(theme); };
            })(THEMES[t]));
            switcher.appendChild(btn);
        }
        statusBar.insertBefore(switcher, statusBar.firstChild);
    }

    // ── Role Switcher (task-b43bd578) ────────────────────────
    // Inject the provider-role toggle to the LEFT of the theme switcher.
    // Source of truth is server-rendered data/orchestration-defaults.json,
    // NOT localStorage — the auto-fill code reads the same config keys, so
    // localStorage would diverge from the path the slot-start code uses.
    if (statusBar && switcher) {
        import('./role-switcher.js').then(function (mod) {
            return fetch('data/orchestration-defaults.json').then(function (r) {
                return r.ok ? r.json() : null;
            }).then(function (data) {
                if (!data) return;
                var initialState = mod.fromWireBody(data);
                var roleSwitcher = mod.createRoleSwitcherElement(initialState, function (newState) {
                    return fetch('/api/orchestration-defaults', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(newState),
                    }).then(function (resp) {
                        if (!resp.ok) {
                            return resp.json().catch(function () { return { error: 'HTTP ' + resp.status }; })
                                .then(function (e) { throw new Error(e.error || ('HTTP ' + resp.status)); });
                        }
                        return resp.json();
                    });
                });
                statusBar.insertBefore(roleSwitcher, switcher);
            });
        }).catch(function (e) {
            console.warn('ludics: role-switcher injection skipped:', e);
        });
    }

    // ── t3code Link Status ───────────────────────────────────
    var dataPath = 'data/';
    fetch(dataPath + 't3code.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
            if (!data) return;
            var link = document.getElementById('t3code-link');
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
        .catch(function () { /* ignore */ });
})();
