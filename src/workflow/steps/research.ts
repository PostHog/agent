import { query } from '@anthropic-ai/claude-agent-sdk';
import { RESEARCH_SYSTEM_PROMPT } from '../../agents/research.js';
import type { ExtractedQuestionWithAnswer } from '../../structured-extraction.js';
import type { WorkflowStepRunner } from '../types.js';
import { finalizeStepGitActions } from '../utils.js';

export const researchStep: WorkflowStepRunner = async ({ step, context }) => {
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
    emitEvent(adapter.createStatusEvent('phase_start', { phase: 'research' }));

    const researchPrompt = await promptBuilder.buildResearchPrompt(task, cwd);
    const fullPrompt = `${RESEARCH_SYSTEM_PROMPT}\n\n${researchPrompt}`;

    const baseOptions: Record<string, any> = {
        model: step.model,
        cwd,
        permissionMode: 'plan',
        settingSources: ['local'],
        mcpServers,
        // Allow research tools: read-only operations, web search, and MCP resources
        allowedTools: [
            'Read',
            'Glob',
            'Grep',
            'WebFetch',
            'WebSearch',
            'ListMcpResources',
            'ReadMcpResource',
            'TodoWrite',
            'BashOutput',
        ],
    };

    const response = query({
        prompt: fullPrompt,
        options: { ...baseOptions, ...(options.queryOverrides || {}) },
    });

    let researchContent = '';
    for await (const message of response) {
        emitEvent(adapter.createRawSDKEvent(message));
        const transformed = adapter.transform(message);
        if (transformed) {
            emitEvent(transformed);
        }
        if (message.type === 'assistant' && message.message?.content) {
            for (const c of message.message.content) {
                if (c.type === 'text' && c.text) {
                    researchContent += `${c.text}\n`;
                }
            }
        }
    }

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
                type: 'artifact',
                ts: Date.now(),
                kind: 'research_questions',
                content: parsedQuestions,
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
                type: 'error',
                ts: Date.now(),
                message: `Failed to extract questions: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            });
        }
    } else if (!extractor) {
        stepLogger.warn(
            'Question extractor not available, skipping question extraction. Ensure LLM gateway is configured.'
        );
        emitEvent({
            type: 'status',
            ts: Date.now(),
            phase: 'extraction_skipped',
            message: 'Question extraction skipped - extractor not configured',
        });
    }

    if (!isCloudMode) {
        emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'research' }));
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

    emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'research' }));
    return { status: 'completed' };
};
