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
        emitEvent,
    } = context;

    const stepLogger = logger.child('ResearchStep');

    const existingResearch = await fileManager.readResearch(task.id);
    if (existingResearch) {
        stepLogger.info('Research already exists, skipping step', { taskId: task.id });
        return { status: 'skipped' };
    }

    stepLogger.info('Starting research phase', { taskId: task.id });
    emitEvent({ method: '_posthog/status', params: { type: 'phase_start', _meta: { phase: 'research' } } });

    const researchPrompt = await promptBuilder.buildResearchPrompt(task, cwd);
    const fullPrompt = `${RESEARCH_SYSTEM_PROMPT}\n\n${researchPrompt}`;

    const researchContent = await runACPStep({
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

    if (researchContent.trim()) {
        await fileManager.writeResearch(task.id, researchContent.trim());
        stepLogger.info('Research completed', { taskId: task.id });
    }

    await gitManager.addAllPostHogFiles();
    await finalizeStepGitActions(context, step, {
        commitMessage: `Research phase for ${task.title}`,
    });

    if (extractor && researchContent.trim()) {
        try {
            stepLogger.info('Extracting questions from research.md', { taskId: task.id });
            const parsedQuestions = await extractor.extractQuestions(researchContent);

            await fileManager.writeQuestions(task.id, {
                questions: parsedQuestions,
                answered: false,
                answers: null,
            });

            emitEvent({
                method: '_posthog/artifact',
                params: {
                    type: 'research_questions',
                    _meta: { content: parsedQuestions },
                },
            });

            stepLogger.info('Questions extracted successfully', {
                taskId: task.id,
                count: parsedQuestions.length,
            });
        } catch (error) {
            stepLogger.error('Failed to extract questions', {
                taskId: task.id,
                error: error instanceof Error ? error.message : String(error),
            });
            emitEvent({
                method: '_posthog/error',
                params: {
                    type: 'extraction_error',
                    _meta: {
                        message: `Failed to extract questions: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    },
                },
            });
        }
    } else if (!extractor) {
        stepLogger.warn(
            'Question extractor not available, skipping question extraction. Ensure LLM gateway is configured.'
        );
        emitEvent({
            method: '_posthog/status',
            params: {
                type: 'extraction_skipped',
                _meta: { message: 'Question extraction skipped - extractor not configured' },
            },
        });
    }

    if (!isCloudMode) {
        emitEvent({ method: '_posthog/status', params: { type: 'phase_complete', _meta: { phase: 'research' } } });
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
        stepLogger.info('Auto-answered research questions', { taskId: task.id });
    }

    emitEvent({ method: '_posthog/status', params: { type: 'phase_complete', _meta: { phase: 'research' } } });
    return { status: 'completed' };
};
