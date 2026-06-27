import assert from 'assert';
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
