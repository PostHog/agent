import { PLANNING_SYSTEM_PROMPT } from '../../agents/planning.js';
import type { WorkflowStepRunner } from '../types.js';
import { finalizeStepGitActions } from '../utils.js';
import { runACPStep } from '../acp-helpers.js';

export const planStep: WorkflowStepRunner = async ({ step, context }) => {
    const {
        task,
        cwd,
        isCloudMode,
        logger,
        fileManager,
        gitManager,
        promptBuilder,
        mcpServers,
        agent,
    } = context;

    const existingPlan = await fileManager.readPlan(task.id);
    if (existingPlan) {
        logger.info('Plan already exists, skipping step', { taskId: task.id });
        return { status: 'skipped' };
    }

    const questionsData = await fileManager.readQuestions(task.id);
    if (!questionsData || !questionsData.answered) {
        logger.info('Waiting for answered research questions', { taskId: task.id });
        agent.notifyPhaseComplete('research_questions');
        return { status: 'skipped', halt: true };
    }

    agent.notifyPhaseStart('planning', { taskId: task.id });

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

    const planContent = await runACPStep({
        context,
        systemPrompt: PLANNING_SYSTEM_PROMPT,
        prompt: `${planningPrompt}\n\n${researchContext}`,
    });

    if (planContent.trim()) {
        await fileManager.writePlan(task.id, planContent.trim());
        logger.info('Plan completed', { taskId: task.id });
    }

    await gitManager.addAllPostHogFiles();
    await finalizeStepGitActions(context, step, {
        commitMessage: `Planning phase for ${task.title}`,
    });

    if (!isCloudMode) {
        agent.notifyPhaseComplete('planning');
        return { status: 'completed', halt: true };
    }

    agent.notifyPhaseComplete('planning');
    return { status: 'completed' };
};
