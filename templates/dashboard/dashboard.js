/**
 * ludics Dashboard JavaScript
 *
 * This dashboard reads state from JSON files served by a simple HTTP server.
 * The ludics CLI generates these JSON files from the Markdown state files.
 *
 * To use:
 * 1. Run: ludics dashboard generate (creates dashboard/data/*.json)
 * 2. Serve: ludics dashboard serve
 * 3. Open: http://localhost:7678
 */

// Configuration
const CONFIG = {
    refreshInterval: 10000, // 10 seconds
    dataPath: 'data/',
    maxNotifications: 10,
    maxReadyTasks: 12
};

// State
let lastUpdate = null;
let queueHeld = false;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', () => {
    console.log('ludics dashboard initializing...');
    fetchAllData();
    setInterval(fetchAllData, CONFIG.refreshInterval);
});

// Refresh immediately when tab becomes visible again
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        fetchAllData();
    }
});

// Fetch all dashboard data
async function fetchAllData() {
    try {
        await Promise.all([
            fetchSlots(),
            fetchReadyQueue(),
            fetchNeedsConfirmation(),
            fetchUnansweredQuestions(),
            fetchQueueHoldState(),
            fetchNotifications(),
            fetchMagStatus(),
            fetchT3codeLink(),
            fetchRecentlyCompleted()
        ]);
        updateTimestamp();
        setConnectionStatus(true);
    } catch (error) {
        console.error('Failed to fetch data:', error);
        setConnectionStatus(false);
    }
}

// Fetch slot data
async function fetchSlots() {
    try {
        const response = await fetch(CONFIG.dataPath + 'slots.json');
        if (!response.ok) throw new Error('Failed to fetch slots');
        const slots = await response.json();
        renderSlots(slots);
    } catch (error) {
        // Use placeholder data if fetch fails
        console.warn('Using placeholder slot data');
        renderSlots(getPlaceholderSlots());
    }
}

// Render slot tiles
function renderSlots(slots) {
    for (let i = 1; i <= 6; i++) {
        const slot = slots.find(s => s.number === i) || { number: i, empty: true };
        const tile = document.getElementById(`slot-${i}`);
        if (!tile) continue;

        const statusDiv = tile.querySelector('.slot-status');
        const statusText = tile.querySelector('.status-text');
        const detailsDiv = tile.querySelector('.slot-details');
        const linksDiv = tile.querySelector('.slot-links');

        const hasTask = slot.task && slot.task !== 'null';
        const isProjectReserved = !slot.empty && slot.process && !hasTask;

        if (slot.empty || !slot.process) {
            statusDiv.className = 'slot-status empty';
            statusText.textContent = 'Empty';
            setHtmlPreserveScroll(detailsDiv, '');
            setHtmlPreserveScroll(linksDiv, '');
        } else {
            if (slot.phase === 'done') {
                statusDiv.className = 'slot-status done';
                statusText.innerHTML = 'Done <span class="slot-action-btns">'
                    + '<button class="slot-action-btn slot-done-btn" onclick="slotActionDone(' + i + ')" title="Mark done">✓</button>'
                    + '<button class="slot-action-btn slot-abandon-btn" onclick="slotActionAbandon(' + i + ')" title="Abandon">✕</button>'
                    + '</span>';
            } else if (slot.preempted) {
                statusDiv.className = 'slot-status preempted';
                statusText.textContent = 'Preempted';
            } else if (isProjectReserved) {
                statusDiv.className = 'slot-status reserved';
                statusText.textContent = 'Project';
            } else if (hasTask && !slot.phase) {
                statusDiv.className = 'slot-status assigned';
                statusText.innerHTML = 'Assigned <button class="start-slot-btn" onclick="startSlot(' + i + ')" title="Start session">start</button>'
                    + ' <span class="slot-action-btns">'
                    + '<button class="slot-action-btn slot-done-btn" onclick="slotActionDone(' + i + ')" title="Mark done">✓</button>'
                    + '<button class="slot-action-btn slot-abandon-btn" onclick="slotActionAbandon(' + i + ')" title="Abandon">✕</button>'
                    + '<button class="slot-action-btn slot-postpone-btn" onclick="slotActionPostpone(' + i + ')" title="Postpone (decrease priority)">↓</button>'
                    + '</span>';
            } else if (slot.liveness === 'interrupted') {
                statusDiv.className = 'slot-status interrupted';
                statusText.innerHTML = 'Interrupted <button class="start-slot-btn" onclick="resumeSlot(' + i + ')" title="Resume session">resume</button>'
                    + ' <span class="slot-action-btns">'
                    + '<button class="slot-action-btn slot-done-btn" onclick="slotActionDone(' + i + ')" title="Mark done">✓</button>'
                    + '<button class="slot-action-btn slot-abandon-btn" onclick="slotActionAbandon(' + i + ')" title="Abandon">✕</button>'
                    + '<button class="slot-action-btn slot-postpone-btn" onclick="slotActionPostpone(' + i + ')" title="Postpone (decrease priority)">↓</button>'
                    + '</span>';
            } else {
                statusDiv.className = 'slot-status active';
                statusText.innerHTML = 'Active <span class="slot-action-btns">'
                    + '<button class="slot-action-btn slot-done-btn" onclick="slotActionDone(' + i + ')" title="Mark done">✓</button>'
                    + '<button class="slot-action-btn slot-abandon-btn" onclick="slotActionAbandon(' + i + ')" title="Abandon">✕</button>'
                    + '<button class="slot-action-btn slot-postpone-btn" onclick="slotActionPostpone(' + i + ')" title="Postpone (decrease priority)">↓</button>'
                    + '</span>';
            }

            let html = `<p class="process" title="${escapeHtml(slot.process)}">${escapeHtml(slot.process)}</p>`;
            const meta = [];
            if (hasTask) meta.push(`<span class="task-id">${escapeHtml(slot.task)}</span>`);
            if (slot.effort) meta.push(`<span class="effort" data-effort="${escapeHtml(slot.effort)}">${escapeHtml(slot.effort)}</span>`);
            if (slot.mode) {
                // Only allow toggling when no session is actively running.
                // slotStart() stamps slot.sessionStarted for all adapters (manual included),
                // and slotStop() clears it. The phase fallback was removed because phase
                // text written by slotsRefresh() is never cleared by slotStop(), which
                // would permanently block the toggle after a session ends.
                const isToggleable = (slot.mode === 'manual' || slot.mode === 't3code')
                    && !slot.sessionStarted;
                if (isToggleable) {
                    const otherMode = slot.mode === 'manual' ? 't3code' : 'manual';
                    meta.push(`<button class="mode-toggle-btn mode-${escapeHtml(slot.mode)}" onclick="toggleSlotMode(${i}, '${otherMode}')" title="Mode: ${escapeHtml(slot.mode)} — click to switch to ${otherMode}">${escapeHtml(slot.mode)}</button>`);
                } else {
                    meta.push(escapeHtml(slot.mode));
                }
            }
            if (slot.started) meta.push(formatTime(slot.started));
            if (meta.length > 0) html += `<p class="slot-meta">${meta.join(' · ')}</p>`;
            if (slot.phase) {
                let phaseText = escapeHtml(slot.phase);
                if (slot.round != null && slot.round > 0) phaseText += ` (round ${slot.round})`;
                html += `<p class="phase"><span class="label">Phase:</span> ${phaseText}</p>`;
            }
            if (slot.preempted && slot.preemptedTask) {
                html += `<p class="preempted-notice">Stashed: <span class="task-id">${escapeHtml(slot.preemptedTask)}</span></p>`;
            }
            if (slot.taskContent) {
                html += `<div class="task-content">${markdownToHtml(slot.taskContent)}</div>`;
            }

            setHtmlPreserveScroll(detailsDiv, html, '.task-content');

            // Build contextual links section
            let links = '';
            // GitHub issue link — only render valid HTTP/HTTPS URLs
            if (slot.githubUrl && (slot.githubUrl.startsWith('http://') || slot.githubUrl.startsWith('https://'))) {
                links += `<a href="${escapeHtml(slot.githubUrl)}" target="_blank" class="link-issue">issue</a>`;
            }
            // PR link — only render valid HTTP/HTTPS URLs
            if (slot.prUrl && (slot.prUrl.startsWith('http://') || slot.prUrl.startsWith('https://'))) {
                links += `<a href="${escapeHtml(slot.prUrl)}" target="_blank" class="link-pr">PR</a>`;
            }
            // Proposal link
            if (slot.proposalLink) {
                links += `<a href="${slot.proposalLink}" class="link-proposal">proposal</a>`;
            }
            // t3code thread links — only render valid HTTP/HTTPS URLs
            if (slot.t3codeThreadLinks) {
                for (const [name, url] of Object.entries(slot.t3codeThreadLinks)) {
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        links += `<a href="${escapeHtml(url)}" target="_blank" class="link-t3code">${escapeHtml(name)}</a>`;
                    }
                }
            }
            // Terminal links — only render valid HTTP/HTTPS URLs as clickable links
            if (slot.terminals) {
                for (const [name, url] of Object.entries(slot.terminals)) {
                    const label = escapeHtml(name.replace(/_/g, ' '));
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        links += `<a href="${escapeHtml(url)}" target="_blank">${label}</a>`;
                    } else {
                        links += `<span class="terminal-label">${label}</span>`;
                    }
                }
            }
            setHtmlPreserveScroll(linksDiv, links);
        }
    }
}

// Fetch ready queue
async function fetchReadyQueue() {
    try {
        const response = await fetch(CONFIG.dataPath + 'ready.json');
        if (!response.ok) throw new Error('Failed to fetch ready queue');
        const tasks = await response.json();
        renderReadyQueue(tasks);
    } catch (error) {
        console.warn('Using placeholder ready queue');
        renderReadyQueue([]);
    }
}

// Render ready queue
function renderReadyQueue(tasks) {
    const list = document.getElementById('ready-list');
    if (!list) return;

    let newHtml;
    if (tasks.length === 0) {
        newHtml = '<li class="empty">No ready tasks</li>';
    } else {
        const items = tasks.slice(0, CONFIG.maxReadyTasks).map(task => {
            const priority = task.priority || '-';
            const priorityClass = `priority-${priority}`;
            const effortBadge = task.effort
                ? `<span class="effort" data-effort="${escapeHtml(task.effort)}">${escapeHtml(task.effort)}</span>`
                : '';
            return `
            <li class="ready-task-item" onclick="promoteTask('${escapeHtml(task.id)}')" title="Click to promote priority">
                <span class="priority ${priorityClass}">${escapeHtml(priority)}</span>
                <span class="task-title">${escapeHtml(task.title || task.id)}</span>
                ${effortBadge}
            </li>
        `;
        });
        newHtml = items.join('');
    }

    if (list.innerHTML !== newHtml) {
        const scrollTop = list.scrollTop;
        list.innerHTML = newHtml;
        list.scrollTop = scrollTop;
    }
}

// Fetch notifications
async function fetchNotifications() {
    try {
        const response = await fetch(CONFIG.dataPath + 'notifications.json');
        if (!response.ok) throw new Error('Failed to fetch notifications');
        const notifications = await response.json();
        renderNotifications(notifications);
    } catch (error) {
        console.warn('Using placeholder notifications');
        renderNotifications([]);
    }
}

// Render notifications
function renderNotifications(notifications) {
    const list = document.getElementById('notifications-list');
    if (!list) return;

    let newHtml;
    if (notifications.length === 0) {
        newHtml = '<li class="empty">No recent notifications</li>';
    } else {
        const items = notifications.slice(0, CONFIG.maxNotifications).map(notif => {
            const time = formatTime(notif.timestamp);
            return `
            <li>
                <span class="notif-time">${time}</span>
                <span class="notif-msg">${escapeHtml(notif.message)}</span>
            </li>
        `;
        });
        newHtml = items.join('');
    }

    if (list.innerHTML !== newHtml) {
        const scrollTop = list.scrollTop;
        list.innerHTML = newHtml;
        list.scrollTop = scrollTop;
    }
}

// Fetch Mag status
async function fetchMagStatus() {
    try {
        const response = await fetch(CONFIG.dataPath + 'mag.json');
        if (!response.ok) throw new Error('Failed to fetch mag status');
        const mag = await response.json();
        renderMagStatus(mag);
    } catch (error) {
        console.warn('Using placeholder mag status');
        renderMagStatus({ status: 'unknown', lastActivity: null });
    }
}

// Render Mag status
function renderMagStatus(mag) {
    const statusSpan = document.getElementById('mag-status');
    const activitySpan = document.getElementById('mag-activity');
    const terminalLink = document.getElementById('mag-terminal');

    if (statusSpan) {
        statusSpan.textContent = mag.status || 'Unknown';
        if (mag.status === 'running') {
            statusSpan.style.color = 'var(--success)';
        } else {
            statusSpan.style.color = 'var(--text-secondary)';
        }
    }

    if (activitySpan) {
        activitySpan.textContent = mag.lastActivity
            ? formatTime(mag.lastActivity)
            : '--';
    }

    if (terminalLink && mag.terminal) {
        terminalLink.href = mag.terminal;
        terminalLink.style.display = 'inline';
    }
}

// Update last update timestamp
function updateTimestamp() {
    lastUpdate = new Date();
    const el = document.getElementById('last-update');
    if (el) {
        el.textContent = `Last update: ${formatTime(lastUpdate.toISOString())}`;
    }
}

// Set connection status indicator
function setConnectionStatus(connected) {
    const el = document.getElementById('connection-status');
    if (el) {
        el.className = connected ? 'connected' : 'disconnected';
        el.textContent = connected ? 'Connected' : 'Disconnected';
    }
}

// Helper: set innerHTML only if changed, preserving scroll of scrollable descendants
function setHtmlPreserveScroll(element, newHtml, ...scrollableSelectors) {
    if (element.innerHTML === newHtml) return;
    const saved = [];
    for (const sel of scrollableSelectors) {
        const el = element.querySelector(sel);
        if (el) saved.push({ sel, scrollTop: el.scrollTop });
    }
    const ownScrollTop = element.scrollTop;
    element.innerHTML = newHtml;
    element.scrollTop = ownScrollTop;
    for (const { sel, scrollTop } of saved) {
        const el = element.querySelector(sel);
        if (el) el.scrollTop = scrollTop;
    }
}

// Utility: Format timestamp
function formatTime(isoString) {
    if (!isoString) return '--';
    try {
        const date = new Date(isoString);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return isoString;
    }
}

// Fetch t3code link status (t3code is always available for manual use)
async function fetchT3codeLink() {
    try {
        const response = await fetch(CONFIG.dataPath + 't3code.json');
        if (!response.ok) return;
        const data = await response.json();
        const link = document.getElementById('t3code-link');
        if (!link) return;
        if (data.available && data.webUrl) {
            link.href = data.webUrl;
            link.title = 't3code Web client';
            link.style.opacity = '';
            link.style.pointerEvents = '';
            link.textContent = link.textContent.replace(' (starting…)', '');
        } else if (data.starting && data.webUrl) {
            link.href = data.webUrl;
            link.title = 't3code server is starting up…';
            link.style.opacity = '0.6';
            link.style.pointerEvents = 'none';
            if (!link.textContent.includes('(starting…)')) {
                link.textContent = link.textContent + ' (starting…)';
            }
        } else {
            link.style.opacity = '0.4';
            link.style.pointerEvents = 'none';
            link.title = 't3code server not running';
            link.textContent = link.textContent.replace(' (starting…)', '');
        }
    } catch { /* ignore */ }
}

// Slot action: mark done (✓)
async function slotActionDone(slotNum) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '…';
    try {
        const response = await fetch(`/api/slot-clear?slot=${slotNum}&status=done`);
        if (response.ok) {
            fetchAllData();
        } else {
            btn.textContent = '✓';
            setTimeout(() => { btn.disabled = false; }, 2000);
        }
    } catch {
        btn.textContent = '✓';
        setTimeout(() => { btn.disabled = false; }, 2000);
    }
}

// Slot action: abandon (✕)
async function slotActionAbandon(slotNum) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '…';
    try {
        const response = await fetch(`/api/slot-clear?slot=${slotNum}&status=abandoned`);
        if (response.ok) {
            fetchAllData();
        } else {
            btn.textContent = '✕';
            setTimeout(() => { btn.disabled = false; }, 2000);
        }
    } catch {
        btn.textContent = '✕';
        setTimeout(() => { btn.disabled = false; }, 2000);
    }
}

// Slot action: postpone (↓) — decrease task priority + clear slot as ready
async function slotActionPostpone(slotNum) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '…';
    try {
        const response = await fetch(`/api/slot-postpone?slot=${slotNum}`);
        if (response.ok) {
            fetchAllData();
        } else {
            btn.textContent = '↓';
            setTimeout(() => { btn.disabled = false; }, 2000);
        }
    } catch {
        btn.textContent = '↓';
        setTimeout(() => { btn.disabled = false; }, 2000);
    }
}

// Promote a ready queue task's priority one level (C→B→A→S)
async function promoteTask(taskId) {
    const li = event.currentTarget;
    if (li.classList.contains('promoting')) return;
    li.classList.add('promoting');
    try {
        const response = await fetch(`/api/task-promote?task=${encodeURIComponent(taskId)}`);
        if (response.ok) {
            const data = await response.json();
            // Update priority badge immediately
            const prioritySpan = li.querySelector('.priority');
            if (prioritySpan && data.priority) {
                prioritySpan.textContent = data.priority;
                prioritySpan.className = `priority priority-${data.priority}`;
            }
            li.classList.add('promoted');
            setTimeout(() => {
                li.classList.remove('promoted');
                fetchAllData();
            }, 800);
        } else {
            li.classList.add('promote-error');
            setTimeout(() => li.classList.remove('promote-error'), 1500);
        }
    } catch {
        li.classList.add('promote-error');
        setTimeout(() => li.classList.remove('promote-error'), 1500);
    } finally {
        setTimeout(() => li.classList.remove('promoting'), 300);
    }
}

// Fetch needs-confirmation tasks
async function fetchNeedsConfirmation() {
    try {
        const response = await fetch(CONFIG.dataPath + 'needs-confirmation.json');
        if (!response.ok) throw new Error('Failed to fetch needs-confirmation');
        const tasks = await response.json();
        renderNeedsConfirmation(tasks);
    } catch (error) {
        console.warn('Using placeholder needs-confirmation');
        renderNeedsConfirmation([]);
    }
}

// Render needs-confirmation tasks
function renderNeedsConfirmation(tasks) {
    const list = document.getElementById('needs-confirmation-list');
    if (!list) return;

    let newHtml;
    if (tasks.length === 0) {
        newHtml = '<li class="empty">No tasks need confirmation</li>';
    } else {
        const items = tasks.map(task => {
            const priority = task.priority || '-';
            const priorityClass = `priority-${priority}`;
            const source = task.relatesTo?.length ? ` (from ${escapeHtml(task.relatesTo[0])})` : '';
            return `
            <li class="needs-confirm-item">
                <span class="priority ${priorityClass}">${escapeHtml(priority)}</span>
                <a class="task-title needs-confirm-link" href="task-files/${escapeHtml(task.id)}.md" target="_blank">${escapeHtml(task.title || task.id)}</a>${source}
                <span class="confirm-actions">
                    <button class="confirm-btn" onclick="confirmTask('${escapeHtml(task.id)}')" title="Confirm: move to ready">&#x2713;</button>
                    <button class="dismiss-btn" onclick="dismissTask('${escapeHtml(task.id)}')" title="Dismiss: abandon">&#x2715;</button>
                </span>
            </li>`;
        });
        newHtml = items.join('');
    }

    if (list.innerHTML !== newHtml) {
        list.innerHTML = newHtml;
    }
}

// Fetch unanswered-questions tasks
async function fetchUnansweredQuestions() {
    try {
        const response = await fetch(CONFIG.dataPath + 'unanswered-questions.json');
        if (!response.ok) throw new Error('Failed to fetch unanswered-questions');
        const tasks = await response.json();
        renderUnansweredQuestions(tasks);
    } catch (error) {
        console.warn('Using placeholder unanswered-questions');
        renderUnansweredQuestions([]);
    }
}

// Render unanswered-questions tasks
function renderUnansweredQuestions(tasks) {
    const list = document.getElementById('unanswered-questions-list');
    if (!list) return;

    let newHtml;
    if (tasks.length === 0) {
        newHtml = '<li class="empty">No unanswered questions</li>';
    } else {
        const items = tasks.map(task => {
            const priority = task.priority || '-';
            const priorityClass = `priority-${priority}`;
            return `
            <li class="unanswered-q-item">
                <span class="priority ${priorityClass}">${escapeHtml(priority)}</span>
                <a class="task-title unanswered-q-link" href="task-files/${escapeHtml(task.id)}.md" target="_blank">${escapeHtml(task.title || task.id)}</a>
            </li>`;
        });
        newHtml = items.join('');
    }

    if (list.innerHTML !== newHtml) {
        list.innerHTML = newHtml;
    }
}

// Confirm a needs-confirmation task (move to ready)
async function confirmTask(taskId) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '\u2026';
    try {
        const response = await fetch(`/api/task-confirm?task=${encodeURIComponent(taskId)}`);
        if (response.ok) {
            fetchAllData();
        } else {
            btn.textContent = '\u2713';
            setTimeout(() => { btn.disabled = false; }, 2000);
        }
    } catch {
        btn.textContent = '\u2713';
        setTimeout(() => { btn.disabled = false; }, 2000);
    }
}

// Dismiss a needs-confirmation task (move to abandoned)
async function dismissTask(taskId) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '\u2026';
    try {
        const response = await fetch(`/api/task-dismiss?task=${encodeURIComponent(taskId)}`);
        if (response.ok) {
            fetchAllData();
        } else {
            btn.textContent = '\u2715';
            setTimeout(() => { btn.disabled = false; }, 2000);
        }
    } catch {
        btn.textContent = '\u2715';
        setTimeout(() => { btn.disabled = false; }, 2000);
    }
}

// Start a slot session via CLI command
async function startSlot(slotNum) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '...';
    try {
        const response = await fetch(`/api/slot-start?slot=${slotNum}`);
        if (response.ok) {
            btn.textContent = 'started';
            fetchAllData(); // refresh
        } else {
            const msg = await response.text();
            btn.textContent = 'error';
            console.error('slot start failed:', msg);
            setTimeout(() => { btn.textContent = 'start'; btn.disabled = false; }, 3000);
        }
    } catch {
        btn.textContent = 'error';
        setTimeout(() => { btn.textContent = 'start'; btn.disabled = false; }, 3000);
    }
}

// Resume an interrupted slot session
async function resumeSlot(slotNum) {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = '...';
    try {
        const response = await fetch(`/api/slot-resume?slot=${slotNum}`);
        if (response.ok) {
            btn.textContent = 'resumed';
            fetchAllData();
        } else {
            const msg = await response.text();
            btn.textContent = 'error';
            console.error('slot resume failed:', msg);
            setTimeout(() => { btn.textContent = 'resume'; btn.disabled = false; }, 3000);
        }
    } catch {
        btn.textContent = 'error';
        setTimeout(() => { btn.textContent = 'resume'; btn.disabled = false; }, 3000);
    }
}

// Toggle slot mode between manual and t3code
async function toggleSlotMode(slotNum, mode) {
    const btn = event.target;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = '...';
    try {
        const response = await fetch(`/api/slot-mode?slot=${slotNum}&mode=${encodeURIComponent(mode)}`);
        if (response.ok) {
            fetchAllData(); // refresh
        } else {
            const msg = await response.text();
            btn.textContent = 'error';
            console.error('slot mode toggle failed:', msg);
            setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
        }
    } catch {
        btn.textContent = 'error';
        setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    }
}

// Fetch queue hold state and update UI
async function fetchQueueHoldState() {
    try {
        const response = await fetch('/api/queue-hold-state');
        if (!response.ok) return;
        const data = await response.json();
        queueHeld = data.held;
        updateQueueHoldUI();
    } catch { /* ignore */ }
}

// Update hold button and badge to reflect current queueHeld state
function updateQueueHoldUI() {
    const btn = document.getElementById('queue-hold-btn');
    const badge = document.getElementById('queue-held-badge');
    if (btn) {
        btn.textContent = queueHeld ? 'Resume' : 'Hold';
        if (queueHeld) {
            btn.classList.add('held');
        } else {
            btn.classList.remove('held');
        }
    }
    if (badge) {
        if (queueHeld) {
            badge.classList.add('visible');
        } else {
            badge.classList.remove('visible');
        }
    }
}

// Toggle the queue hold state via API
async function toggleQueueHold() {
    const btn = document.getElementById('queue-hold-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '...';
    }
    const newState = !queueHeld;
    try {
        const response = await fetch(`/api/queue-hold?state=${newState}`);
        if (response.ok) {
            queueHeld = newState;
            updateQueueHoldUI();
        } else {
            // restore button text on failure
            if (btn) btn.textContent = queueHeld ? 'Resume' : 'Hold';
        }
    } catch {
        if (btn) btn.textContent = queueHeld ? 'Resume' : 'Hold';
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Fetch recently completed tasks
async function fetchRecentlyCompleted() {
    try {
        const response = await fetch(CONFIG.dataPath + 'recently-completed.json');
        if (!response.ok) throw new Error('Failed to fetch recently completed');
        const tasks = await response.json();
        renderRecentlyCompleted(tasks);
    } catch (error) {
        console.warn('Using placeholder completed data');
        renderRecentlyCompleted([]);
    }
}

// Render recently completed tasks
function renderRecentlyCompleted(tasks) {
    const list = document.getElementById('completed-list');
    if (!list) return;

    let newHtml;
    if (tasks.length === 0) {
        newHtml = '<li class="empty">No recently completed tasks</li>';
    } else {
        const items = tasks.map(task => {
            const time = formatTime(task.completedAt);
            let badges = '';
            if (task.prStatus === 'merged') badges += '<span class="badge badge-merged">merged</span>';
            else if (task.prStatus === 'open') badges += '<span class="badge badge-pr">PR</span>';
            return `
            <li class="completed-task-item">
                <a href="${escapeHtml(task.retrospectiveLink)}">
                    <span class="task-title">${escapeHtml(task.title || task.id)}</span>
                    <span class="completed-meta">${time} ${badges}</span>
                </a>
            </li>`;
        });
        newHtml = items.join('');
    }

    if (list.innerHTML !== newHtml) {
        const scrollTop = list.scrollTop;
        list.innerHTML = newHtml;
        list.scrollTop = scrollTop;
    }
}

// Placeholder data for development/demo
function getPlaceholderSlots() {
    return [
        { number: 1, empty: true },
        { number: 2, empty: true },
        { number: 3, empty: true },
        { number: 4, empty: true },
        { number: 5, empty: true },
        { number: 6, empty: true }
    ];
}
