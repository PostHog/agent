import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, ExecutionResult, PlanResult, AgentConfig } from './types.js';
import type { WorkflowDefinition, WorkflowStage, WorkflowExecutionOptions } from './workflow-types.js';
import { TaskManager } from './task-manager.js';
import { PostHogAPIClient } from './posthog-api.js';
import { PostHogFileManager } from './file-manager.js';
import { GitManager } from './git-manager.js';
import { TemplateManager } from './template-manager.js';
import { EventTransformer } from './event-transformer.js';
import { PLANNING_SYSTEM_PROMPT } from './agents/planning.js';
import { EXECUTION_SYSTEM_PROMPT } from './agents/execution.js';
import { Logger } from './utils/logger.js';
import { AgentRegistry } from './agent-registry.js';
import { WorkflowRegistry } from './workflow-registry.js';
import { StageExecutor } from './stage-executor.js';
import { PromptBuilder } from './prompt-builder.js';
import { TaskProgressReporter } from './task-progress-reporter.js';

export class Agent {
    private workingDirectory: string;
    private onEvent?: (event: any) => void;
    private taskManager: TaskManager;
    private posthogAPI?: PostHogAPIClient;
    private fileManager: PostHogFileManager;
    private gitManager: GitManager;
    private templateManager: TemplateManager;
    private eventTransformer: EventTransformer;
    private logger: Logger;
    private agentRegistry: AgentRegistry;
    private workflowRegistry: WorkflowRegistry;
    private stageExecutor: StageExecutor;
    private progressReporter: TaskProgressReporter;
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
        this.eventTransformer = new EventTransformer();

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
        const promptBuilder = new PromptBuilder({
            getTaskFiles: (taskId: string) => this.getTaskFiles(taskId),
            generatePlanTemplate: (vars) => this.templateManager.generatePlan(vars),
            logger: this.logger.child('PromptBuilder')
        });
        this.stageExecutor = new StageExecutor(
            this.agentRegistry,
            this.logger,
            promptBuilder,
            undefined, // eventHandler set via setEventHandler below
            this.mcpServers
        );
        this.stageExecutor.setEventHandler((event) => this.emitEvent(event));
        this.progressReporter = new TaskProgressReporter(this.posthogAPI, this.logger);
    }

    /**
     * Enable or disable debug logging
     */
    setDebug(enabled: boolean) {
        this.debug = enabled;
        this.logger.setDebug(enabled);
    }

    // Workflow-based execution
    async runWorkflow(taskOrId: Task | string, workflowId: string, options: WorkflowExecutionOptions = {}): Promise<{ task: Task; workflow: WorkflowDefinition }> {
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
                if (!(task as any).current_stage && workflow.stages.length > 0) {
                    const firstStage = [...workflow.stages].sort((a, b) => a.position - b.position)[0];
                    await this.posthogAPI.updateTaskStage(task.id, firstStage.id);
                    (task as any).current_stage = firstStage.id;
                }
            } catch (e) {
                this.logger.warn('Failed to sync task workflow/stage before execution', { error: (e as Error).message });
            }
        }

        const executionId = this.taskManager.generateExecutionId();
        this.logger.info('Starting workflow execution', { taskId: task.id, workflowId, executionId });
        this.taskManager.startExecution(task.id, 'plan_and_build', executionId);
        await this.progressReporter.start(task.id, {
            workflowId,
            workflowRunId: executionId,
            totalSteps: orderedStages.length,
        });

        try {
            let startIndex = 0;
            const currentStageId = (task as any).current_stage as string | undefined;

            // If task is already at the last stage, fail gracefully without progressing
            if (currentStageId) {
                const currIdx = orderedStages.findIndex(s => s.id === currentStageId);
                const atLastStage = currIdx >= 0 && currIdx === orderedStages.length - 1;
                if (atLastStage) {
                    const finalStageKey = orderedStages[currIdx]?.key;
                    this.emitEvent(this.eventTransformer.createStatusEvent('no_next_stage', { stage: finalStageKey }));
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

            // Align server-side stage when restarting from the beginning
            if (this.posthogAPI) {
                const targetStage = orderedStages[startIndex];
                if (targetStage && targetStage.id !== currentStageId) {
                    try { await this.posthogAPI.updateTaskStage(task.id, targetStage.id); (task as any).current_stage = targetStage.id; } catch {}
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
                        await this.progressToNextStage(task.id);
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
        this.emitEvent(this.eventTransformer.createStatusEvent('stage_start', { stage: stage.key }));
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
            this.emitEvent(this.eventTransformer.createStatusEvent('branch_created', { stage: stage.key, branch: planningBranch }));
            await this.progressReporter.branchCreated(stage.key, planningBranch);
        } else if (!isPlanning && !isManual && shouldCreateImplBranch) {
            const implBranch = await this.createImplementationBranch(task.id);
            await this.updateTaskBranch(task.id, implBranch);
            this.emitEvent(this.eventTransformer.createStatusEvent('branch_created', { stage: stage.key, branch: implBranch }));
            await this.progressReporter.branchCreated(stage.key, implBranch);
        }

        const result = await this.stageExecutor.execute(task, stage, options);

        if (result.plan) {
            await this.writePlan(task.id, result.plan);
            await this.commitPlan(task.id, task.title);
            this.emitEvent(this.eventTransformer.createStatusEvent('commit_made', { stage: stage.key, kind: 'plan' }));
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
                    this.emitEvent(this.eventTransformer.createStatusEvent('branch_created', { stage: stage.key, branch: implBranch }));
                    await this.progressReporter.branchCreated(stage.key, implBranch);
                }
                try {
                    const prUrl = await this.createPullRequest(task.id, branchName, task.title, task.description);
                    await this.updateTaskBranch(task.id, branchName);
                    await this.attachPullRequestToTask(task.id, prUrl, branchName);
                    this.emitEvent(this.eventTransformer.createStatusEvent('pr_created', { stage: stage.key, prUrl }));
                    await this.progressReporter.pullRequestCreated(stage.key, prUrl);
                } catch {}
            }
            // Do not auto-progress on manual stages
            this.emitEvent(this.eventTransformer.createStatusEvent('stage_complete', { stage: stage.key }));
            return;
        }

        if (result.results) {
            const existingPlan = await this.readPlan(task.id);
            const planSummary = existingPlan ? existingPlan.split('\n')[0] : undefined;
            await this.commitImplementation(task.id, task.title, planSummary);
            this.emitEvent(this.eventTransformer.createStatusEvent('commit_made', { stage: stage.key, kind: 'implementation' }));
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
                    this.emitEvent(this.eventTransformer.createStatusEvent('pr_created', { stage: stage.key, prUrl }));
                    await this.progressReporter.pullRequestCreated(stage.key, prUrl);
                } catch {}
            }
        }

        this.emitEvent(this.eventTransformer.createStatusEvent('stage_complete', { stage: stage.key }));
    }

    async progressToNextStage(taskId: string): Promise<void> {
        if (!this.posthogAPI) throw new Error('PostHog API not configured. Cannot progress stage.');
        await this.posthogAPI.progressTask(taskId, { auto: true });
    }

    // Direct prompt execution - still supported for low-level usage
    async run(prompt: string, options: { repositoryPath?: string; permissionMode?: import('./types.js').PermissionMode; queryOverrides?: Record<string, any> } = {}): Promise<ExecutionResult> {
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
            const transformedEvent = this.eventTransformer.transform(message);
            this.onEvent?.(transformedEvent);
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
        this.logger.info('Attaching PR to task', { taskId, prUrl, branchName });

        if (!this.posthogAPI) {
            const error = new Error('PostHog API not configured. Cannot attach PR to task.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }

        await this.posthogAPI.attachTaskPullRequest(taskId, prUrl, branchName);
        this.logger.debug('PR attached to task', { taskId, prUrl });
    }

    async updateTaskBranch(taskId: string, branchName: string): Promise<void> {
        this.logger.info('Updating task branch', { taskId, branchName });

        if (!this.posthogAPI) {
            const error = new Error('PostHog API not configured. Cannot update task branch.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }

        await this.posthogAPI.setTaskBranch(taskId, branchName);
        this.logger.debug('Task branch updated', { taskId, branchName });
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
