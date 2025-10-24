import { query } from '@anthropic-ai/claude-agent-sdk';
import { EXECUTION_SYSTEM_PROMPT } from '../../agents/execution.js';
import { PermissionMode } from '../../types.js';
import type { WorkflowStepRunner } from '../types.js';
import { finalizeStepGitActions } from '../utils.js';

export const buildStep: WorkflowStepRunner = async ({ step, context }) => {
    const {
        task,
        cwd,
        options,
        logger,
        promptBuilder,
        adapter,
        mcpServers,
        gitManager,
        emitEvent,
    } = context;

    const stepLogger = logger.child('BuildStep');

    const latestRun = task.latest_run;
    const prExists =
        latestRun?.output && typeof latestRun.output === 'object'
            ? (latestRun.output as any).pr_url
            : null;

    if (prExists) {
        stepLogger.info('PR already exists, skipping build phase', { taskId: task.id });
        return { status: 'skipped' };
    }

    stepLogger.info('Starting build phase', { taskId: task.id });
    emitEvent(adapter.createStatusEvent('phase_start', { phase: 'build' }));

    const executionPrompt = await promptBuilder.buildExecutionPrompt(task, cwd);
    const fullPrompt = `${EXECUTION_SYSTEM_PROMPT}\n\n${executionPrompt}`;

    const configuredPermissionMode =
        options.permissionMode ??
        (typeof step.permissionMode === 'string'
            ? (step.permissionMode as PermissionMode)
            : step.permissionMode) ??
        PermissionMode.ACCEPT_EDITS;

    const baseOptions: Record<string, any> = {
        model: step.model,
        cwd,
        permissionMode: configuredPermissionMode,
        settingSources: ['local'],
        mcpServers,
        // Allow all tools for build phase - full read/write access needed for implementation
        allowedTools: [
            'Task',
            'Bash',
            'BashOutput',
            'KillBash',
            'Edit',
            'Read',
            'Write',
            'Glob',
            'Grep',
            'NotebookEdit',
            'WebFetch',
            'WebSearch',
            'ListMcpResources',
            'ReadMcpResource',
            'TodoWrite',
        ],
    };

    // Add fine-grained permission hook if provided
    if (options.canUseTool) {
        baseOptions.canUseTool = options.canUseTool;
    }

    const response = query({
        prompt: fullPrompt,
        options: { ...baseOptions, ...(options.queryOverrides || {}) },
    });

    for await (const message of response) {
        emitEvent(adapter.createRawSDKEvent(message));
        const transformed = adapter.transform(message);
        if (transformed) {
            emitEvent(transformed);
        }
    }

    const hasChanges = await gitManager.hasChanges();
    context.stepResults[step.id] = { commitCreated: false };
    if (!hasChanges) {
        stepLogger.warn('No changes to commit in build phase', { taskId: task.id });
        emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'build' }));
        return { status: 'completed' };
    }

    await gitManager.addFiles(['.']);
    const commitCreated = await finalizeStepGitActions(context, step, {
        commitMessage: `Implementation for ${task.title}`,
    });
    context.stepResults[step.id] = { commitCreated };

    if (!commitCreated) {
        stepLogger.warn('No commit created during build step', { taskId: task.id });
    }

    emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'build' }));
    return { status: 'completed' };
};
