import { query } from '@anthropic-ai/claude-agent-sdk';
import { RESEARCH_SYSTEM_PROMPT } from '../../agents/research.js';
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
        emitEvent,
    } = context;

    const stepLogger = logger.child('ResearchStep');

    const existingEval = await fileManager.readEval(task.id);
    if (existingEval) {
        stepLogger.info('Eval already exists, skipping step', { taskId: task.id });
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

    let jsonContent = '';
    for await (const message of response) {
        emitEvent(adapter.createRawSDKEvent(message));
        const transformed = adapter.transform(message);
        if (transformed) {
            emitEvent(transformed);
        }
        if (message.type === 'assistant' && message.message?.content) {
            for (const c of message.message.content) {
                if (c.type === 'text' && c.text) {
                    jsonContent += c.text;
                }
            }
        }
    }

    if (!jsonContent.trim()) {
        stepLogger.error('No JSON output from research agent', { taskId: task.id });
        emitEvent({
            type: 'error',
            ts: Date.now(),
            message: 'Research agent returned no output',
        });
        return { status: 'completed', halt: true };
    }

    // Parse JSON response
    let evaluation: import('../types.js').ResearchEvaluation;
    try {
        // Extract JSON from potential markdown code blocks or other wrapping
        const jsonMatch = jsonContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('No JSON object found in response');
        }
        evaluation = JSON.parse(jsonMatch[0]);
        stepLogger.info('Parsed research evaluation', {
            taskId: task.id,
            score: evaluation.actionabilityScore,
            hasQuestions: !!evaluation.questions,
        });
    } catch (error) {
        stepLogger.error('Failed to parse research JSON', {
            taskId: task.id,
            error: error instanceof Error ? error.message : String(error),
            content: jsonContent.substring(0, 500),
        });
        emitEvent({
            type: 'error',
            ts: Date.now(),
            message: `Failed to parse research JSON: ${
                error instanceof Error ? error.message : String(error)
            }`,
        });
        return { status: 'completed', halt: true };
    }

    // Always write eval.json
    await fileManager.writeEval(task.id, evaluation);
    stepLogger.info('Research evaluation written', {
        taskId: task.id,
        score: evaluation.actionabilityScore,
    });

    emitEvent({
        type: 'artifact',
        ts: Date.now(),
        kind: 'research_evaluation',
        content: evaluation,
    });

    await gitManager.addAllPostHogFiles();
    await finalizeStepGitActions(context, step, {
        commitMessage: `Research phase for ${task.title}`,
    });

    // If score < 0.7 and questions exist, write questions.json and halt
    if (evaluation.actionabilityScore < 0.7 && evaluation.questions && evaluation.questions.length > 0) {
        stepLogger.info('Actionability score below threshold, questions needed', {
            taskId: task.id,
            score: evaluation.actionabilityScore,
            questionCount: evaluation.questions.length,
        });

        await fileManager.writeQuestions(task.id, {
            questions: evaluation.questions,
            answered: false,
            answers: null,
        });

        emitEvent({
            type: 'artifact',
            ts: Date.now(),
            kind: 'research_questions',
            content: evaluation.questions,
        });

        stepLogger.info('Questions written, halting for user input', { taskId: task.id });
    } else {
        stepLogger.info('Actionability score acceptable, proceeding to planning', {
            taskId: task.id,
            score: evaluation.actionabilityScore,
        });
    }

    // In local mode, always halt after research for user review
    if (!isCloudMode) {
        emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'research' }));
        return { status: 'completed', halt: true };
    }

    // In cloud mode, handle questions automatically if possible
    const questionsData = await fileManager.readQuestions(task.id);
    if (questionsData && !questionsData.answered) {
        // Questions need answering - halt for user input in cloud mode too
        emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'research' }));
        return { status: 'completed', halt: true };
    }

    // No questions or questions already answered - proceed to planning
    emitEvent(adapter.createStatusEvent('phase_complete', { phase: 'research' }));
    return { status: 'completed' };
};
