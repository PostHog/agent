import { EXECUTION_SYSTEM_PROMPT } from '../../agents/execution.js';
import { PermissionMode } from '../../types.js';
import type { WorkflowStepRunner } from '../types.js';
import { runACPStep } from '../acp-helpers.js';

export const buildStep: WorkflowStepRunner = async ({ step, context }) => {
    const {
        task,
        cwd,
        logger,
        promptBuilder,
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
    emitEvent({ method: '_posthog/status', params: { type: 'phase_start', _meta: { phase: 'build' } } });

    const executionPrompt = await promptBuilder.buildExecutionPrompt(task, cwd);
    const fullPrompt = `${EXECUTION_SYSTEM_PROMPT}\n\n${executionPrompt}`;

    // Track commits made during Claude Code execution
    const commitTracker = await gitManager.trackCommitsDuring();

    await runACPStep({
        logger,
        cwd,
        mcpServers,
        prompt: fullPrompt,
        onSessionUpdate: (notification) => {
            stepLogger.debug('Session update', { type: notification.update.sessionUpdate });
            emitEvent(notification);
        },
        currentWrapper: context.currentWrapper,
    });

    // Finalize: commit any remaining changes and optionally push
    const { commitCreated, pushedBranch } = await commitTracker.finalize({
        commitMessage: `Implementation for ${task.title}`,
        push: step.push,
    });

    context.stepResults[step.id] = { commitCreated };

    if (!commitCreated) {
        stepLogger.warn('No changes to commit in build phase', { taskId: task.id });
    } else {
        stepLogger.info('Build commits finalized', {
            taskId: task.id,
            pushedBranch
        });
    }

    emitEvent({ method: '_posthog/status', params: { type: 'phase_complete', _meta: { phase: 'build' } } });
    return { status: 'completed' };
};
