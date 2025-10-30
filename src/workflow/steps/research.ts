import { RESEARCH_SYSTEM_PROMPT } from '../../agents/research.js';
import type { ExtractedQuestionWithAnswer } from '../../structured-extraction.js';
import type { WorkflowStepRunner } from '../types.js';
import { finalizeStepGitActions } from '../utils.js';
import { runACPStep } from '../acp-helpers.js';

export const researchStep: WorkflowStepRunner = async ({ step, context }) => {
    const {
        task,
        cwd,
        isCloudMode,
        logger,
        fileManager,
        gitManager,
        promptBuilder,
        mcpServers,
        extractor,
        agent, // Only needed for one special notification
    } = context;

    const existingResearch = await fileManager.readResearch(task.id);
    if (existingResearch) {
        logger.info('Research already exists, skipping step', { taskId: task.id });
        return { status: 'skipped' };
    }

    agent.notifyPhaseStart('research', { taskId: task.id });

    const researchPrompt = await promptBuilder.buildResearchPrompt(task, cwd);
    logger.debug('DEBUG: Research prompt being sent', {
        promptLength: researchPrompt.length,
        promptPreview: researchPrompt.substring(0, 500)
    });

    const researchContent = await runACPStep({
        context,
        systemPrompt: RESEARCH_SYSTEM_PROMPT,
        prompt: researchPrompt,
    });

    if (researchContent.trim()) {
        await fileManager.writeResearch(task.id, researchContent.trim());
        logger.info('Research completed', { taskId: task.id });
    }

    await gitManager.addAllPostHogFiles();
    await finalizeStepGitActions(context, step, {
        commitMessage: `Research phase for ${task.title}`,
    });

    if (extractor && researchContent.trim()) {
        try {
            logger.info('Extracting questions from research.md', { taskId: task.id });
            const parsedQuestions = await extractor.extractQuestions(researchContent);

            await fileManager.writeQuestions(task.id, {
                questions: parsedQuestions,
                answered: false,
                answers: null,
            });

            agent.notifyArtifact('research_questions', parsedQuestions);

            logger.info('Questions extracted successfully', {
                taskId: task.id,
                count: parsedQuestions.length,
            });
        } catch (error) {
            agent.notifyError('extraction_error', 'Failed to extract questions', error);
        }
    } else if (!extractor) {
        logger.warn(
            'Question extractor not available, skipping question extraction. Ensure LLM gateway is configured.'
        );
        agent.sendPostHogNotification('status', 'extraction_skipped', {
            message: 'Question extraction skipped - extractor not configured'
        });
    }

    if (!isCloudMode) {
        agent.notifyPhaseComplete('research');
        return { status: 'completed', halt: true };
    }

    const questionsData = await fileManager.readQuestions(task.id);
    if (questionsData && !questionsData.answered && extractor && researchContent.trim()) {
        const researchQuestions = await extractor.extractQuestionsWithAnswers(researchContent);
        const answers = (researchQuestions as ExtractedQuestionWithAnswer[]).map((qa) => ({
            questionId: qa.id,
            selectedOption: qa.recommendedAnswer,
            customInput: qa.justification,
        }));

        await fileManager.writeQuestions(task.id, {
            questions: researchQuestions.map((qa) => ({
                id: qa.id,
                question: qa.question,
                options: qa.options,
            })),
            answered: true,
            answers,
        });

        await gitManager.addAllPostHogFiles();
        await finalizeStepGitActions(context, step, {
            commitMessage: `Answer research questions for ${task.title}`,
        });
        logger.info('Auto-answered research questions', { taskId: task.id });
    }

    agent.notifyPhaseComplete('research');
    return { status: 'completed' };
};
