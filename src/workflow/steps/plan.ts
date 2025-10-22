import { query } from '@anthropic-ai/claude-agent-sdk';
import { PLANNING_SYSTEM_PROMPT } from '../../agents/planning.js';
import type { WorkflowStepRunner } from '../types.js';
import { finalizeStepGitActions } from '../utils.js';

export const planStep: WorkflowStepRunner = async ({ step, context }) => {
    const {
        task,
        cwd,
        isCloudMode,
        options,
        logger,
        fileManager,
        gitManager,
        promptBuilder,
        adapter,
        mcpServers,
        emitEvent,
    } = context;

    const stepLogger = logger.child('PlanStep');

    const existingPlan = await fileManager.readPlan(task.id);
    if (existingPlan) {
        stepLogger.info('Plan already exists, skipping step', { taskId: task.id });
        return { status: 'skipped' };
    }

    const questionsData = await fileManager.readQuestions(task.id);
    if (!questionsData || !questionsData.answered) {
        stepLogger.info('Waiting for answered research questions', { taskId: task.id });
        emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'research_questions' }));
        return { status: 'skipped', halt: true };
    }

    stepLogger.info('Starting planning phase', { taskId: task.id });
    emitEvent(adapter.createStatusEvent('phase_start', { phase: 'planning' }));

    const researchContent = await fileManager.readResearch(task.id);
    let researchContext = '';
    if (researchContent) {
        researchContext += `## Research Analysis\n\n${researchContent}\n\n`;
    }

    researchContext += `## Implementation Decisions\n\n`;
    for (const question of questionsData.questions) {
        const answer = questionsData.answers?.find(
            (a: any) => a.questionId === question.id
        );

        researchContext += `### ${question.question}\n\n`;
        if (answer) {
            researchContext += `**Selected:** ${answer.selectedOption}\n`;
            if (answer.customInput) {
                researchContext += `**Details:** ${answer.customInput}\n`;
            }
        } else {
            researchContext += `**Selected:** Not answered\n`;
        }
        researchContext += `\n`;
    }

    const planningPrompt = await promptBuilder.buildPlanningPrompt(task, cwd);
    const fullPrompt = `${PLANNING_SYSTEM_PROMPT}\n\n${planningPrompt}\n\n${researchContext}`;

    const baseOptions: Record<string, any> = {
        model: step.model,
        cwd,
        permissionMode: 'plan',
        settingSources: ['local'],
        mcpServers,
    };

    const response = query({
        prompt: fullPrompt,
        options: { ...baseOptions, ...(options.queryOverrides || {}) },
    });

    let planContent = '';
    for await (const message of response) {
        emitEvent(adapter.createRawSDKEvent(message));
        const transformed = adapter.transform(message);
        if (transformed) {
            emitEvent(transformed);
        }
        if (message.type === 'assistant' && message.message?.content) {
            for (const c of message.message.content) {
                if (c.type === 'text' && c.text) {
                    planContent += `${c.text}\n`;
                }
            }
        }
    }

    if (planContent.trim()) {
        await fileManager.writePlan(task.id, planContent.trim());
        stepLogger.info('Plan completed', { taskId: task.id });
    }

    await gitManager.addAllPostHogFiles();
    await finalizeStepGitActions(context, step, {
        commitMessage: `Planning phase for ${task.title}`,
    });

    if (!isCloudMode) {
        emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'planning' }));
        return { status: 'completed', halt: true };
    }

    emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'planning' }));
    return { status: 'completed' };
};
