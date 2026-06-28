import assert from 'assert';
import http from 'node:http';
import https from 'node:https';
import { readProjectFile } from './helpers/web-ui-source.mjs';

const cliSource = readProjectFile('cli.js');

function extractBlockBySignature(source, signature) {
    const startIndex = source.indexOf(signature);
    if (startIndex === -1) {
        throw new Error(`Signature not found: ${signature}`);
    }
    const signatureBraceOffset = signature.lastIndexOf('{');
    const braceStart = signatureBraceOffset >= 0
        ? (startIndex + signatureBraceOffset)
        : source.indexOf('{', startIndex + signature.length);
    if (braceStart === -1) {
        throw new Error(`Opening brace not found for: ${signature}`);
    }
    let depth = 0;
    for (let i = braceStart; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return source.slice(startIndex, i + 1);
            }
        }
    }
    throw new Error(`Closing brace not found for: ${signature}`);
}

function instantiateFunction(funcSource, funcName, bindings = {}) {
    const bindingNames = Object.keys(bindings);
    const bindingValues = Object.values(bindings);
    return Function(...bindingNames, `${funcSource}\nreturn ${funcName};`)(...bindingValues);
}

test('resolveSpawnCommand keeps bare command names on windows', () => {
    const source = extractBlockBySignature(cliSource, 'function resolveSpawnCommand(command) {');
    const resolveSpawnCommand = instantiateFunction(source, 'resolveSpawnCommand', {
        process: { platform: 'win32' },
        resolveCommandPath() {
            return 'C:\\nvm4w\\nodejs\\codex';
        }
    });

    assert.strictEqual(resolveSpawnCommand('codex'), 'codex');
});

test('postOpenAiChatCompletion fails fast on oversized responses', async () => {
    const source = extractBlockBySignature(cliSource, 'function postOpenAiChatCompletion(requestConfig, body, options = {}) {');
    const postOpenAiChatCompletion = instantiateFunction(source, 'postOpenAiChatCompletion', {
        URL,
        http,
        https,
        HTTP_KEEP_ALIVE_AGENT: false,
        HTTPS_KEEP_ALIVE_AGENT: false,
        TASK_OPENAI_CHAT_MAX_RESPONSE_BYTES: 8,
        TASK_OPENAI_CHAT_TIMEOUT_MS: 1000,
        Buffer,
        truncateTaskText(text, limit) {
            return String(text || '').slice(0, limit || 1000);
        }
    });
    const server = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(64) } }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address();
        const result = await postOpenAiChatCompletion({
            endpointUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
            extraHeaders: {}
        }, { model: 'mock', messages: [] });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, 200);
        assert.strictEqual(result.error, 'OpenAI Chat response too large');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('buildTaskOpenAiChatStatus reports provider readiness without leaking secrets', () => {
    const source = extractBlockBySignature(cliSource, 'function buildTaskOpenAiChatStatus() {');
    const buildTaskOpenAiChatStatus = instantiateFunction(source, 'buildTaskOpenAiChatStatus', {
        resolveTaskOpenAiChatConfig() {
            return {
                providerName: 'mock-openai',
                model: 'gpt-4.1-mini',
                endpointUrl: 'https://secret.example.test/v1/chat/completions?key=abc123',
                apiKey: 'sk-secret',
                extraHeaders: { 'X-Api-Key': 'hidden' }
            };
        },
        redactTaskEndpointUrl(endpointUrl) {
            return String(endpointUrl || '').replace('key=abc123', 'key=***');
        }
    });

    assert.deepStrictEqual(buildTaskOpenAiChatStatus(), {
        ok: true,
        ready: true,
        error: '',
        providerName: 'mock-openai',
        model: 'gpt-4.1-mini',
        endpoint: 'https://secret.example.test/v1/chat/completions?key=***',
        hasApiKey: true,
        hasExtraHeaders: true
    });
});

test('buildTaskOpenAiChatStatus surfaces OpenAI Chat config errors', () => {
    const source = extractBlockBySignature(cliSource, 'function buildTaskOpenAiChatStatus() {');
    const buildTaskOpenAiChatStatus = instantiateFunction(source, 'buildTaskOpenAiChatStatus', {
        resolveTaskOpenAiChatConfig() {
            return { error: 'OpenAI Chat 提供商 mock 缺少 base_url' };
        },
        redactTaskEndpointUrl(endpointUrl) {
            return endpointUrl;
        }
    });

    assert.deepStrictEqual(buildTaskOpenAiChatStatus(), {
        ok: false,
        ready: false,
        error: 'OpenAI Chat 提供商 mock 缺少 base_url',
        providerName: '',
        model: '',
        endpoint: '',
        hasApiKey: false,
        hasExtraHeaders: false
    });
});

test('runOpenAiChatTaskNode fails before request when OpenAI Chat auth is missing', async () => {
    const source = extractBlockBySignature(cliSource, 'async function runOpenAiChatTaskNode(node, context = {}) {');
    let requested = false;
    const runOpenAiChatTaskNode = instantiateFunction(source, 'runOpenAiChatTaskNode', {
        resolveTaskOpenAiChatConfig() {
            return {
                providerName: 'mock-openai',
                model: 'gpt-4.1-mini',
                endpointUrl: 'https://api.example.test/v1/chat/completions',
                apiKey: '',
                extraHeaders: {}
            };
        },
        postOpenAiChatCompletion() {
            requested = true;
            return Promise.resolve({ ok: true, status: 200, payload: {} });
        },
        extractModelResponseText() {
            return '';
        },
        truncateTaskText(text, limit) {
            return String(text || '').slice(0, limit || 1000);
        },
        redactTaskEndpointUrl(endpointUrl) {
            return endpointUrl;
        },
        toIsoTime() {
            return '2026-06-27T15:30:00.000Z';
        },
        Date
    });

    const result = await runOpenAiChatTaskNode({ id: 'analysis-01', prompt: 'inspect', write: false }, {});

    assert.strictEqual(result.success, false);
    assert.match(result.error, /缺少 API key/);
    assert.strictEqual(result.output.provider, 'mock-openai');
    assert.strictEqual(requested, false);
});

test('runOpenAiChatTaskNode uses configured OpenAI Chat provider without spawning codex', async () => {
    const source = extractBlockBySignature(cliSource, 'async function runOpenAiChatTaskNode(node, context = {}) {');
    const requests = [];
    const runOpenAiChatTaskNode = instantiateFunction(source, 'runOpenAiChatTaskNode', {
        resolveTaskOpenAiChatConfig() {
            return {
                providerName: 'mock-openai',
                model: 'deepseek-v4-pro',
                endpointUrl: 'http://127.0.0.1:18183/v1/chat/completions',
                apiKey: 'sk-unit-secret',
                extraHeaders: {}
            };
        },
        postOpenAiChatCompletion(config, body) {
            requests.push({ config, body });
            return Promise.resolve({
                ok: true,
                status: 200,
                payload: {
                    choices: [{ message: { content: 'mock-openai-chat-ok' } }]
                }
            });
        },
        extractModelResponseText(payload) {
            return payload.choices[0].message.content;
        },
        truncateTaskText(text, limit) {
            return String(text || '').slice(0, limit || 1000);
        },
        redactTaskEndpointUrl(endpointUrl) {
            return String(endpointUrl || '').replace(/sk-unit-secret/g, '***');
        },
        toIsoTime() {
            return '2026-06-27T15:30:00.000Z';
        },
        Date
    });

    const result = await runOpenAiChatTaskNode({
        id: 'analysis-01',
        prompt: 'inspect the orchestration chain',
        write: false
    }, {
        cwd: 'C:/repo',
        dependencyResults: [{ id: 'plan-01', summary: 'dependency done' }]
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.output.provider, 'mock-openai');
    assert.strictEqual(result.output.model, 'deepseek-v4-pro');
    assert.strictEqual(result.output.text, 'mock-openai-chat-ok');
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].body.model, 'deepseek-v4-pro');
    assert.strictEqual(requests[0].body.messages[0].role, 'system');
    assert.strictEqual(requests[0].body.messages[1].role, 'user');
    assert.match(requests[0].body.messages[1].content, /dependency done/);
    assert.ok(!JSON.stringify(result).includes('sk-unit-secret'));
});
