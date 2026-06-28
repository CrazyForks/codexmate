function normalizeTaskDraftLines(text) {
    return String(text || '')
        .split(/\r?\n/g)
        .map((item) => item.trim())
        .filter(Boolean);
}

function readTaskOrchestrationDraftMetrics(taskOrchestration) {
    const state = taskOrchestration && typeof taskOrchestration === 'object' ? taskOrchestration : {};
    const target = String(state.target || '').trim();
    const notes = String(state.notes || '').trim();
    const title = String(state.title || '').trim();
    const workflowIds = normalizeTaskDraftLines(state.workflowIdsText);
    const followUps = normalizeTaskDraftLines(state.followUpsText);
    const requestCount = target ? followUps.length + 1 : 0;
    const engine = String(state.selectedEngine || 'openai-chat').trim().toLowerCase() === 'workflow' ? 'workflow' : 'openai-chat';
    const runMode = String(state.runMode || 'write').trim().toLowerCase();
    const allowWrite = runMode === 'write';
    const dryRun = runMode === 'dry-run';
    const plan = state.plan && typeof state.plan === 'object' ? state.plan : null;
    const planNodes = Array.isArray(plan && plan.nodes) ? plan.nodes : [];
    const planIssues = Array.isArray(state.planIssues) ? state.planIssues : [];
    const planWarnings = Array.isArray(state.planWarnings) ? state.planWarnings : [];
    return {
        engine,
        runMode,
        title,
        target,
        notes,
        workflowIds,
        followUps,
        hasTarget: target.length > 0,
        hasNotes: notes.length > 0,
        hasTitle: title.length > 0,
        hasPlan: !!plan,
        planNodes,
        planIssues,
        planWarnings,
        workflowCount: workflowIds.length,
        followUpCount: followUps.length,
        requestCount,
        hasSequentialFollowUps: followUps.length > 0,
        planNodeCount: planNodes.length,
        allowWrite,
        dryRun
    };
}


function formatTaskConversationMeta(items) {
    return items.filter(Boolean).join(' · ');
}

function createTaskConversationMessages(taskOrchestration, t = null) {
    const state = taskOrchestration && typeof taskOrchestration === 'object' ? taskOrchestration : {};
    const messages = [];
    const target = String(state.target || '').trim();
    const followUps = normalizeTaskDraftLines(state.followUpsText);
    const detail = state.selectedRunDetail && typeof state.selectedRunDetail === 'object' ? state.selectedRunDetail : null;
    const detailRun = detail && detail.run && typeof detail.run === 'object' ? detail.run : null;
    if (detail) {
        messages.push({
            id: 'context-run',
            role: 'assistant',
            label: translateTaskText(t, 'orchestration.chat.assistant.contextLabel', '上一轮上下文'),
            text: detailRun && detailRun.summary
                ? detailRun.summary
                : translateTaskText(t, 'orchestration.chat.assistant.contextFallback', '已选中一个历史任务，继续时会继承它的线程和工作区。'),
            meta: formatTaskConversationMeta([
                detail.threadId ? translateTaskText(t, 'orchestration.chat.meta.thread', `线程 ${detail.threadId}`, { value: detail.threadId }) : '',
                detail.cwd ? translateTaskText(t, 'orchestration.chat.meta.workspace', `工作区 ${detail.cwd}`, { value: detail.cwd }) : '',
                detailRun && detailRun.status ? detailRun.status : ''
            ])
        });
    } else if (!target && followUps.length === 0) {
        messages.push({
            id: 'assistant-empty',
            role: 'assistant',
            label: translateTaskText(t, 'orchestration.chat.assistant.readyLabel', 'Codexmate'),
            text: translateTaskText(t, 'orchestration.chat.assistant.empty', '先发第一个需求；如果还有第二个需求，继续发送，Codexmate 会按顺序处理并保留上下文。'),
            meta: translateTaskText(t, 'orchestration.chat.meta.order', '顺序执行 · 保留上下文')
        });
    }
    if (target) {
        messages.push({
            id: 'user-target',
            role: 'user',
            label: translateTaskText(t, 'orchestration.chat.user.step', '需求 {count}', { count: 1 }),
            text: target,
            meta: translateTaskText(t, 'orchestration.chat.meta.first', '先完成这一条')
        });
    }
    followUps.forEach((item, index) => {
        const step = index + 2;
        messages.push({
            id: `user-follow-up-${index}`,
            role: 'user',
            label: translateTaskText(t, 'orchestration.chat.user.step', '需求 {count}', { count: step }),
            text: item,
            meta: translateTaskText(t, 'orchestration.chat.meta.afterPrevious', '等待前一条完成后继续')
        });
    });
    if (state.plan && typeof state.plan === 'object') {
        const nodeCount = Array.isArray(state.plan.nodes) ? state.plan.nodes.length : 0;
        const waveCount = Array.isArray(state.plan.waves) ? state.plan.waves.length : 0;
        messages.push({
            id: 'assistant-plan',
            role: 'assistant',
            label: translateTaskText(t, 'orchestration.chat.assistant.planLabel', '计划预览'),
            text: translateTaskText(t, 'orchestration.chat.assistant.planSummary', '计划已生成：{nodes} 个节点，{waves} 个批次。', { nodes: nodeCount, waves: waveCount }),
            meta: translateTaskText(t, 'orchestration.chat.meta.contextKept', '上下文会随线程保留')
        });
    } else if (target) {
        messages.push({
            id: 'assistant-next',
            role: 'assistant',
            label: translateTaskText(t, 'orchestration.chat.assistant.readyLabel', 'Codexmate'),
            text: followUps.length > 0
                ? translateTaskText(t, 'orchestration.chat.assistant.sequenceReady', '已收到多条需求；执行时会先完成需求 1，再带着上下文继续后续需求。')
                : translateTaskText(t, 'orchestration.chat.assistant.singleReady', '已收到第一条需求。可以继续补需求 2，或直接预览并执行。'),
            meta: translateTaskText(t, 'orchestration.chat.meta.previewNext', '下一步：预览计划')
        });
    }
    return messages;
}

function translateTaskText(t, key, fallback, params = null) {
    if (typeof t !== 'function') return fallback;
    const translated = t(key, params);
    return translated === key ? fallback : translated;
}

function createTaskDraftChecklist(metrics, t = null) {
    const workflowReady = metrics.engine !== 'workflow' || metrics.workflowCount > 0;
    const scopeReady = metrics.hasNotes || !metrics.allowWrite;
    const previewReady = metrics.hasPlan && metrics.planIssues.length === 0;
    return [
        {
            key: 'target',
            label: translateTaskText(t, 'orchestration.readiness.target.label', '目标'),
            done: metrics.hasTarget,
            detail: metrics.hasTarget ? translateTaskText(t, 'orchestration.readiness.target.done', '已写目标') : translateTaskText(t, 'orchestration.readiness.target.missing', '还没写目标')
        },
        {
            key: 'sequence',
            label: translateTaskText(t, 'orchestration.readiness.sequence.label', '顺序'),
            done: metrics.hasTarget,
            detail: !metrics.hasTarget
                ? translateTaskText(t, 'orchestration.readiness.sequence.missing', '先发送需求 1')
                : (metrics.hasSequentialFollowUps
                    ? translateTaskText(t, 'orchestration.readiness.sequence.multiple', '{count} 条需求会按顺序执行：先完成需求 1，再继续需求 2。', { count: metrics.requestCount })
                    : translateTaskText(t, 'orchestration.readiness.sequence.single', '当前只有需求 1；继续发送会变成需求 2。'))
        },
        {
            key: 'engine',
            label: metrics.engine === 'workflow' ? 'Workflow' : translateTaskText(t, 'orchestration.readiness.engine.label', '执行策略'),
            done: workflowReady,
            detail: metrics.engine === 'workflow'
                ? (metrics.workflowCount > 0 ? translateTaskText(t, 'orchestration.readiness.workflow.done', `已选 ${metrics.workflowCount} 个 Workflow`, { count: metrics.workflowCount }) : translateTaskText(t, 'orchestration.readiness.workflow.missing', '还没选 Workflow ID'))
                : translateTaskText(t, 'orchestration.readiness.engine.openaiChat', '使用 OpenAI Chat-compatible 节点')
        },
        {
            key: 'scope',
            label: translateTaskText(t, 'orchestration.readiness.scope.label', '边界'),
            done: scopeReady,
            detail: metrics.hasNotes
                ? translateTaskText(t, 'orchestration.readiness.scope.done', '已补充说明')
                : (metrics.allowWrite ? translateTaskText(t, 'orchestration.readiness.scope.writeHint', '建议补说明后再写入') : translateTaskText(t, 'orchestration.readiness.scope.readonlyHint', '当前是只读，可直接试'))
        },
        {
            key: 'preview',
            label: translateTaskText(t, 'orchestration.readiness.preview.label', '预览'),
            done: previewReady,
            detail: !metrics.hasPlan
                ? translateTaskText(t, 'orchestration.readiness.preview.missing', '还没生成计划')
                : (metrics.planIssues.length > 0 ? translateTaskText(t, 'orchestration.readiness.preview.blocked', `有 ${metrics.planIssues.length} 个阻塞项`, { count: metrics.planIssues.length }) : translateTaskText(t, 'orchestration.readiness.preview.ready', `计划可用，${metrics.planNodeCount} 个节点`, { count: metrics.planNodeCount }))
        }
    ];
}

function createTaskDraftReadiness(metrics, t = null) {
    if (!metrics.hasTarget) {
        return {
            tone: 'neutral',
            title: translateTaskText(t, 'orchestration.readiness.empty.title', '先写目标'),
            summary: translateTaskText(t, 'orchestration.readiness.empty.summary', '先把想完成的结果写清楚，再让编排器拆节点。')
        };
    }
    if (metrics.engine === 'workflow' && metrics.workflowCount === 0) {
        return {
            tone: 'warn',
            title: translateTaskText(t, 'orchestration.readiness.workflow.title', '缺少 Workflow'),
            summary: translateTaskText(t, 'orchestration.readiness.workflow.summary', '你已经选了 Workflow 模式，但还没指定可复用流程。')
        };
    }
    if (!metrics.hasPlan) {
        return {
            tone: 'warn',
            title: translateTaskText(t, 'orchestration.readiness.preview.title', '建议先预览'),
            summary: metrics.hasSequentialFollowUps
                ? translateTaskText(t, 'orchestration.readiness.preview.sequenceSummary', '草稿已成形，已锁定 {count} 条顺序需求：先完成需求 1，再继续需求 2。', { count: metrics.requestCount })
                : translateTaskText(t, 'orchestration.readiness.preview.summary', '草稿已成形，先生成一次计划，确认节点和依赖再执行。')
        };
    }
    if (metrics.planIssues.length > 0) {
        return {
            tone: 'error',
            title: translateTaskText(t, 'orchestration.readiness.blocked.title', '预览有阻塞'),
            summary: translateTaskText(t, 'orchestration.readiness.blocked.summary', `当前计划里还有 ${metrics.planIssues.length} 个阻塞项，先处理它们。`, { count: metrics.planIssues.length })
        };
    }
    if (metrics.planWarnings.length > 0) {
        return {
            tone: 'warn',
            title: translateTaskText(t, 'orchestration.readiness.warn.title', '可以执行，但有提醒'),
            summary: translateTaskText(t, 'orchestration.readiness.warn.summary', `计划已生成，但还有 ${metrics.planWarnings.length} 条提醒值得先看一眼。`, { count: metrics.planWarnings.length })
        };
    }
    if (metrics.dryRun) {
        return {
            tone: 'success',
            title: translateTaskText(t, 'orchestration.readiness.dryRun.title', '适合先预演'),
            summary: translateTaskText(t, 'orchestration.readiness.dryRun.summary', '现在可以安全地跑一次仅预演，先看结果再决定是否真实执行。')
        };
    }
    return {
        tone: 'success',
        title: translateTaskText(t, 'orchestration.readiness.ready.title', '可以执行'),
        summary: metrics.followUpCount > 0
            ? translateTaskText(t, 'orchestration.readiness.ready.withFollowUps', `已锁定 ${metrics.requestCount} 条顺序需求：先完成需求 1，再带上下文继续需求 2。`, { count: metrics.requestCount })
            : translateTaskText(t, 'orchestration.readiness.ready.summary', '主目标已经够清楚了，可以直接执行或入队。')
    };
}

export function createMainTabsComputed() {
    return {
        mainTabKicker() {
            if (this.mainTab === 'dashboard') return this.t('kicker.dashboard');
            if (this.mainTab === 'config') return this.t('kicker.config');
            if (this.mainTab === 'sessions') return this.t('kicker.sessions');
            if (this.mainTab === 'usage') return this.t('kicker.usage');
            if (this.mainTab === 'orchestration') return this.t('kicker.orchestration');
            if (this.mainTab === 'market') return this.t('kicker.market');
            if (this.mainTab === 'plugins') return this.t('kicker.plugins');
            if (this.mainTab === 'docs') return this.t('kicker.docs');
            if (this.mainTab === 'trash') return this.t('kicker.trash');
            if (this.mainTab === 'prompts') return this.t('kicker.prompts');
            return this.t('kicker.settings');
        },
        mainTabTitle() {
            if (this.mainTab === 'dashboard') return this.t('title.dashboard');
            if (this.mainTab === 'config') return this.t('title.config');
            if (this.mainTab === 'sessions') return this.t('title.sessions');
            if (this.mainTab === 'usage') return this.t('title.usage');
            if (this.mainTab === 'orchestration') return this.t('title.orchestration');
            if (this.mainTab === 'market') return this.t('title.market');
            if (this.mainTab === 'plugins') return this.t('title.plugins');
            if (this.mainTab === 'docs') return this.t('title.docs');
            if (this.mainTab === 'trash') return this.t('settings.trash.title');
            if (this.mainTab === 'prompts') return this.t('title.prompts');
            return this.t('title.settings');
        },
        mainTabSubtitle() {
            if (this.mainTab === 'dashboard') return this.t('subtitle.dashboard');
            if (this.mainTab === 'config') return this.t('subtitle.config');
            if (this.mainTab === 'sessions') return this.t('subtitle.sessions');
            if (this.mainTab === 'usage') return this.t('subtitle.usage');
            if (this.mainTab === 'orchestration') return this.t('subtitle.orchestration');
            if (this.mainTab === 'market') return this.t('subtitle.market');
            if (this.mainTab === 'plugins') return this.t('subtitle.plugins');
            if (this.mainTab === 'docs') return this.t('subtitle.docs');
            if (this.mainTab === 'trash') return this.t('settings.trash.meta');
            if (this.mainTab === 'prompts') return this.t('subtitle.prompts');
            return this.t('subtitle.settings');
        },
        taskOrchestrationSelectedRun() {
            return this.taskOrchestration && this.taskOrchestration.selectedRunDetail
                ? this.taskOrchestration.selectedRunDetail
                : null;
        },
        taskOrchestrationSelectedRunNodes() {
            const detail = this.taskOrchestrationSelectedRun;
            const run = detail && detail.run && typeof detail.run === 'object' ? detail.run : {};
            if (detail && Array.isArray(detail.nodes)) return detail.nodes;
            return Array.isArray(run.nodes) ? run.nodes : [];
        },
        taskOrchestrationActiveQueue() {
            const queue = this.taskOrchestration && Array.isArray(this.taskOrchestration.queue)
                ? this.taskOrchestration.queue
                : [];
            return queue.filter((item) => {
                const status = String((item && (item.status || item.runStatus)) || '').trim().toLowerCase();
                return status === 'queued' || status === 'running';
            });
        },
        taskOrchestrationQueueStats() {
            const queue = this.taskOrchestration && Array.isArray(this.taskOrchestration.queue)
                ? this.taskOrchestration.queue
                : [];
            const stats = { queued: 0, running: 0, failed: 0 };
            for (const item of queue) {
                const status = String((item && (item.status || item.runStatus)) || '').trim().toLowerCase();
                if (status === 'queued') stats.queued += 1;
                else if (status === 'running') stats.running += 1;
                else if (status === 'failed') stats.failed += 1;
            }
            return stats;
        },
        taskOrchestrationDraftMetrics() {
            return readTaskOrchestrationDraftMetrics(this.taskOrchestration);
        },
        taskOrchestrationDraftChecklist() {
            return createTaskDraftChecklist(this.taskOrchestrationDraftMetrics, this.t && this.t.bind(this));
        },
        taskOrchestrationDraftReadiness() {
            return createTaskDraftReadiness(this.taskOrchestrationDraftMetrics, this.t && this.t.bind(this));
        },
        taskOrchestrationConversationMessages() {
            return createTaskConversationMessages(this.taskOrchestration, this.t && this.t.bind(this));
        }
    };
}
