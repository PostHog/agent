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
        agent,
    } = context;

    const latestRun = task.latest_run;
    const prExists =
        latestRun?.output && typeof latestRun.output === 'object'
            ? (latestRun.output as any).pr_url
            : null;

    if (prExists) {
        logger.info('PR already exists, skipping build phase', { taskId: task.id });
        return { status: 'skipped' };
    }

    agent.notifyPhaseStart('build', { taskId: task.id });

    const executionPrompt = await promptBuilder.buildExecutionPrompt(task, cwd);

    // Track commits made during Claude Code execution
    const commitTracker = await gitManager.trackCommitsDuring();

    await runACPStep({
        context,
        systemPrompt: EXECUTION_SYSTEM_PROMPT,
        prompt: executionPrompt,
    });

    // Finalize: commit any remaining changes and optionally push
    const { commitCreated, pushedBranch } = await commitTracker.finalize({
        commitMessage: `Implementation for ${task.title}`,
        push: step.push,
    });

    context.stepResults[step.id] = { commitCreated };

    if (!commitCreated) {
        logger.warn('No changes to commit in build phase', { taskId: task.id });
    } else {
        logger.info('Build commits finalized', {
            taskId: task.id,
            pushedBranch
        });
    }

    agent.notifyPhaseComplete('build');
    return { status: 'completed' };
};
