import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, ExecutionResult, PlanResult, AgentConfig } from './types.js';
import type { WorkflowDefinition, WorkflowStage, WorkflowExecutionOptions } from './workflow-types.js';
import { TaskManager } from './task-manager.js';
import { PostHogAPIClient } from './posthog-api.js';
import { PostHogFileManager } from './file-manager.js';
import { GitManager } from './git-manager.js';
import { TemplateManager } from './template-manager.js';
import { ClaudeAdapter } from './adapters/claude/claude-adapter.js';
import type { ProviderAdapter } from './adapters/types.js';
import { PLANNING_SYSTEM_PROMPT } from './agents/planning.js';
import { EXECUTION_SYSTEM_PROMPT } from './agents/execution.js';
import { Logger } from './utils/logger.js';
import { AgentRegistry } from './agent-registry.js';
import { WorkflowRegistry } from './workflow-registry.js';
import { StageExecutor } from './stage-executor.js';
import { PromptBuilder } from './prompt-builder.js';
import { TaskProgressReporter } from './task-progress-reporter.js';
import { OpenAIExtractor, type ExtractedQuestion, type ExtractedQuestionWithAnswer } from './structured-extraction.js';

export class Agent {
    private workingDirectory: string;
    private onEvent?: (event: any) => void;
    private taskManager: TaskManager;
    private posthogAPI?: PostHogAPIClient;
    private fileManager: PostHogFileManager;
    private gitManager: GitManager;
    private templateManager: TemplateManager;
    private adapter: ProviderAdapter;
    private logger: Logger;
    private agentRegistry: AgentRegistry;
    private workflowRegistry: WorkflowRegistry;
    private stageExecutor: StageExecutor;
    private progressReporter: TaskProgressReporter;
    private promptBuilder: PromptBuilder;
    private extractor?: OpenAIExtractor;
    private mcpServers?: Record<string, any>;
    public debug: boolean;

    constructor(config: AgentConfig = {}) {
        this.workingDirectory = config.workingDirectory || process.cwd();
        this.onEvent = config.onEvent;
        this.debug = config.debug || false;

        // Build default PostHog MCP server configuration
        const posthogMcpUrl = config.posthogMcpUrl
            || process.env.POSTHOG_MCP_URL
            || 'https://mcp.posthog.com/mcp';

        // Add auth if API key provided
        const headers: Record<string, string> = {};
        if (config.posthogApiKey) {
            headers['Authorization'] = `Bearer ${config.posthogApiKey}`;
        }

        const defaultMcpServers = {
            posthog: {
                type: 'http' as const,
                url: posthogMcpUrl,
                ...(Object.keys(headers).length > 0 ? { headers } : {}),
            }
        };

        // Merge default PostHog MCP with user-provided servers (user config takes precedence)
        this.mcpServers = {
            ...defaultMcpServers,
            ...config.mcpServers
        };
        this.logger = new Logger({ debug: this.debug, prefix: '[PostHog Agent]' });
        this.taskManager = new TaskManager();
        // Hardcode Claude adapter for now - extensible for other providers later
        this.adapter = new ClaudeAdapter();

        this.fileManager = new PostHogFileManager(
            this.workingDirectory,
            this.logger.child('FileManager')
        );
        this.gitManager = new GitManager({
            repositoryPath: this.workingDirectory,
            logger: this.logger.child('GitManager')
            // TODO: Add author config from environment or config
        });
        this.templateManager = new TemplateManager();
        this.agentRegistry = new AgentRegistry();

        if (config.posthogApiUrl && config.posthogApiKey) {
            this.posthogAPI = new PostHogAPIClient({
                apiUrl: config.posthogApiUrl,
                apiKey: config.posthogApiKey,
            });
        }

        this.workflowRegistry = new WorkflowRegistry(this.posthogAPI);
        this.promptBuilder = new PromptBuilder({
            getTaskFiles: (taskId: string) => this.getTaskFiles(taskId),
            generatePlanTemplate: (vars) => this.templateManager.generatePlan(vars),
            posthogClient: this.posthogAPI,
            logger: this.logger.child('PromptBuilder')
        });
        this.stageExecutor = new StageExecutor(
            this.agentRegistry,
            this.logger,
            this.promptBuilder,
            undefined, // eventHandler set via setEventHandler below
            this.mcpServers
        );
        this.stageExecutor.setEventHandler((event) => this.emitEvent(event));
        this.progressReporter = new TaskProgressReporter(this.posthogAPI, this.logger);
        
        // Initialize OpenAI extractor if API key is available
        if (process.env.OPENAI_API_KEY) {
            this.extractor = new OpenAIExtractor(this.logger.child('OpenAIExtractor'));
        }
    }

    /**
     * Enable or disable debug logging
     */
    setDebug(enabled: boolean) {
        this.debug = enabled;
        this.logger.setDebug(enabled);
    }

    /**
     * Configure LLM gateway environment variables for Claude Code CLI
     */
    private async _configureLlmGateway(): Promise<void> {
        if (!this.posthogAPI) {
            return;
        }

        if (process.env.ANTHROPIC_BASE_URL && process.env.ANTHROPIC_AUTH_TOKEN) {
            return;
        }

        try {
            const gatewayUrl = await this.posthogAPI.getLlmGatewayUrl();
            const apiKey = this.posthogAPI.getApiKey();

            process.env.ANTHROPIC_BASE_URL = gatewayUrl;
            process.env.ANTHROPIC_AUTH_TOKEN = apiKey;

            this.logger.debug('Configured LLM gateway', { gatewayUrl });
        } catch (error) {
            this.logger.error('Failed to configure LLM gateway', error);
            throw error;
        }
    }

    // Workflow-based execution
    async runWorkflow(taskOrId: Task | string, workflowId: string, options: WorkflowExecutionOptions = {}): Promise<{ task: Task; workflow: WorkflowDefinition }> {
        await this._configureLlmGateway();

        const task = typeof taskOrId === 'string' ? await this.fetchTask(taskOrId) : taskOrId;
        await this.workflowRegistry.loadWorkflows();
        const workflow = this.workflowRegistry.getWorkflow(workflowId);
        if (!workflow) {
            throw new Error(`Workflow ${workflowId} not found`);
        }
        const orderedStages = [...workflow.stages].sort((a, b) => a.position - b.position);

        // Ensure task is assigned to workflow and positioned at first stage
        if (this.posthogAPI) {
            try {
                if ((task.workflow as any) !== workflowId) {
                    await this.posthogAPI.updateTask(task.id, { workflow: workflowId } as any);
                    (task as any).workflow = workflowId;
                }
            } catch (e) {
                this.logger.warn('Failed to sync task workflow before execution', { error: (e as Error).message });
            }
        }

        const executionId = this.taskManager.generateExecutionId();
        this.logger.info('Starting workflow execution', { taskId: task.id, workflowId, executionId });
        this.taskManager.startExecution(task.id, 'plan_and_build', executionId);
        await this.progressReporter.start(task.id, {
            totalSteps: orderedStages.length,
        });

        // Set initial stage on the newly created run
        const firstStage = orderedStages[0];
        if (this.posthogAPI && this.progressReporter.runId && firstStage) {
            try {
                await this.posthogAPI.updateTaskRun(task.id, this.progressReporter.runId, {
                    current_stage: firstStage.id
                });
            } catch (e) {
                this.logger.warn('Failed to set initial stage on run', { error: (e as Error).message });
            }
        }

        try {
            let startIndex = 0;
            const currentStageId = (task as any).current_stage as string | undefined;

            // If task is already at the last stage, fail gracefully without progressing
            if (currentStageId) {
                const currIdx = orderedStages.findIndex(s => s.id === currentStageId);
                const atLastStage = currIdx >= 0 && currIdx === orderedStages.length - 1;
                if (atLastStage) {
                    const finalStageKey = orderedStages[currIdx]?.key;
                    this.emitEvent(this.adapter.createStatusEvent('no_next_stage', { stage: finalStageKey }));
                    await this.progressReporter.noNextStage(finalStageKey);
                    await this.progressReporter.complete();
                    this.taskManager.completeExecution(executionId, { task, workflow });
                    return { task, workflow };
                }
            }

            if (options.resumeFromCurrentStage && currentStageId) {
                const idx = orderedStages.findIndex(s => s.id === currentStageId);
                if (idx >= 0) startIndex = idx;
            }

            // Align server-side stage when restarting from a different stage
            if (this.posthogAPI && this.progressReporter.runId) {
                const targetStage = orderedStages[startIndex];
                if (targetStage && targetStage.id !== currentStageId) {
                    try {
                        await this.posthogAPI.updateTaskRun(task.id, this.progressReporter.runId, {
                            current_stage: targetStage.id
                        });
                    } catch (e) {
                        this.logger.warn('Failed to update run stage', { error: (e as Error).message });
                    }
                }
            }

            for (let i = startIndex; i < orderedStages.length; i++) {
                const stage = orderedStages[i];
                await this.progressReporter.stageStarted(stage.key, i);
                await this.executeStage(task, stage, options);
                await this.progressReporter.stageCompleted(stage.key, i + 1);
                if (options.autoProgress) {
                    const hasNext = i < orderedStages.length - 1;
                    if (hasNext) {
                        await this.progressToNextStage(task.id, stage.key);
                    }
                }
            }
            await this.progressReporter.complete();
            this.taskManager.completeExecution(executionId, { task, workflow });
            return { task, workflow };
        } catch (error) {
            await this.progressReporter.fail(error as Error);
            this.taskManager.failExecution(executionId, error as Error);
            throw error;
        }
    }

    async executeStage(task: Task, stage: WorkflowStage, options: WorkflowExecutionOptions = {}): Promise<void> {
        this.emitEvent(this.adapter.createStatusEvent('stage_start', { stage: stage.key }));
        const overrides = options.stageOverrides?.[stage.key];
        const agentName = stage.agent_name || 'code_generation';
        const agentDef = this.agentRegistry.getAgent(agentName);
        const isManual = stage.is_manual_only === true;
        const stageKeyLower = (stage.key || '').toLowerCase().trim();
        const isPlanningByKey = stageKeyLower === 'plan' || stageKeyLower.includes('plan');
        const isPlanning = !isManual && ((agentDef?.agent_type === 'planning') || isPlanningByKey);
        const shouldCreatePlanningBranch = overrides?.createPlanningBranch !== false; // default true
        const shouldCreateImplBranch = overrides?.createImplementationBranch !== false; // default true

        if (isPlanning && shouldCreatePlanningBranch) {
            const planningBranch = await this.createPlanningBranch(task.id);
            await this.updateTaskBranch(task.id, planningBranch);
            this.emitEvent(this.adapter.createStatusEvent('branch_created', { stage: stage.key, branch: planningBranch }));
            await this.progressReporter.branchCreated(stage.key, planningBranch);
        } else if (!isPlanning && !isManual && shouldCreateImplBranch) {
            const implBranch = await this.createImplementationBranch(task.id);
            await this.updateTaskBranch(task.id, implBranch);
            this.emitEvent(this.adapter.createStatusEvent('branch_created', { stage: stage.key, branch: implBranch }));
            await this.progressReporter.branchCreated(stage.key, implBranch);
        }

        const result = await this.stageExecutor.execute(task, stage, options);

        if (result.plan) {
            await this.writePlan(task.id, result.plan);
            await this.commitPlan(task.id, task.title);
            this.emitEvent(this.adapter.createStatusEvent('commit_made', { stage: stage.key, kind: 'plan' }));
            await this.progressReporter.commitMade(stage.key, 'plan');
        }

        if (isManual) {
            const defaultOpenPR = true; // manual stages default to PR for review
            const openPR = overrides?.openPullRequest ?? defaultOpenPR;
            if (openPR) {
                // Ensure we're on an implementation branch for PRs
                let branchName = await this.gitManager.getCurrentBranch();
                const onTaskBranch = branchName.includes(`posthog/task-${task.id}`);
                if (!onTaskBranch && (overrides?.createImplementationBranch !== false)) {
                    const implBranch = await this.createImplementationBranch(task.id);
                    await this.updateTaskBranch(task.id, implBranch);
                    branchName = implBranch;
                    this.emitEvent(this.adapter.createStatusEvent('branch_created', { stage: stage.key, branch: implBranch }));
                    await this.progressReporter.branchCreated(stage.key, implBranch);
                }
                try {
                    const prUrl = await this.createPullRequest(task.id, branchName, task.title, task.description);
                    await this.updateTaskBranch(task.id, branchName);
                    await this.attachPullRequestToTask(task.id, prUrl, branchName);
                    this.emitEvent(this.adapter.createStatusEvent('pr_created', { stage: stage.key, prUrl }));
                    await this.progressReporter.pullRequestCreated(stage.key, prUrl);
                } catch {}
            }
            // Do not auto-progress on manual stages
            this.emitEvent(this.adapter.createStatusEvent('stage_complete', { stage: stage.key }));
            return;
        }

        if (result.results) {
            const existingPlan = await this.readPlan(task.id);
            const planSummary = existingPlan ? existingPlan.split('\n')[0] : undefined;
            await this.commitImplementation(task.id, task.title, planSummary);
            this.emitEvent(this.adapter.createStatusEvent('commit_made', { stage: stage.key, kind: 'implementation' }));
            await this.progressReporter.commitMade(stage.key, 'implementation');
        }

        // PR creation on complete stage (or if explicitly requested), regardless of whether edits occurred
        {
            const defaultOpenPR = stage.key.toLowerCase().includes('complete');
            const openPR = overrides?.openPullRequest ?? defaultOpenPR;
            if (openPR) {
                const branchName = await this.gitManager.getCurrentBranch();
                try {
                    const prUrl = await this.createPullRequest(task.id, branchName, task.title, task.description);
                    await this.updateTaskBranch(task.id, branchName);
                    await this.attachPullRequestToTask(task.id, prUrl, branchName);
                    this.emitEvent(this.adapter.createStatusEvent('pr_created', { stage: stage.key, prUrl }));
                    await this.progressReporter.pullRequestCreated(stage.key, prUrl);
                } catch {}
            }
        }

        this.emitEvent(this.adapter.createStatusEvent('stage_complete', { stage: stage.key }));
    }

    // Adaptive task execution - 3-phase workflow (research → plan → build)
    async runTask(taskOrId: Task | string, options: import('./types.js').TaskExecutionOptions = {}): Promise<void> {
        await this._configureLlmGateway();

        const task = typeof taskOrId === 'string' ? await this.fetchTask(taskOrId) : taskOrId;
        const cwd = options.repositoryPath || this.workingDirectory;
        const isCloudMode = options.isCloudMode ?? false;
        const taskSlug = (task as any).slug || task.id;

        this.logger.info('Starting adaptive task execution', { taskId: task.id, taskSlug, isCloudMode });

        // Initialize progress reporter for task run tracking (needed for PR attachment)
        await this.progressReporter.start(task.id, { totalSteps: 3 }); // 3 phases: research, plan, build
        this.emitEvent(this.adapter.createStatusEvent('run_started', { runId: this.progressReporter.runId }));

        // Phase 1: Branch check
        const existingBranch = await this.gitManager.getTaskBranch(taskSlug);
        if (!existingBranch) {
            this.logger.info('Creating task branch', { taskSlug });
            const branchName = `posthog/task-${taskSlug}`;
            await this.gitManager.createOrSwitchToBranch(branchName);
            this.emitEvent(this.adapter.createStatusEvent('branch_created', { branch: branchName }));
            
            // Initial commit
            await this.fileManager.ensureGitignore();
            await this.gitManager.addAllPostHogFiles();
            if (isCloudMode) {
                await this.gitManager.commitAndPush(`Initialize task ${taskSlug}`, { allowEmpty: true });
            } else {
                await this.gitManager.commitChanges(`Initialize task ${taskSlug}`);
            }
        } else {
            this.logger.info('Switching to existing task branch', { branch: existingBranch });
            await this.gitManager.switchToBranch(existingBranch);
        }

        // Phase 2: Research
        const researchExists = await this.fileManager.readResearch(task.id);
        if (!researchExists) {
            this.logger.info('Starting research phase', { taskId: task.id });
            this.emitEvent(this.adapter.createStatusEvent('phase_start', { phase: 'research' }));
            
            // Run research agent
            const researchPrompt = await this.promptBuilder.buildResearchPrompt(task, cwd);
            const { RESEARCH_SYSTEM_PROMPT } = await import('./agents/research.js');
            const fullPrompt = RESEARCH_SYSTEM_PROMPT + '\n\n' + researchPrompt;
            
            const baseOptions: Record<string, any> = {
                model: 'claude-sonnet-4-5-20250929',
                cwd,
                permissionMode: 'plan',
                settingSources: ['local'],
                mcpServers: this.mcpServers,
            };

            const response = query({
                prompt: fullPrompt,
                options: { ...baseOptions, ...(options.queryOverrides || {}) },
            });

            let researchContent = '';
            for await (const message of response) {
                this.emitEvent(this.adapter.createRawSDKEvent(message));
                const transformed = this.adapter.transform(message);
                if (transformed) {
                    this.emitEvent(transformed);
                }
                if (message.type === 'assistant' && message.message?.content) {
                    for (const c of message.message.content) {
                        if (c.type === 'text' && c.text) researchContent += c.text + '\n';
                    }
                }
            }

            // Write research.md
            if (researchContent.trim()) {
                await this.fileManager.writeResearch(task.id, researchContent.trim());
                this.logger.info('Research completed', { taskId: task.id });
            }

            // Commit research
            await this.gitManager.addAllPostHogFiles();
            
            // Extract questions using structured output and save to questions.json
            if (this.extractor) {
                try {
                    this.logger.info('Extracting questions from research.md', { taskId: task.id });
                    const questions = await this.extractQuestionsFromResearch(task.id, false);
                    
                    this.logger.info('Questions extracted successfully', { taskId: task.id, count: questions.length });
                    
                    // Save questions.json
                    await this.fileManager.writeQuestions(task.id, {
                        questions,
                        answered: false,
                        answers: null,
                    });
                    
                    this.logger.info('Questions saved to questions.json', { taskId: task.id });
                    
                    // Emit event for Array to pick up (local mode)
                    if (!isCloudMode) {
                        this.emitEvent({
                            type: 'artifact',
                            ts: Date.now(),
                            kind: 'research_questions',
                            content: questions,
                        });
                        this.logger.info('Emitted research_questions artifact event', { taskId: task.id });
                    }
                } catch (error) {
                    this.logger.error('Failed to extract questions', { error: error instanceof Error ? error.message : String(error) });
                    this.emitEvent({
                        type: 'error',
                        ts: Date.now(),
                        message: `Failed to extract questions: ${error instanceof Error ? error.message : String(error)}`,
                    });
                }
            } else {
                this.logger.warn('OpenAI extractor not available (OPENAI_API_KEY not set), skipping question extraction');
                this.emitEvent({
                    type: 'status',
                    ts: Date.now(),
                    phase: 'extraction_skipped',
                    message: 'Question extraction skipped - OPENAI_API_KEY not configured',
                });
            }
            
            if (isCloudMode) {
                await this.gitManager.commitAndPush(`Research phase for ${task.title}`);
            } else {
                await this.gitManager.commitChanges(`Research phase for ${task.title}`);
                this.emitEvent(this.adapter.createStatusEvent('phase_complete', { phase: 'research' }));
                return; // Local mode: return to user
            }
        }

        // Phase 3: Auto-answer questions (cloud mode only)
        if (isCloudMode) {
            const questionsData = await this.fileManager.readQuestions(task.id);
            if (questionsData && !questionsData.answered) {
                this.logger.info('Auto-answering research questions', { taskId: task.id });
                
                // Extract questions with recommended answers using structured output
                if (this.extractor) {
                    const questionsWithAnswers = await this.extractQuestionsFromResearch(task.id, true) as ExtractedQuestionWithAnswer[];
                    
                    // Save answers to questions.json
                    await this.fileManager.writeQuestions(task.id, {
                        questions: questionsWithAnswers.map(qa => ({
                            id: qa.id,
                            question: qa.question,
                            options: qa.options,
                        })),
                        answered: true,
                        answers: questionsWithAnswers.map(qa => ({
                            questionId: qa.id,
                            selectedOption: qa.recommendedAnswer,
                            customInput: qa.justification,
                        })),
                    });
                    
                    this.logger.info('Auto-answers saved to questions.json', { taskId: task.id });
                    await this.gitManager.addAllPostHogFiles();
                    await this.gitManager.commitAndPush(`Answer research questions for ${task.title}`);
                } else {
                    this.logger.warn('OpenAI extractor not available, skipping auto-answer');
                }
            }
        }

        // Phase 4: Plan
        const planExists = await this.readPlan(task.id);
        if (!planExists) {
            // Check if questions have been answered
            const questionsData = await this.fileManager.readQuestions(task.id);
            if (!questionsData || !questionsData.answered) {
                this.logger.info('Waiting for user answers to research questions');
                this.emitEvent(this.adapter.createStatusEvent('phase_complete', { phase: 'research_questions' }));
                return; // Wait for user to answer questions
            }

            this.logger.info('Starting planning phase', { taskId: task.id });
            this.emitEvent(this.adapter.createStatusEvent('phase_start', { phase: 'planning' }));
            
            // Build context with research + questions + answers
            const research = await this.fileManager.readResearch(task.id);
            let researchContext = '';
            if (research) {
                researchContext += `## Research Analysis\n\n${research}\n\n`;
            }
            
            // Add questions and answers
            researchContext += `## Implementation Decisions\n\n`;
            const answers = questionsData.answers || [];
            for (const question of questionsData.questions) {
                const answer = answers.find((a: any) => a.questionId === question.id);
                
                researchContext += `### ${question.question}\n\n`;
                if (answer) {
                    researchContext += `**Selected:** ${answer.selectedOption}\n`;
                    if (answer.customInput) {
                        researchContext += `**Details:** ${answer.customInput}\n`;
                    }
                } else {
                    this.logger.warn('No answer found for question', { questionId: question.id });
                    researchContext += `**Selected:** Not answered\n`;
                }
                researchContext += '\n';
            }
            
            // Run planning agent with full context
            const planningPrompt = await this.promptBuilder.buildPlanningPrompt(task, cwd);
            const { PLANNING_SYSTEM_PROMPT } = await import('./agents/planning.js');
            const fullPrompt = PLANNING_SYSTEM_PROMPT + '\n\n' + planningPrompt + '\n\n' + researchContext;
            
            const baseOptions: Record<string, any> = {
                model: 'claude-sonnet-4-5-20250929',
                cwd,
                permissionMode: 'plan',
                settingSources: ['local'],
                mcpServers: this.mcpServers,
            };

            const response = query({
                prompt: fullPrompt,
                options: { ...baseOptions, ...(options.queryOverrides || {}) },
            });

            let planContent = '';
            for await (const message of response) {
                this.emitEvent(this.adapter.createRawSDKEvent(message));
                const transformed = this.adapter.transform(message);
                if (transformed) {
                    this.emitEvent(transformed);
                }
                if (message.type === 'assistant' && message.message?.content) {
                    for (const c of message.message.content) {
                        if (c.type === 'text' && c.text) planContent += c.text + '\n';
                    }
                }
            }

            // Write plan.md
            if (planContent.trim()) {
                await this.writePlan(task.id, planContent.trim());
                this.logger.info('Plan completed', { taskId: task.id });
            }

            // Commit plan
            await this.gitManager.addAllPostHogFiles();
            if (isCloudMode) {
                await this.gitManager.commitAndPush(`Planning phase for ${task.title}`);
            } else {
                await this.gitManager.commitChanges(`Planning phase for ${task.title}`);
                this.emitEvent(this.adapter.createStatusEvent('phase_complete', { phase: 'planning' }));
                return; // Local mode: return to user
            }
        }

        // Phase 5: Build
        const latestRun = task.latest_run;
        const prExists = latestRun?.output && (latestRun.output as any).pr_url;
        
        if (!prExists) {
            this.logger.info('Starting build phase', { taskId: task.id });
            this.emitEvent(this.adapter.createStatusEvent('phase_start', { phase: 'build' }));
            
            // Run execution agent
            const executionPrompt = await this.promptBuilder.buildExecutionPrompt(task, cwd);
            const { EXECUTION_SYSTEM_PROMPT } = await import('./agents/execution.js');
            const fullPrompt = EXECUTION_SYSTEM_PROMPT + '\n\n' + executionPrompt;
            
            const { PermissionMode } = await import('./types.js');
            const permissionMode = options.permissionMode || PermissionMode.ACCEPT_EDITS;
            const baseOptions: Record<string, any> = {
                model: 'claude-sonnet-4-5-20250929',
                cwd,
                permissionMode,
                settingSources: ['local'],
                mcpServers: this.mcpServers,
            };

            const response = query({
                prompt: fullPrompt,
                options: { ...baseOptions, ...(options.queryOverrides || {}) },
            });

            for await (const message of response) {
                this.emitEvent(this.adapter.createRawSDKEvent(message));
                const transformed = this.adapter.transform(message);
                if (transformed) {
                    this.emitEvent(transformed);
                }
            }

            // Commit and push implementation
            // Stage ALL changes (not just .posthog/)
            const hasChanges = await this.gitManager.hasChanges();
            if (hasChanges) {
                await this.gitManager.addFiles(['.']); // Stage all changes
                await this.gitManager.commitChanges(`Implementation for ${task.title}`);
                
                // Push to origin
                const branchName = await this.gitManager.getCurrentBranch();
                await this.gitManager.pushBranch(branchName);
                
                this.logger.info('Implementation committed and pushed', { taskId: task.id });
            } else {
                this.logger.warn('No changes to commit in build phase', { taskId: task.id });
            }

            // Create PR
            const branchName = await this.gitManager.getCurrentBranch();
            const prUrl = await this.createPullRequest(task.id, branchName, task.title, task.description);
            this.logger.info('Pull request created', { taskId: task.id, prUrl });
            this.emitEvent(this.adapter.createStatusEvent('pr_created', { prUrl }));
            
            // Attach PR to task run
            try {
                await this.attachPullRequestToTask(task.id, prUrl, branchName);
                this.logger.info('PR attached to task successfully', { taskId: task.id, prUrl });
            } catch (error) {
                this.logger.warn('Could not attach PR to task', { error: error instanceof Error ? error.message : String(error) });
            }
        } else {
            this.logger.info('PR already exists, skipping build phase', { taskId: task.id });
        }

        // Phase 6: Complete
        await this.progressReporter.complete();
        this.logger.info('Task execution complete', { taskId: task.id });
        this.emitEvent(this.adapter.createStatusEvent('task_complete', { taskId: task.id }));
    }

    async progressToNextStage(taskId: string, currentStageKey?: string): Promise<void> {
        if (!this.posthogAPI || !this.progressReporter.runId) {
            throw new Error('PostHog API not configured or no active run. Cannot progress stage.');
        }
        try {
            await this.posthogAPI.progressTaskRun(taskId, this.progressReporter.runId);
        } catch (error) {
            if (error instanceof Error && error.message.includes('No next stage available')) {
                this.logger.warn('No next stage available when attempting to progress run', {
                    taskId,
                    runId: this.progressReporter.runId,
                    stage: currentStageKey,
                    error: error.message,
                });
                this.emitEvent(this.adapter.createStatusEvent('no_next_stage', { stage: currentStageKey }));
                await this.progressReporter.noNextStage(currentStageKey);
                return;
            }
            throw error;
        }
    }

    // Direct prompt execution - still supported for low-level usage
    async run(prompt: string, options: { repositoryPath?: string; permissionMode?: import('./types.js').PermissionMode; queryOverrides?: Record<string, any> } = {}): Promise<ExecutionResult> {
        await this._configureLlmGateway();
        const baseOptions: Record<string, any> = {
            model: "claude-sonnet-4-5-20250929",
            cwd: options.repositoryPath || this.workingDirectory,
            permissionMode: (options.permissionMode as any) || "default",
            settingSources: ["local"],
            mcpServers: this.mcpServers,
        };

        const response = query({
            prompt,
            options: { ...baseOptions, ...(options.queryOverrides || {}) },
        });

        const results = [];
        for await (const message of response) {
            this.logger.debug('Received message in direct run', message);
            // Emit raw SDK event
            this.emitEvent(this.adapter.createRawSDKEvent(message));
            // Emit transformed event
            const transformedEvent = this.adapter.transform(message);
            if (transformedEvent) {
                this.emitEvent(transformedEvent);
            }
            results.push(message);
        }
        
        return { results };
    }
    
    // PostHog task operations
    async fetchTask(taskId: string): Promise<Task> {
        this.logger.debug('Fetching task from PostHog', { taskId });
        if (!this.posthogAPI) {
            const error = new Error('PostHog API not configured. Provide posthogApiUrl and posthogApiKey in constructor.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }
        return this.posthogAPI.fetchTask(taskId);
    }

    getPostHogClient(): PostHogAPIClient | undefined {
        return this.posthogAPI;
    }
    
    async listTasks(filters?: {
        repository?: string;
        organization?: string;
        origin_product?: string;
        workflow?: string;
        current_stage?: string;
    }): Promise<Task[]> {
        if (!this.posthogAPI) {
            throw new Error('PostHog API not configured. Provide posthogApiUrl and posthogApiKey in constructor.');
        }
        return this.posthogAPI.listTasks(filters);
    }
    
    // File system operations for task artifacts
    async writeTaskFile(taskId: string, fileName: string, content: string, type: 'plan' | 'context' | 'reference' | 'output' = 'reference'): Promise<void> {
        this.logger.debug('Writing task file', { taskId, fileName, type, contentLength: content.length });
        await this.fileManager.writeTaskFile(taskId, { name: fileName, content, type });
    }
    
    async readTaskFile(taskId: string, fileName: string): Promise<string | null> {
        this.logger.debug('Reading task file', { taskId, fileName });
        return await this.fileManager.readTaskFile(taskId, fileName);
    }
    
    async getTaskFiles(taskId: string): Promise<any[]> {
        this.logger.debug('Getting task files', { taskId });
        const files = await this.fileManager.getTaskFiles(taskId);
        this.logger.debug('Found task files', { taskId, fileCount: files.length });
        return files;
    }
    
    async writePlan(taskId: string, plan: string): Promise<void> {
        this.logger.info('Writing plan', { taskId, planLength: plan.length });
        await this.fileManager.writePlan(taskId, plan);
    }
    
    async readPlan(taskId: string): Promise<string | null> {
        this.logger.debug('Reading plan', { taskId });
        return await this.fileManager.readPlan(taskId);
    }

    async extractQuestionsFromResearch(taskId: string, includeAnswers: boolean = false): Promise<ExtractedQuestion[] | ExtractedQuestionWithAnswer[]> {
        this.logger.info('Extracting questions from research.md', { taskId, includeAnswers });
        
        if (!this.extractor) {
            throw new Error('OpenAI extractor not initialized. Set OPENAI_API_KEY environment variable.');
        }

        const researchContent = await this.fileManager.readResearch(taskId);
        if (!researchContent) {
            throw new Error('research.md not found for task ' + taskId);
        }

        if (includeAnswers) {
            return await this.extractor.extractQuestionsWithAnswers(researchContent);
        } else {
            return await this.extractor.extractQuestions(researchContent);
        }
    }
    
    // Git operations for task workflow
    async createPlanningBranch(taskId: string): Promise<string> {
        this.logger.info('Creating planning branch', { taskId });
        const branchName = await this.gitManager.createTaskPlanningBranch(taskId);
        this.logger.debug('Planning branch created', { taskId, branchName });
        // Only create gitignore after we're on the new branch
        await this.fileManager.ensureGitignore();
        return branchName;
    }
    
    async commitPlan(taskId: string, taskTitle: string): Promise<string> {
        this.logger.info('Committing plan', { taskId, taskTitle });
        const commitHash = await this.gitManager.commitPlan(taskId, taskTitle);
        this.logger.debug('Plan committed', { taskId, commitHash });
        return commitHash;
    }
    
    async createImplementationBranch(taskId: string, planningBranchName?: string): Promise<string> {
        this.logger.info('Creating implementation branch', { taskId, fromBranch: planningBranchName });
        const branchName = await this.gitManager.createTaskImplementationBranch(taskId, planningBranchName);
        this.logger.debug('Implementation branch created', { taskId, branchName });
        return branchName;
    }
    
    async commitImplementation(taskId: string, taskTitle: string, planSummary?: string): Promise<string> {
        this.logger.info('Committing implementation', { taskId, taskTitle });
        const commitHash = await this.gitManager.commitImplementation(taskId, taskTitle, planSummary);
        this.logger.debug('Implementation committed', { taskId, commitHash });
        return commitHash;
    }

    async createPullRequest(taskId: string, branchName: string, taskTitle: string, taskDescription: string): Promise<string> {
        this.logger.info('Creating pull request', { taskId, branchName, taskTitle });

        // Build PR body
        const prBody = `## Task Details
**Task ID**: ${taskId}
**Description**: ${taskDescription}

## Changes
This PR implements the changes described in the task.

Generated by PostHog Agent`;

        const prUrl = await this.gitManager.createPullRequest(
            branchName,
            taskTitle,
            prBody
        );

        this.logger.info('Pull request created', { taskId, prUrl });
        return prUrl;
    }

    async attachPullRequestToTask(taskId: string, prUrl: string, branchName?: string): Promise<void> {
        this.logger.info('Attaching PR to task run', { taskId, prUrl, branchName });

        if (!this.posthogAPI || !this.progressReporter.runId) {
            const error = new Error('PostHog API not configured or no active run. Cannot attach PR to task.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }

        const updates: any = {
            output: { pr_url: prUrl }
        };
        if (branchName) {
            updates.branch = branchName;
        }

        await this.posthogAPI.updateTaskRun(taskId, this.progressReporter.runId, updates);
        this.logger.debug('PR attached to task run', { taskId, runId: this.progressReporter.runId, prUrl });
    }

    async updateTaskBranch(taskId: string, branchName: string): Promise<void> {
        this.logger.info('Updating task run branch', { taskId, branchName });

        if (!this.posthogAPI || !this.progressReporter.runId) {
            const error = new Error('PostHog API not configured or no active run. Cannot update branch.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }

        await this.posthogAPI.updateTaskRun(taskId, this.progressReporter.runId, { branch: branchName });
        this.logger.debug('Task run branch updated', { taskId, runId: this.progressReporter.runId, branchName });
    }

    // Execution management
    cancelTask(taskId: string): void {
        // Find the execution for this task and cancel it
        for (const [executionId, execution] of this.taskManager['executionStates']) {
            if (execution.taskId === taskId && execution.status === 'running') {
                this.taskManager.cancelExecution(executionId);
                break;
            }
        }
    }

    getTaskExecutionStatus(taskId: string): string | null {
        // Find the execution for this task
        for (const execution of this.taskManager['executionStates'].values()) {
            if (execution.taskId === taskId) {
                return execution.status;
            }
        }
        return null;
    }

    private emitEvent(event: any): void {
        if (this.debug && event.type !== 'token') {
            // Log all events except tokens (too verbose)
            this.logger.debug('Emitting event', { type: event.type, ts: event.ts });
        }
        const persistPromise = this.progressReporter.recordEvent(event);
        if (persistPromise && typeof persistPromise.then === 'function') {
            persistPromise.catch((error: Error) =>
                this.logger.debug('Failed to persist agent event', { message: error.message })
            );
        }
        this.onEvent?.(event);
    }
}

export { PermissionMode } from './types.js';
export type { Task, SupportingFile, ExecutionResult, AgentConfig } from './types.js';
export type { WorkflowDefinition, WorkflowStage, WorkflowExecutionOptions } from './workflow-types.js';
