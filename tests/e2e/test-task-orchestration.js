const { spawn } = require('child_process');
const { assert, runSync, fs, path } = require('./helpers');


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startOpenAiChatMock(tmpHome) {
    const scriptPath = path.join(tmpHome, 'task-openai-chat-mock.cjs');
    const portFile = path.join(tmpHome, 'task-openai-chat-mock.port');
    const requestsFile = path.join(tmpHome, 'task-openai-chat-requests.jsonl');
    fs.writeFileSync(scriptPath, `
const http = require('http');
const fs = require('fs');
const portFile = process.argv[2];
const requestsFile = process.argv[3];
let requestCount = 0;
const server = http.createServer((req, res) => {
  const requestPath = String(req.url || '').split('?')[0];
  let rawBody = '';
  req.setEncoding('utf-8');
  req.on('data', chunk => { rawBody += chunk; });
  req.on('end', () => {
    let parsedBody = null;
    try { parsedBody = rawBody ? JSON.parse(rawBody) : null; } catch (_) {}
    requestCount += 1;
    fs.appendFileSync(requestsFile, JSON.stringify({
      n: requestCount,
      method: req.method,
      path: requestPath,
      authorization: req.headers.authorization || '',
      body: parsedBody
    }) + '\\n');
    if (req.method === 'GET' && requestPath === '/v1/models') {
      const body = JSON.stringify({ object: 'list', data: [
        { id: 'deepseek-v4-pro', object: 'model' },
        { id: 'deepseek-v4-flash', object: 'model' }
      ] });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body, 'utf-8') });
      res.end(body, 'utf-8');
      return;
    }
    if (req.method === 'POST' && requestPath === '/v1/chat/completions') {
      const model = parsedBody && parsedBody.model ? parsedBody.model : 'unknown-model';
      const requestText = JSON.stringify(parsedBody || {});
      const content = requestText.includes('index.html')
        ? '输出文件：index.html\\n\`\`\`html\\n<!doctype html><html><head><meta charset="utf-8"><title>2048 Probe</title></head><body><h1>2048</h1><div id="grid">2 4 8 16</div></body></html>\\n\`\`\`'
        : 'openai-chat-e2e-ok model=' + model + ' request=' + requestCount;
      const body = JSON.stringify({
        id: 'chatcmpl-task-e2e-' + requestCount,
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body, 'utf-8') });
      res.end(body, 'utf-8');
      return;
    }
    const body = JSON.stringify({ error: { message: 'not found ' + req.method + ' ' + requestPath } });
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body, 'utf-8') });
    res.end(body, 'utf-8');
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port), 'utf-8');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`, 'utf-8');

    const child = spawn(process.execPath, [scriptPath, portFile, requestsFile], {
        stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    for (let i = 0; i < 80; i += 1) {
        if (fs.existsSync(portFile)) {
            const port = Number(fs.readFileSync(portFile, 'utf-8').trim());
            if (Number.isFinite(port) && port > 0) {
                return {
                    port,
                    process: child,
                    readRequests() {
                        if (!fs.existsSync(requestsFile)) return [];
                        return fs.readFileSync(requestsFile, 'utf-8')
                            .split(/\r?\n/g)
                            .filter(Boolean)
                            .map(line => JSON.parse(line));
                    },
                    close() {
                        return new Promise((resolve) => {
                            if (child.exitCode !== null || child.signalCode) return resolve();
                            const timer = setTimeout(() => {
                                try { child.kill('SIGKILL'); } catch (_) {}
                                resolve();
                            }, 2000);
                            child.once('exit', () => {
                                clearTimeout(timer);
                                resolve();
                            });
                            try { child.kill('SIGTERM'); } catch (_) { resolve(); }
                        });
                    }
                };
            }
        }
        if (child.exitCode !== null) {
            throw new Error(`OpenAI Chat mock exited early: ${stderr}`);
        }
        await sleep(100);
    }
    try { child.kill('SIGKILL'); } catch (_) {}
    throw new Error(`OpenAI Chat mock did not start: ${stderr}`);
}

function writeOpenAiChatConfig(tmpHome, baseUrl) {
    const configDir = path.join(tmpHome, '.codex');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'codexmate-init.json'), JSON.stringify({ version: 1, mode: 'task-openai-chat-e2e' }), 'utf-8');
    fs.writeFileSync(path.join(configDir, 'config.toml'), [
        'model = "deepseek-v4-pro"',
        'model_provider = "local-openai-chat"',
        '',
        '[model_providers.local-openai-chat]',
        'name = "Local OpenAI Chat"',
        `base_url = "${baseUrl}/v1"`,
        'wire_api = "chat_completions"',
        'preferred_auth_method = "sk-task-e2e-secret"',
        'models = ["deepseek-v4-pro", "deepseek-v4-flash"]',
        ''
    ].join('\n'), 'utf-8');
}

function assertOpenAiRunPayload(payload, label) {
    assert(payload && payload.run && payload.run.status === 'success', `${label} should succeed`);
    const nodes = Array.isArray(payload.run.nodes) ? payload.run.nodes : [];
    assert(nodes.length > 0, `${label} should include nodes`);
    assert(nodes.every(node => node.kind === 'openai-chat'), `${label} should use OpenAI Chat nodes`);
    assert(nodes.every(node => node.status === 'success'), `${label} nodes should all succeed`);
    assert(nodes.some(node => node.output && node.output.provider === 'local-openai-chat'), `${label} should record provider`);
    assert(JSON.stringify(payload).indexOf('sk-task-e2e-secret') === -1, `${label} must not leak api key`);
}

function assertOpenAiRequests(mock, minCount, label) {
    const chatRequests = mock.readRequests().filter(item => item.path === '/v1/chat/completions');
    assert(chatRequests.length >= minCount, `${label} should call /v1/chat/completions at least ${minCount} times, got ${chatRequests.length}`);
    for (const item of chatRequests) {
        assert(item.method === 'POST', `${label} chat request should be POST`);
        assert(item.authorization === 'Bearer sk-task-e2e-secret', `${label} should pass bearer auth`);
        assert(item.body && item.body.model === 'deepseek-v4-pro', `${label} should pass selected model`);
        assert(Array.isArray(item.body.messages) && item.body.messages.length >= 2, `${label} should send chat messages`);
        assert(item.body.messages.some(message => message.role === 'system'), `${label} should include system prompt`);
        assert(item.body.messages.some(message => message.role === 'user'), `${label} should include user prompt`);
    }
}

function parseJsonOutput(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
        return {};
    }
    try {
        return JSON.parse(text);
    } catch (_) {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(text.slice(start, end + 1));
        }
        throw new Error(`invalid json output: ${text.slice(0, 200)}`);
    }
}

module.exports = async function testTaskOrchestration(ctx) {
    const { api, node, cliPath, env, tmpHome } = ctx;

    const planResult = runSync(node, [
        cliPath,
        'task',
        'plan',
        '--target',
        '检查当前配置并输出摘要',
        '--follow-up',
        '整理结论',
        '--json'
    ], { env });
    assert(planResult.status === 0, `task plan failed: ${planResult.stderr || planResult.stdout}`);
    const planPayload = parseJsonOutput(planResult.stdout);
    assert(planPayload.ok === true, 'task plan should validate');
    assert(planPayload.plan && Array.isArray(planPayload.plan.nodes), 'task plan should include nodes');
    assert(planPayload.plan.nodes.length >= 2, 'task plan should include multiple nodes');
    assert(planPayload.plan.engine === 'openai-chat', 'default task plan should use OpenAI Chat engine');
    assert(planPayload.plan.nodes.every((node) => node.kind === 'openai-chat'), 'default task plan nodes should be OpenAI Chat nodes');

    const invalidWorkflowPlanResult = runSync(node, [
        cliPath,
        'task',
        'plan',
        '--target',
        'plain target',
        '--workflow-id',
        'missing-workflow',
        '--engine',
        'workflow',
        '--json'
    ], { env });
    assert(invalidWorkflowPlanResult.status !== 0, 'task plan should fail for unknown workflow ids');
    const invalidWorkflowPlanPayload = parseJsonOutput(invalidWorkflowPlanResult.stdout);
    assert(invalidWorkflowPlanPayload.ok === false, 'invalid workflow plan should be rejected');
    assert(Array.isArray(invalidWorkflowPlanPayload.issues), 'invalid workflow plan should include issues');
    assert(invalidWorkflowPlanPayload.issues.some((item) => String(item.message || '').includes('unknown workflow')), 'invalid workflow plan should mention unknown workflow');

    const runResult = runSync(node, [
        cliPath,
        'task',
        'run',
        '--target',
        '诊断当前配置',
        '--workflow-id',
        'diagnose-config',
        '--engine',
        'workflow',
        '--json'
    ], { env });
    assert(runResult.status === 0, `task run failed: ${runResult.stderr || runResult.stdout}`);
    const runPayload = parseJsonOutput(runResult.stdout);
    assert(runPayload.run && runPayload.run.status === 'success', 'task run should succeed with diagnose-config workflow');
    assert(typeof runPayload.runId === 'string' && runPayload.runId, 'task run should return runId');
    assert(typeof runPayload.taskId === 'string' && runPayload.taskId, 'task run should return taskId');

    const runsResult = runSync(node, [cliPath, 'task', 'runs', '--limit', '10', '--json'], { env });
    assert(runsResult.status === 0, `task runs failed: ${runsResult.stderr || runsResult.stdout}`);
    const runsPayload = parseJsonOutput(runsResult.stdout);
    assert(Array.isArray(runsPayload.runs), 'task runs should return runs array');
    assert(runsPayload.runs.some((item) => item.runId === runPayload.runId), 'task runs should include latest run');

    const queueAddResult = runSync(node, [
        cliPath,
        'task',
        'queue',
        'add',
        '--target',
        '再次诊断当前配置',
        '--workflow-id',
        'diagnose-config',
        '--engine',
        'workflow',
        '--json'
    ], { env });
    assert(queueAddResult.status === 0, `task queue add failed: ${queueAddResult.stderr || queueAddResult.stdout}`);
    const queueAddPayload = parseJsonOutput(queueAddResult.stdout);
    assert(queueAddPayload.ok === true, 'task queue add should succeed');
    assert(queueAddPayload.task && queueAddPayload.task.taskId, 'queue add should return task');

    const queueShowResult = runSync(node, [
        cliPath,
        'task',
        'queue',
        'show',
        queueAddPayload.task.taskId
    ], { env });
    assert(queueShowResult.status === 0, `task queue show failed: ${queueShowResult.stderr || queueShowResult.stdout}`);
    const queueShowPayload = parseJsonOutput(queueShowResult.stdout);
    assert(queueShowPayload.taskId === queueAddPayload.task.taskId, 'task queue show should resolve task');

    const queueStartResult = runSync(node, [
        cliPath,
        'task',
        'queue',
        'start',
        queueAddPayload.task.taskId,
        '--json'
    ], { env });
    assert(queueStartResult.status === 0, `task queue start failed: ${queueStartResult.stderr || queueStartResult.stdout}`);
    const queueStartPayload = parseJsonOutput(queueStartResult.stdout);
    assert(queueStartPayload.ok === true, 'task queue start should succeed');
    assert(queueStartPayload.detail && queueStartPayload.detail.run && queueStartPayload.detail.run.status === 'success', 'queued task should complete successfully');

    const logsResult = runSync(node, [
        cliPath,
        'task',
        'logs',
        queueStartPayload.detail.runId,
        '--json'
    ], { env });
    assert(logsResult.status === 0, `task logs failed: ${logsResult.stderr || logsResult.stdout}`);
    const logsPayload = parseJsonOutput(logsResult.stdout);
    assert(typeof logsPayload.logs === 'string', 'task logs should return log text');
    assert(logsPayload.logs.includes('# workflow-01') || logsPayload.logs.includes('# diagnose-config') || logsPayload.logs.includes('# workflow'), 'task logs should include node heading');

    const queueListResult = runSync(node, [cliPath, 'task', 'queue', 'list', '--json'], { env });
    assert(queueListResult.status === 0, `task queue list failed: ${queueListResult.stderr || queueListResult.stdout}`);
    const queueListPayload = parseJsonOutput(queueListResult.stdout);
    assert(Array.isArray(queueListPayload.tasks), 'task queue list should return tasks array');
    assert(queueListPayload.tasks.some((item) => item.taskId === queueAddPayload.task.taskId), 'task queue list should include queued task record');

    const taskRunsFile = path.join(tmpHome, '.codex', 'codexmate-task-runs.jsonl');
    const taskQueueFile = path.join(tmpHome, '.codex', 'codexmate-task-queue.json');
    assert(fs.existsSync(taskRunsFile), 'task runs file should be created');
    assert(fs.existsSync(taskQueueFile), 'task queue file should be created');

    const apiOverview = await api('task-overview');
    assert(Array.isArray(apiOverview.queue), 'task-overview API should return queue');
    assert(Array.isArray(apiOverview.runs), 'task-overview API should return runs');

    const apiPlan = await api('task-plan', {
        target: '检查配置后输出摘要',
        followUps: ['整理结果']
    });
    assert(apiPlan.ok === true, 'task-plan API should validate');
    assert(apiPlan.plan && Array.isArray(apiPlan.plan.waves), 'task-plan API should return waves');

    const apiQueueAdd = await api('task-queue-add', {
        target: '排队执行配置诊断',
        workflowIds: ['diagnose-config'],
        engine: 'workflow'
    });
    assert(apiQueueAdd.ok === true, 'task-queue-add API should succeed');

    const apiQueueStart = await api('task-queue-start', {
        taskId: apiQueueAdd.task.taskId,
        detach: false
    });
    assert(apiQueueStart.ok === true, 'task-queue-start API should succeed');
    assert(apiQueueStart.detail && apiQueueStart.detail.run && apiQueueStart.detail.run.status === 'success', 'API queue start should execute task');

    const apiRunDetail = await api('task-run-detail', { runId: apiQueueStart.detail.runId });
    assert(apiRunDetail && apiRunDetail.runId === apiQueueStart.detail.runId, 'task-run-detail API should return detail');

    const openAiMock = await startOpenAiChatMock(tmpHome);
    try {
        writeOpenAiChatConfig(tmpHome, `http://127.0.0.1:${openAiMock.port}`);

        const openAiPlanResult = runSync(node, [
            cliPath,
            'task',
            'plan',
            '--target',
            'OpenAI Chat provider 端到端模拟',
            '--cwd',
            path.join(tmpHome, 'task-plan-workspace'),
            '--thread-id',
            'thread-cli-plan',
            '--follow-up',
            '输出风险说明',
            '--engine',
            'openai-chat',
            '--json'
        ], { env });
        assert(openAiPlanResult.status === 0, `OpenAI Chat task plan failed: ${openAiPlanResult.stderr || openAiPlanResult.stdout}`);
        const openAiPlanPayload = parseJsonOutput(openAiPlanResult.stdout);
        assert(openAiPlanPayload.ok === true, 'OpenAI Chat task plan should validate');
        assert(openAiPlanPayload.plan && openAiPlanPayload.plan.engine === 'openai-chat', 'OpenAI Chat plan should keep engine');
        assert(openAiPlanPayload.plan.threadId === 'thread-cli-plan', 'OpenAI Chat plan should preserve CLI thread id');
        assert(openAiPlanPayload.plan.cwd === path.join(tmpHome, 'task-plan-workspace'), 'OpenAI Chat plan should preserve CLI cwd');
        assert(openAiPlanPayload.plan.nodes.every((node) => node.kind === 'openai-chat'), 'OpenAI Chat plan should produce OpenAI Chat nodes');

        const openAiRunCwd = path.join(tmpHome, 'task-run-workspace');
        fs.mkdirSync(openAiRunCwd, { recursive: true });
        const openAiRunResult = runSync(node, [
            cliPath,
            'task',
            'run',
            '--target',
            'OpenAI Chat provider CLI 运行链路',
            '--follow-up',
            '输出验证摘要',
            '--engine',
            'openai-chat',
            '--cwd',
            openAiRunCwd,
            '--thread-id',
            'thread-cli-run',
            '--concurrency',
            '2',
            '--json'
        ], { env });
        assert(openAiRunResult.status === 0, `OpenAI Chat task run failed: ${openAiRunResult.stderr || openAiRunResult.stdout}`);
        const openAiRunPayload = parseJsonOutput(openAiRunResult.stdout);
        assertOpenAiRunPayload(openAiRunPayload, 'OpenAI Chat CLI run');
        assert(openAiRunPayload.threadId === 'thread-cli-run', 'OpenAI Chat CLI run should preserve thread id');
        assert(openAiRunPayload.cwd === openAiRunCwd, 'OpenAI Chat CLI run should preserve cwd');

        const openAiLogsResult = runSync(node, [
            cliPath,
            'task',
            'logs',
            openAiRunPayload.runId,
            '--json'
        ], { env });
        assert(openAiLogsResult.status === 0, `OpenAI Chat task logs failed: ${openAiLogsResult.stderr || openAiLogsResult.stdout}`);
        const openAiLogsPayload = parseJsonOutput(openAiLogsResult.stdout);
        assert(String(openAiLogsPayload.logs || '').includes('OpenAI Chat request provider=local-openai-chat'), 'OpenAI Chat logs should include provider request');

        const directPlanPath = path.join(tmpHome, 'task-direct-openai-plan.json');
        const directPlanCwd = path.join(tmpHome, 'task-direct-plan-workspace');
        fs.mkdirSync(directPlanCwd, { recursive: true });
        fs.writeFileSync(directPlanPath, JSON.stringify({
            id: 'task-direct-openai-plan',
            title: 'Direct OpenAI Chat plan',
            target: 'Create index.html for direct OpenAI Chat plan execution',
            notes: 'Write index.html only inside the provided cwd.',
            cwd: directPlanCwd,
            threadId: 'thread-direct-plan',
            engine: 'openai-chat',
            allowWrite: true,
            dryRun: false,
            concurrency: 1,
            nodes: [
                {
                    id: 'direct-openai-node',
                    title: 'Direct OpenAI node',
                    kind: 'openai-chat',
                    prompt: 'Create index.html with a tiny 2048 probe page and return the full file in an html fenced block.',
                    dependsOn: []
                }
            ]
        }, null, 2), 'utf-8');
        const directPlanRunResult = runSync(node, [
            cliPath,
            'task',
            'run',
            '--plan',
            `@${directPlanPath}`,
            '--allow-write',
            '--json'
        ], { env });
        assert(directPlanRunResult.status === 0, `OpenAI Chat direct plan run failed: ${directPlanRunResult.stderr || directPlanRunResult.stdout}`);
        const directPlanRunPayload = parseJsonOutput(directPlanRunResult.stdout);
        assertOpenAiRunPayload(directPlanRunPayload, 'OpenAI Chat direct plan run');
        assert(Array.isArray(directPlanRunPayload.plan && directPlanRunPayload.plan.waves), 'OpenAI Chat direct plan run should compute waves');
        assert(directPlanRunPayload.threadId === 'thread-direct-plan', 'OpenAI Chat direct plan run should preserve plan thread id');
        assert(directPlanRunPayload.cwd === directPlanCwd, 'OpenAI Chat direct plan run should preserve plan cwd');
        const directPlanIndexPath = path.join(directPlanCwd, 'index.html');
        assert(fs.existsSync(directPlanIndexPath), 'OpenAI Chat direct plan run should materialize index.html when allow-write is enabled');
        assert(fs.readFileSync(directPlanIndexPath, 'utf-8').includes('2048'), 'materialized index.html should contain generated page content');
        const materializedFiles = directPlanRunPayload.run.nodes.flatMap(item => item && item.output && Array.isArray(item.output.materializedFiles) ? item.output.materializedFiles : []);
        assert(materializedFiles.some(item => item.relativePath === 'index.html'), 'OpenAI Chat direct plan run should report materialized index.html');

        const openAiQueueAddResult = runSync(node, [
            cliPath,
            'task',
            'queue',
            'add',
            '--target',
            'OpenAI Chat provider CLI 队列链路',
            '--engine',
            'openai-chat',
            '--cwd',
            path.join(tmpHome, 'task-queue-workspace'),
            '--thread-id',
            'thread-cli-queue',
            '--json'
        ], { env });
        assert(openAiQueueAddResult.status === 0, `OpenAI Chat queue add failed: ${openAiQueueAddResult.stderr || openAiQueueAddResult.stdout}`);
        const openAiQueueAddPayload = parseJsonOutput(openAiQueueAddResult.stdout);
        assert(openAiQueueAddPayload.ok === true && openAiQueueAddPayload.task && openAiQueueAddPayload.task.engine === 'openai-chat', 'OpenAI Chat queue add should persist engine');
        assert(openAiQueueAddPayload.task.threadId === 'thread-cli-queue', 'OpenAI Chat queue add should persist thread id');
        assert(openAiQueueAddPayload.task.cwd === path.join(tmpHome, 'task-queue-workspace'), 'OpenAI Chat queue add should persist cwd');

        const openAiQueueStartResult = runSync(node, [
            cliPath,
            'task',
            'queue',
            'start',
            openAiQueueAddPayload.task.taskId,
            '--json'
        ], { env });
        assert(openAiQueueStartResult.status === 0, `OpenAI Chat queue start failed: ${openAiQueueStartResult.stderr || openAiQueueStartResult.stdout}`);
        const openAiQueueStartPayload = parseJsonOutput(openAiQueueStartResult.stdout);
        assert(openAiQueueStartPayload.ok === true, 'OpenAI Chat queue start should succeed');
        assertOpenAiRunPayload(openAiQueueStartPayload.detail, 'OpenAI Chat CLI queue start');
        assert(openAiQueueStartPayload.detail.threadId === 'thread-cli-queue', 'OpenAI Chat queue start should preserve thread id');
        assert(openAiQueueStartPayload.detail.cwd === path.join(tmpHome, 'task-queue-workspace'), 'OpenAI Chat queue start should preserve cwd');

        const apiOpenAiPlan = await api('task-plan', {
            target: 'OpenAI Chat Web API 计划链路',
            engine: 'openai-chat',
            cwd: path.join(tmpHome, 'api-plan-workspace'),
            threadId: 'thread-api-plan',
            followUps: ['输出结论']
        });
        assert(apiOpenAiPlan.ok === true, 'OpenAI Chat task-plan API should validate');
        assert(apiOpenAiPlan.plan && apiOpenAiPlan.plan.engine === 'openai-chat', 'OpenAI Chat task-plan API should keep engine');
        assert(apiOpenAiPlan.plan.threadId === 'thread-api-plan', 'OpenAI Chat task-plan API should preserve thread id');
        assert(apiOpenAiPlan.plan.cwd === path.join(tmpHome, 'api-plan-workspace'), 'OpenAI Chat task-plan API should preserve cwd');
        assert(apiOpenAiPlan.plan.nodes.every((node) => node.kind === 'openai-chat'), 'OpenAI Chat task-plan API should produce OpenAI Chat nodes');

        const apiRunCwd = path.join(tmpHome, 'api-run-workspace');
        fs.mkdirSync(apiRunCwd, { recursive: true });
        const apiOpenAiRun = await api('task-run', {
            target: 'OpenAI Chat Web API 同步运行链路',
            engine: 'openai-chat',
            cwd: apiRunCwd,
            threadId: 'thread-api-run',
            concurrency: 1
        }, 15000);
        assertOpenAiRunPayload(apiOpenAiRun, 'OpenAI Chat API run');
        assert(apiOpenAiRun.threadId === 'thread-api-run', 'OpenAI Chat API run should preserve thread id');
        assert(apiOpenAiRun.cwd === apiRunCwd, 'OpenAI Chat API run should preserve cwd');

        const apiOpenAiDetail = await api('task-run-detail', { runId: apiOpenAiRun.runId });
        assert(apiOpenAiDetail && apiOpenAiDetail.run && apiOpenAiDetail.run.status === 'success', 'OpenAI Chat task-run-detail API should return run detail');
        assert(apiOpenAiDetail.threadId === 'thread-api-run', 'OpenAI Chat task-run-detail API should expose thread id');
        assert(apiOpenAiDetail.cwd === apiRunCwd, 'OpenAI Chat task-run-detail API should expose cwd');
        assert(apiOpenAiDetail.run.nodes.every((node) => node.kind === 'openai-chat'), 'OpenAI Chat task-run-detail API should expose OpenAI Chat nodes');

        const apiOpenAiQueueAdd = await api('task-queue-add', {
            target: 'OpenAI Chat Web API 队列链路',
            engine: 'openai-chat',
            cwd: path.join(tmpHome, 'api-queue-workspace'),
            threadId: 'thread-api-queue'
        });
        assert(apiOpenAiQueueAdd.ok === true && apiOpenAiQueueAdd.task && apiOpenAiQueueAdd.task.engine === 'openai-chat', 'OpenAI Chat task-queue-add API should persist engine');
        assert(apiOpenAiQueueAdd.task.threadId === 'thread-api-queue', 'OpenAI Chat task-queue-add API should persist thread id');
        assert(apiOpenAiQueueAdd.task.cwd === path.join(tmpHome, 'api-queue-workspace'), 'OpenAI Chat task-queue-add API should persist cwd');
        const apiOpenAiQueueStart = await api('task-queue-start', {
            taskId: apiOpenAiQueueAdd.task.taskId,
            detach: false
        }, 15000);
        assert(apiOpenAiQueueStart.ok === true, 'OpenAI Chat task-queue-start API should succeed');
        assertOpenAiRunPayload(apiOpenAiQueueStart.detail, 'OpenAI Chat API queue start');
        assert(apiOpenAiQueueStart.detail.threadId === 'thread-api-queue', 'OpenAI Chat task-queue-start API should preserve thread id');
        assert(apiOpenAiQueueStart.detail.cwd === path.join(tmpHome, 'api-queue-workspace'), 'OpenAI Chat task-queue-start API should preserve cwd');

        const apiOpenAiOverview = await api('task-overview');
        assert(Array.isArray(apiOpenAiOverview.runs), 'OpenAI Chat task-overview API should return runs after execution');
        assert(apiOpenAiOverview.runs.some((item) => item.runId === apiOpenAiRun.runId), 'OpenAI Chat task-overview API should include API run');

        assertOpenAiRequests(openAiMock, 6, 'OpenAI Chat full chain');
    } finally {
        await openAiMock.close();
    }

    const missingQueueStartResult = runSync(node, [
        cliPath,
        'task',
        'queue',
        'start',
        'missing-task',
        '--json'
    ], { env });
    assert(missingQueueStartResult.status !== 0, 'task queue start should fail for missing task');
    const missingQueueStartPayload = parseJsonOutput(missingQueueStartResult.stdout);
    assert(typeof missingQueueStartPayload.error === 'string' && missingQueueStartPayload.error.includes('task not found'), 'missing task queue start should report not found');

    const invalidRunIdResult = runSync(node, [
        cliPath,
        'task',
        'run',
        '--target',
        '诊断当前配置',
        '--workflow-id',
        'diagnose-config',
        '--engine',
        'workflow',
        '--run-id',
        '../escaped-run',
        '--json'
    ], { env });
    assert(invalidRunIdResult.status !== 0, 'task run should reject unsafe run ids');
    const invalidRunIdPayload = parseJsonOutput(invalidRunIdResult.stdout);
    assert(typeof invalidRunIdPayload.error === 'string' && invalidRunIdPayload.error.includes('unsupported characters'), 'unsafe run id should report validation error');

    const apiRetry = await api('task-retry', {
        runId: apiQueueStart.detail.runId,
        detach: false
    });
    assert(apiRetry && apiRetry.run && apiRetry.run.status === 'success', 'task-retry API should rerun task');

    const apiLogs = await api('task-logs', { runId: apiRetry.runId });
    assert(typeof apiLogs.logs === 'string', 'task-logs API should return logs');

    const apiCancelQueued = await api('task-queue-add', {
        target: '待取消任务',
        workflowIds: ['diagnose-config'],
        engine: 'workflow'
    });
    assert(apiCancelQueued.ok === true, 'second task-queue-add API should succeed');
    const apiCancel = await api('task-cancel', { taskId: apiCancelQueued.task.taskId });
    assert(apiCancel.ok === true, 'task-cancel API should cancel queued task');
    const canceledTask = await api('task-queue-show', { taskId: apiCancelQueued.task.taskId });
    assert(canceledTask && canceledTask.status === 'cancelled', 'task-cancel API should mark queued task as cancelled');
};
