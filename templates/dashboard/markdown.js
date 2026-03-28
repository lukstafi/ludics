// markdown.js -- shared markdown-to-HTML renderer
// Used by: dashboard.js, briefing.html, proposal.html, retrospective.html

/**
 * Simple markdown to HTML converter.
 * Handles: headings, bold, italic, code, lists, paragraphs, horizontal rules, tables.
 */
function markdownToHtml(md) {
    if (!md) return '';

    const lines = md.split('\n');
    let html = '';
    let inList = null; // 'ul' or 'ol'
    let inPre = false;
    let preContent = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Fenced code blocks
        if (line.startsWith('```')) {
            if (inPre) {
                html += '<pre><code>' + escapeHtml(preContent.trimEnd()) + '</code></pre>\n';
                preContent = '';
                inPre = false;
            } else {
                if (inList) { html += `</${inList}>\n`; inList = null; }
                inPre = true;
            }
            continue;
        }
        if (inPre) {
            preContent += line + '\n';
            continue;
        }

        // Tables: detect a pipe-delimited line followed by a separator line
        if (line.includes('|') && i + 1 < lines.length && lines[i + 1].match(/^\|?[\s-]+\|[\s-|]+$/)) {
            if (inList) { html += `</${inList}>\n`; inList = null; }
            // Parse header row
            const headerCells = parseTableRow(line);
            // Skip separator line
            i++;
            // Collect body rows
            const bodyRows = [];
            while (i + 1 < lines.length && lines[i + 1].includes('|') && !lines[i + 1].match(/^\s*$/)) {
                i++;
                bodyRows.push(parseTableRow(lines[i]));
            }
            // Render table
            html += '<table>\n<thead><tr>';
            for (const cell of headerCells) {
                html += '<th>' + inlineFormat(cell) + '</th>';
            }
            html += '</tr></thead>\n<tbody>\n';
            for (const row of bodyRows) {
                html += '<tr>';
                for (const cell of row) {
                    html += '<td>' + inlineFormat(cell) + '</td>';
                }
                html += '</tr>\n';
            }
            html += '</tbody></table>\n';
            continue;
        }

        // Close list if current line is not a list item
        if (inList && !line.match(/^(\s*[-*]|\s*\d+\.)\s/)) {
            html += `</${inList}>\n`;
            inList = null;
        }

        // Headings
        if (line.startsWith('### ')) {
            html += '<h3>' + inlineFormat(line.slice(4)) + '</h3>\n';
            continue;
        }
        if (line.startsWith('## ')) {
            html += '<h2>' + inlineFormat(line.slice(3)) + '</h2>\n';
            continue;
        }
        if (line.startsWith('# ')) {
            html += '<h1>' + inlineFormat(line.slice(2)) + '</h1>\n';
            continue;
        }

        // Horizontal rule
        if (line.match(/^---+$/)) {
            html += '<hr>\n';
            continue;
        }

        // Unordered list
        if (line.match(/^\s*[-*]\s/)) {
            if (inList !== 'ul') {
                if (inList) html += `</${inList}>\n`;
                html += '<ul>\n';
                inList = 'ul';
            }
            html += '<li>' + inlineFormat(line.replace(/^\s*[-*]\s/, '')) + '</li>\n';
            continue;
        }

        // Ordered list
        if (line.match(/^\s*\d+\.\s/)) {
            if (inList !== 'ol') {
                if (inList) html += `</${inList}>\n`;
                html += '<ol>\n';
                inList = 'ol';
            }
            html += '<li>' + inlineFormat(line.replace(/^\s*\d+\.\s/, '')) + '</li>\n';
            continue;
        }

        // Empty line
        if (line.trim() === '') {
            continue;
        }

        // Paragraph
        html += '<p>' + inlineFormat(line) + '</p>\n';
    }

    // Close any open list
    if (inList) html += `</${inList}>\n`;
    if (inPre) html += '<pre><code>' + escapeHtml(preContent.trimEnd()) + '</code></pre>\n';

    return html;
}

// Parse a markdown table row into cells
function parseTableRow(line) {
    // Strip leading/trailing pipes and split
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map(c => c.trim());
}

// Inline formatting: bold, italic, code, links
function inlineFormat(text) {
    let s = escapeHtml(text);
    // Code (backticks) - must come before bold/italic
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Links
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    return s;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
