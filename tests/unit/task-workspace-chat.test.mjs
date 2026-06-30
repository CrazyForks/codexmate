import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    parseWorkspaceFileOperations,
    applyWorkspaceFileOperations,
    buildWorkspaceChatContext,
    appendWorkspaceChatThread,
    loadWorkspaceChatThread
} = require('../../lib/task-workspace-chat.js');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codexmate-workspace-chat-'));
}

test('workspace chat parses write and delete operations', () => {
    const operations = parseWorkspaceFileOperations([
        '创建文件：',
        '```codexmate-file action="write" path="notes/todo.md"',
        '# Todo',
        '```',
        'CODEXMATE_DELETE_FILE: old.txt'
    ].join('\n'));

    assert.deepStrictEqual(operations.map((item) => ({ action: item.action, path: item.path })), [
        { action: 'write', path: 'notes/todo.md' },
        { action: 'delete', path: 'old.txt' }
    ]);
});

test('workspace chat applies create update read context and delete within cwd', () => {
    const cwd = tempDir();
    const created = applyWorkspaceFileOperations('```codexmate-file action="write" path="notes/todo.md"\n# Todo\n- create\n```', cwd, { allowWrite: true });
    assert.strictEqual(created.warnings.length, 0);
    assert.strictEqual(created.files[0].operation, 'write');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'notes/todo.md'), 'utf-8'), '# Todo\n- create\n');

    const updated = applyWorkspaceFileOperations('```codexmate-file action="write" path="notes/todo.md"\n# Todo\n- updated\n```', cwd, { allowWrite: true });
    assert.strictEqual(updated.files[0].operation, 'write');
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'notes/todo.md'), 'utf-8'), '# Todo\n- updated\n');

    const context = buildWorkspaceChatContext(cwd, '读取 notes/todo.md');
    assert.ok(context.includes('notes/todo.md'));
    assert.ok(context.includes('- updated'));

    const deleted = applyWorkspaceFileOperations('CODEXMATE_DELETE_FILE: notes/todo.md', cwd, { allowWrite: true });
    assert.strictEqual(deleted.files[0].operation, 'delete');
    assert.strictEqual(fs.existsSync(path.join(cwd, 'notes/todo.md')), false);
});

test('workspace chat rejects path traversal and honors allowWrite', () => {
    const cwd = tempDir();
    const blocked = applyWorkspaceFileOperations('```codexmate-file action="write" path="../escape.txt"\nnope\n```', cwd, { allowWrite: true });
    assert.ok(blocked.warnings.some((item) => item.includes('escapes cwd')));
    assert.strictEqual(fs.existsSync(path.join(cwd, '..', 'escape.txt')), false);

    const dry = applyWorkspaceFileOperations('```codexmate-file action="write" path="safe.txt"\nnope\n```', cwd, { allowWrite: false });
    assert.ok(dry.warnings.some((item) => item.includes('allowWrite is false')));
    assert.strictEqual(fs.existsSync(path.join(cwd, 'safe.txt')), false);
});

test('workspace chat stores and reloads multi-turn thread history', () => {
    const store = tempDir();
    const cwd = tempDir();
    const first = appendWorkspaceChatThread(store, 'thread-crud', [
        { role: 'user', content: 'create file' },
        { role: 'assistant', content: 'created' }
    ], { cwd });
    assert.strictEqual(first.ok, true);
    appendWorkspaceChatThread(store, 'thread-crud', [
        { role: 'user', content: 'read file' },
        { role: 'assistant', content: 'content' }
    ], { cwd });

    const loaded = loadWorkspaceChatThread(store, 'thread-crud');
    assert.strictEqual(loaded.cwd, cwd);
    assert.deepStrictEqual(loaded.messages.map((item) => item.role), ['user', 'assistant', 'user', 'assistant']);
    assert.ok(loaded.messages[0].at);
});
