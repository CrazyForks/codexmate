'use strict';

const fs = require('fs');
const path = require('path');

const TEXT_FILE_EXTENSIONS = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.md', '.txt', '.svg', '.ts', '.tsx', '.jsx', '.yml', '.yaml']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_CONTEXT_FILE_BYTES = 16 * 1024;
const MAX_CONTEXT_TOTAL_BYTES = 64 * 1024;
const MAX_HISTORY_MESSAGES = 20;
const SENSITIVE_CONTEXT_NAME_RE = /(^|[._\-/])(credential|credentials|secret|secrets|token|tokens|apikey|api-key|api_key|password|passwd|private-key|private_key|\.env)([._\-/]|$)/i;

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sanitizeThreadId(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) ? text : '';
}

function normalizeWorkspacePath(rawPath, cwd) {
    const baseDir = path.resolve(typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd());
    const text = typeof rawPath === 'string' ? rawPath.trim().replace(/^['"]|['"]$/g, '') : '';
    if (!text || text.length > 240) {
        return { error: 'workspace file path is empty or too long' };
    }
    if (path.isAbsolute(text) || text.includes('\\')) {
        return { error: `workspace file path must be a safe relative path: ${text}` };
    }
    const normalized = path.normalize(text);
    if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.split(path.sep).includes('..')) {
        return { error: `workspace file path escapes cwd: ${text}` };
    }
    const ext = path.extname(normalized).toLowerCase();
    if (!TEXT_FILE_EXTENSIONS.has(ext)) {
        return { error: `workspace file extension is not allowed: ${ext || '(none)'}` };
    }
    const targetPath = path.resolve(baseDir, normalized);
    const relative = path.relative(baseDir, targetPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { error: `workspace file path escapes cwd: ${text}` };
    }
    return { path: targetPath, relativePath: normalized, baseDir };
}

function validateParentPath(targetPath, baseDir) {
    const resolvedBase = fs.realpathSync.native(baseDir);
    let current = path.dirname(targetPath);
    const pending = [];
    while (true) {
        if (current === resolvedBase) return { ok: true };
        if (current === path.dirname(current)) return { ok: false, error: 'workspace parent escapes cwd' };
        if (fs.existsSync(current)) {
            const stats = fs.lstatSync(current);
            if (stats.isSymbolicLink()) return { ok: false, error: `workspace parent is a symlink: ${path.relative(baseDir, current) || current}` };
            const resolvedCurrent = fs.realpathSync.native(current);
            const relative = path.relative(resolvedBase, resolvedCurrent);
            if (relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, error: 'workspace parent resolves outside cwd' };
            for (const child of pending) {
                const childRelative = path.relative(resolvedBase, child);
                if (childRelative.startsWith('..') || path.isAbsolute(childRelative)) return { ok: false, error: 'workspace parent escapes cwd' };
            }
            return { ok: true };
        }
        pending.push(current);
        current = path.dirname(current);
    }
}

function parseAttributes(info) {
    const attrs = {};
    const text = typeof info === 'string' ? info : '';
    const attrRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s]+))/g;
    let match;
    while ((match = attrRe.exec(text)) !== null) {
        attrs[match[1]] = match[3] || match[4] || match[5] || '';
    }
    return attrs;
}

function parseWorkspaceFileOperations(text) {
    const content = typeof text === 'string' ? text : '';
    const operations = [];
    const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
    let match;
    while ((match = fenceRe.exec(content)) !== null) {
        const info = String(match[1] || '').trim();
        if (!/^codexmate-file\b/i.test(info)) continue;
        const attrs = parseAttributes(info);
        const action = String(attrs.action || attrs.op || 'write').trim().toLowerCase();
        const filePath = String(attrs.path || attrs.file || attrs.filename || '').trim();
        operations.push({ action: action === 'update' ? 'write' : action, path: filePath, content: String(match[2] || '') });
    }

    const deleteRe = /^\s*CODEXMATE_(?:DELETE|REMOVE)_FILE\s*:\s*(.+?)\s*$/gmi;
    while ((match = deleteRe.exec(content)) !== null) {
        operations.push({ action: 'delete', path: String(match[1] || '').trim(), content: '' });
    }
    return operations;
}

function isSensitiveWorkspaceContextFile(relativePath) {
    const normalized = String(relativePath || '').replace(/\\+/g, '/').toLowerCase();
    return SENSITIVE_CONTEXT_NAME_RE.test(normalized);
}

function isWorkspaceFileMentioned(relativePath, promptText) {
    const normalizedPath = String(relativePath || '').toLowerCase();
    const baseName = path.basename(normalizedPath);
    return !!normalizedPath && (promptText.includes(normalizedPath) || (!!baseName && promptText.includes(baseName)));
}

function applyWorkspaceFileOperations(text, cwd, options = {}) {
    const allowWrite = options.allowWrite === true;
    const operations = parseWorkspaceFileOperations(text);
    const files = [];
    const warnings = [];
    if (!allowWrite && operations.length > 0) {
        return { files, warnings: ['workspace file operations skipped because allowWrite is false'] };
    }
    for (const operation of operations) {
        const action = operation.action === 'delete' ? 'delete' : 'write';
        const normalized = normalizeWorkspacePath(operation.path, cwd);
        if (normalized.error) {
            warnings.push(normalized.error);
            continue;
        }
        try {
            if (action === 'delete') {
                if (!fs.existsSync(normalized.path)) {
                    files.push({ path: normalized.path, relativePath: normalized.relativePath, bytes: 0, operation: 'delete', existed: false });
                    continue;
                }
                const stats = fs.lstatSync(normalized.path);
                if (stats.isSymbolicLink()) {
                    warnings.push(`workspace target is a symlink: ${normalized.relativePath}`);
                    continue;
                }
                if (!stats.isFile()) {
                    warnings.push(`workspace target is not a file: ${normalized.relativePath}`);
                    continue;
                }
                fs.unlinkSync(normalized.path);
                files.push({ path: normalized.path, relativePath: normalized.relativePath, bytes: 0, operation: 'delete', existed: true });
                continue;
            }

            const body = String(operation.content || '');
            const bytes = Buffer.byteLength(body, 'utf-8');
            if (bytes > MAX_FILE_BYTES) {
                warnings.push(`workspace artifact too large and skipped: ${normalized.relativePath}`);
                continue;
            }
            const parentValidation = validateParentPath(normalized.path, normalized.baseDir);
            if (!parentValidation.ok) {
                warnings.push(parentValidation.error || `workspace parent is unsafe: ${normalized.relativePath}`);
                continue;
            }
            ensureDir(path.dirname(normalized.path));
            try {
                if (fs.lstatSync(normalized.path).isSymbolicLink()) {
                    warnings.push(`workspace target is a symlink: ${normalized.relativePath}`);
                    continue;
                }
            } catch (error) {
                if (!error || error.code !== 'ENOENT') throw error;
            }
            fs.writeFileSync(normalized.path, body, { encoding: 'utf-8', mode: 0o600 });
            files.push({ path: normalized.path, relativePath: normalized.relativePath, bytes, operation: 'write' });
        } catch (error) {
            warnings.push(`workspace operation failed for ${normalized.relativePath}: ${error && error.message ? error.message : String(error)}`);
        }
    }
    return { files, warnings };
}

function walkWorkspace(cwd, options = {}) {
    const baseDir = path.resolve(typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd());
    const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 120;
    const files = [];
    const skipNames = new Set(['.git', 'node_modules', '.codexmate', '.DS_Store']);
    function walk(dir) {
        if (files.length >= maxFiles) return;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (files.length >= maxFiles) break;
            if (skipNames.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            let stats;
            try {
                stats = fs.lstatSync(fullPath);
            } catch (_) {
                continue;
            }
            if (stats.isSymbolicLink()) continue;
            const relativePath = path.relative(baseDir, fullPath);
            if (stats.isDirectory()) {
                walk(fullPath);
            } else if (stats.isFile()) {
                files.push({ path: fullPath, relativePath, bytes: stats.size, ext: path.extname(relativePath).toLowerCase() });
            }
        }
    }
    if (fs.existsSync(baseDir)) walk(baseDir);
    return files;
}

function buildWorkspaceChatContext(cwd, prompt = '', historyMessages = []) {
    const files = walkWorkspace(cwd);
    const promptText = [prompt, ...historyMessages.map((item) => item && item.content ? item.content : '')].join('\n').toLowerCase();
    const treeLines = files.map((file) => `- ${file.relativePath} (${file.bytes} bytes)`);
    const contentBlocks = [];
    let total = 0;
    for (const file of files) {
        if (!TEXT_FILE_EXTENSIONS.has(file.ext)) continue;
        if (file.bytes > MAX_CONTEXT_FILE_BYTES) continue;
        const mentioned = isWorkspaceFileMentioned(file.relativePath, promptText);
        if (!mentioned) continue;
        if (isSensitiveWorkspaceContextFile(file.relativePath)) continue;
        if (total + file.bytes > MAX_CONTEXT_TOTAL_BYTES) break;
        try {
            const body = fs.readFileSync(file.path, 'utf-8');
            total += Buffer.byteLength(body, 'utf-8');
            contentBlocks.push(`### ${file.relativePath}\n\`\`\`\n${body}\n\`\`\``);
        } catch (_) {}
    }
    return [
        '当前工作区文件列表:',
        treeLines.length ? treeLines.join('\n') : '(empty workspace)',
        contentBlocks.length ? '\n当前工作区可读文本文件内容快照:\n' + contentBlocks.join('\n\n') : '\n当前没有可注入的文本文件内容快照。'
    ].join('\n');
}

function getThreadFile(storeDir, threadId) {
    const safe = sanitizeThreadId(threadId);
    if (!safe) return '';
    return path.join(storeDir, `${safe}.json`);
}

function loadWorkspaceChatThread(storeDir, threadId) {
    const file = getThreadFile(storeDir, threadId);
    if (!file || !fs.existsSync(file)) return { threadId: sanitizeThreadId(threadId), messages: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const messages = Array.isArray(parsed.messages) ? parsed.messages.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string') : [];
        return { ...parsed, threadId: sanitizeThreadId(parsed.threadId || threadId), messages: messages.slice(-MAX_HISTORY_MESSAGES) };
    } catch (_) {
        return { threadId: sanitizeThreadId(threadId), messages: [] };
    }
}

function appendWorkspaceChatThread(storeDir, threadId, messages, metadata = {}) {
    const safe = sanitizeThreadId(threadId);
    if (!safe) return { ok: false, error: 'invalid thread id' };
    ensureDir(storeDir);
    const existing = loadWorkspaceChatThread(storeDir, safe);
    const now = new Date().toISOString();
    const nextMessages = existing.messages.concat((Array.isArray(messages) ? messages : []).map((item) => ({
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content: String(item.content || ''),
        at: item.at || now
    }))).slice(-MAX_HISTORY_MESSAGES);
    const payload = {
        threadId: safe,
        cwd: metadata.cwd || existing.cwd || '',
        updatedAt: now,
        messages: nextMessages
    };
    const file = getThreadFile(storeDir, safe);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
    return { ok: true, file, messageCount: nextMessages.length };
}

module.exports = {
    TEXT_FILE_EXTENSIONS,
    sanitizeThreadId,
    normalizeWorkspacePath,
    parseWorkspaceFileOperations,
    applyWorkspaceFileOperations,
    walkWorkspace,
    buildWorkspaceChatContext,
    loadWorkspaceChatThread,
    appendWorkspaceChatThread
};
