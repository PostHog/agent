import { query } from "@anthropic-ai/claude-agent-sdk";
import type { 
  Task, 
  ExecutionOptions, 
  TaskExecutionResult, 
  ExecutionResult, 
  PlanResult, 
  AgentConfig 
} from './types';
import { 
  ExecutionMode 
} from './types';
import { TaskManager } from './task-manager';
import { PostHogAPIClient } from './posthog-api';
import { PostHogFileManager } from './file-manager';
import { GitManager } from './git-manager';
import { TemplateManager } from './template-manager';
import { EventTransformer } from './event-transformer';
import { PLANNING_SYSTEM_PROMPT } from './agents/planning';
import { EXECUTION_SYSTEM_PROMPT } from './agents/execution';
import { Logger } from './logger';

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
    public debug: boolean;

    constructor(config: AgentConfig = {}) {
        this.workingDirectory = config.workingDirectory || process.cwd();
        this.onEvent = config.onEvent;
        this.debug = config.debug || false;
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

        if (config.posthogApiUrl && config.posthogApiKey) {
            this.posthogAPI = new PostHogAPIClient({
                apiUrl: config.posthogApiUrl,
                apiKey: config.posthogApiKey,
            });
        }
    }

    /**
     * Enable or disable debug logging
     */
    setDebug(enabled: boolean) {
        this.debug = enabled;
        this.logger.setDebug(enabled);
    }

    // Task-based execution
    async runTask(
        taskOrId: Task | string, 
        mode: ExecutionMode, 
        options: ExecutionOptions = {}
    ): Promise<TaskExecutionResult> {
        
        let task: Task;
        
        if (typeof taskOrId === 'string') {
            this.logger.debug('Fetching task by ID', { taskId: taskOrId });
            task = await this.fetchTask(taskOrId);
        } else {
            task = taskOrId;
        }

        const executionId = this.taskManager.generateExecutionId();
        this.logger.info('Starting task execution', { 
            taskId: task.id, 
            taskTitle: task.title,
            mode, 
            executionId 
        });
        
        const executionState = this.taskManager.startExecution(
            task.id, 
            mode === ExecutionMode.PLAN_AND_BUILD ? 'plan_and_build' :
            mode === ExecutionMode.PLAN_ONLY ? 'plan_only' : 'build_only',
            executionId
        );

        try {
            let result: TaskExecutionResult;
            
            switch (mode) {
                case ExecutionMode.PLAN_AND_BUILD:
                    this.logger.debug('Running plan and build mode');
                    result = await this.runPlanAndBuild(task, options);
                    break;
                case ExecutionMode.PLAN_ONLY:
                    this.logger.debug('Running plan only mode');
                    result = await this.runPlanOnly(task, options);
                    break;
                case ExecutionMode.BUILD_ONLY:
                    this.logger.debug('Running build only mode');
                    result = await this.runBuildOnly(task, options);
                    break;
                default:
                    throw new Error(`Unknown execution mode: ${mode}`);
            }
            
            this.taskManager.completeExecution(executionId, result);
            this.logger.info('Task execution completed successfully', { taskId: task.id, executionId });
            return result;
            
        } catch (error) {
            this.logger.error('Task execution failed', error as Error);
            this.taskManager.failExecution(executionId, error as Error);
            throw error;
        }
    }

    // Direct prompt execution - we may not need this
    async run(prompt: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
        const response = query({
            prompt,
            options: {
                model: "claude-4-5-sonnet",
                cwd: options.repositoryPath || this.workingDirectory,
                permissionMode: options.permissionMode || "default",
                settingSources: ["local"],
            },
        });

        const results = [];
        for await (const message of response) {
            this.logger.debug('Received message in direct run', { type: message.type });
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

    async attachPullRequestToTask(taskId: string, prUrl: string): Promise<void> {
        this.logger.info('Attaching PR to task', { taskId, prUrl });

        if (!this.posthogAPI) {
            const error = new Error('PostHog API not configured. Cannot attach PR to task.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }

        await this.posthogAPI.updateTask(taskId, { github_pr_url: prUrl });
        this.logger.debug('PR attached to task', { taskId, prUrl });
    }

    async updateTaskBranch(taskId: string, branchName: string): Promise<void> {
        this.logger.info('Updating task branch', { taskId, branchName });

        if (!this.posthogAPI) {
            const error = new Error('PostHog API not configured. Cannot update task branch.');
            this.logger.error('PostHog API not configured', error);
            throw error;
        }

        await this.posthogAPI.updateTask(taskId, { github_branch: branchName });
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

    // Private execution methods
    private async runPlanAndBuild(task: Task, options: ExecutionOptions): Promise<TaskExecutionResult> {
        // Phase 1: Planning
        this.emitEvent(this.eventTransformer.createStatusEvent('planning'));

        const planningBranchName = await this.createPlanningBranch(task.id);

        // Update task with planning branch
        try {
            await this.updateTaskBranch(task.id, planningBranchName);
        } catch (error) {
            this.logger.error('Failed to update task with planning branch', error as Error);
        }

        const planResult = await this.runPlanningPhase(task, options);

        // Plan is already formatted from the template in the prompt
        await this.writePlan(task.id, planResult.plan);

        await this.commitPlan(task.id, task.title);

        this.emitEvent(this.eventTransformer.createStatusEvent('plan_complete', { plan: planResult.plan }));

        // Phase 2: Execution
        this.emitEvent(this.eventTransformer.createStatusEvent('executing'));

        const implementationBranchName = await this.createImplementationBranch(task.id, planningBranchName);

        // Update task with implementation branch
        try {
            await this.updateTaskBranch(task.id, implementationBranchName);
        } catch (error) {
            this.logger.error('Failed to update task with implementation branch', error as Error);
        }

        const executionResult = await this.runExecutionPhase(task, options);

        await this.commitImplementation(task.id, task.title, planResult.plan.split('\n')[0]); // Use first line as summary

        // Create PR and attach to task
        try {
            this.emitEvent(this.eventTransformer.createStatusEvent('creating_pr'));
            const prUrl = await this.createPullRequest(task.id, implementationBranchName, task.title, task.description);
            await this.attachPullRequestToTask(task.id, prUrl);
            this.emitEvent(this.eventTransformer.createStatusEvent('pr_created', { prUrl }));
        } catch (error) {
            this.logger.error('Failed to create or attach PR', error as Error);
            // Don't fail the entire task if PR creation fails
        }

        this.emitEvent(this.eventTransformer.createStatusEvent('done'));

        return {
            task,
            plan: planResult.plan,
            executionResult,
            mode: ExecutionMode.PLAN_AND_BUILD
        };
    }

    private async runPlanOnly(task: Task, options: ExecutionOptions): Promise<TaskExecutionResult> {
        this.emitEvent(this.eventTransformer.createStatusEvent('planning'));

        const planningBranchName = await this.createPlanningBranch(task.id);

        // Update task with planning branch
        try {
            await this.updateTaskBranch(task.id, planningBranchName);
        } catch (error) {
            this.logger.error('Failed to update task with planning branch', error as Error);
        }

        const planResult = await this.runPlanningPhase(task, options);

        // Plan is already formatted from the template in the prompt
        await this.writePlan(task.id, planResult.plan);

        await this.commitPlan(task.id, task.title);

        this.emitEvent(this.eventTransformer.createStatusEvent('plan_complete', { plan: planResult.plan }));

        return {
            task,
            plan: planResult.plan,
            mode: ExecutionMode.PLAN_ONLY
        };
    }

    private async runBuildOnly(task: Task, options: ExecutionOptions): Promise<TaskExecutionResult> {
        this.emitEvent(this.eventTransformer.createStatusEvent('executing'));

        const implementationBranchName = await this.createImplementationBranch(task.id);

        // Update task with implementation branch
        try {
            await this.updateTaskBranch(task.id, implementationBranchName);
        } catch (error) {
            this.logger.error('Failed to update task with implementation branch', error as Error);
        }

        const executionResult = await this.runExecutionPhase(task, options);

        const existingPlan = await this.readPlan(task.id);
        const planSummary = existingPlan ? existingPlan.split('\n')[0] : undefined;

        await this.commitImplementation(task.id, task.title, planSummary);

        // Create PR and attach to task
        try {
            this.emitEvent(this.eventTransformer.createStatusEvent('creating_pr'));
            const prUrl = await this.createPullRequest(task.id, implementationBranchName, task.title, task.description);
            await this.attachPullRequestToTask(task.id, prUrl);
            this.emitEvent(this.eventTransformer.createStatusEvent('pr_created', { prUrl }));
        } catch (error) {
            this.logger.error('Failed to create or attach PR', error as Error);
            // Don't fail the entire task if PR creation fails
        }

        this.emitEvent(this.eventTransformer.createStatusEvent('done'));

        return {
            task,
            executionResult,
            mode: ExecutionMode.BUILD_ONLY
        };
    }

    private async runPlanningPhase(task: Task, options: ExecutionOptions): Promise<PlanResult> {
        const prompt = await this.buildPlanningPrompt(task);
        
        const response = query({
            prompt,
            options: {
                model: "claude-4-5-sonnet",
                cwd: options.repositoryPath || this.workingDirectory,
                permissionMode: "plan", // Built-in Claude SDK planning mode
                settingSources: ["local"],
            },
        });

        let plan = "";
        let allAssistantContent = "";
        
        for await (const message of response) {
            this.logger.debug('Received Claude SDK message', { type: message.type });
            const transformedEvent = this.eventTransformer.transform(message);
            this.emitEvent(transformedEvent);
            
            // Extract content from assistant messages
            if (message.type === 'assistant' && message.message?.content) {
                for (const content of message.message.content) {
                    if (content.type === 'text' && content.text) {
                        allAssistantContent += content.text + "\n";
                    }
                }
            }
            
            // Check for exit_plan_mode tool use in assistant messages
            if (message.type === 'assistant' && message.message?.content) {
                for (const content of message.message.content) {
                    if (content.type === 'tool_use' && content.name === 'ExitPlanMode') {
                        plan = content.input?.plan || "";
                    }
                }
            }
            
            // Check for exit_plan_mode tool results in user messages
            if (message.type === 'user' && message.message?.content) {
                for (const content of message.message.content) {
                    if (content.type === 'tool_result' && content.tool_use_id) {
                        // Find the corresponding tool_use to check if it was ExitPlanMode
                        // For now, we'll assume any tool_result with plan content is our plan
                        if (content.content && typeof content.content === 'string' && content.content.includes('# Implementation Plan')) {
                            plan = content.content;
                        }
                    }
                }
            }
        }
        
        // Use exit_plan_mode content if available, otherwise use all assistant content
        if (!plan && allAssistantContent.trim()) {
            plan = allAssistantContent.trim();
        }
        
        this.logger.info('Planning phase completed', { planLength: plan.length });
        return { plan };
    }

    private async runExecutionPhase(task: Task, options: ExecutionOptions): Promise<ExecutionResult> {
        
        const prompt = await this.buildExecutionPrompt(task);
        this.logger.debug('Built execution prompt', { promptLength: prompt.length });
        
        this.logger.info('Starting execution phase with Claude SDK', {
            model: "claude-4-5-sonnet",
            cwd: options.repositoryPath || this.workingDirectory,
            permissionMode: options.permissionMode || "default"
        });
        
        const response = query({
            prompt,
            options: {
                model: "claude-4-5-sonnet", 
                cwd: options.repositoryPath || this.workingDirectory,
                permissionMode: options.permissionMode || "default",
                settingSources: ["local"],
            },
        });

        const results = [];
        for await (const message of response) {
            this.logger.debug('Received Claude SDK message', { type: message.type });
            const transformedEvent = this.eventTransformer.transform(message);
            this.emitEvent(transformedEvent);
            results.push(message);
        }
        
        this.logger.info('Execution phase completed', { resultCount: results.length });
        return { results };
    }

    private async buildPlanningPrompt(task: Task): Promise<string> {
        let prompt = PLANNING_SYSTEM_PROMPT;
        
        prompt += `\n\n## Current Task

**Task**: ${task.title}
**Description**: ${task.description}`;

        if (task.primary_repository) {
            prompt += `\n**Repository**: ${task.primary_repository}`;
        }

        // Include existing supporting files as context from file system
        try {
            const taskFiles = await this.getTaskFiles(task.id);
            const contextFiles = taskFiles.filter(f => f.type === 'context' || f.type === 'reference');
            
            if (contextFiles.length > 0) {
                prompt += `\n\n## Supporting Files`;
                for (const file of contextFiles) {
                    prompt += `\n\n### ${file.name} (${file.type})\n${file.content}`;
                }
            }
        } catch (error) {
            // No existing files, continue without them
            this.logger.debug('No existing task files found', { taskId: task.id });
        }

        // Generate the plan template for Claude to fill in
        const templateVariables = {
            task_id: task.id,
            task_title: task.title,
            task_description: task.description,
            date: new Date().toISOString().split('T')[0],
            repository: task.primary_repository || ''
        };
        
        const planTemplate = await this.templateManager.generatePlan(templateVariables);

        prompt += `\n\nPlease analyze the codebase and create a detailed implementation plan for this task. Use the following template structure for your plan:

${planTemplate}

Fill in each section with specific, actionable information based on your analysis. Replace all placeholder content with actual details about this task.`;

        return prompt;
    }

    private async buildExecutionPrompt(task: Task): Promise<string> {
        let prompt = EXECUTION_SYSTEM_PROMPT;
        
        prompt += `\n\n## Current Task

**Task**: ${task.title}
**Description**: ${task.description}`;

        if (task.primary_repository) {
            prompt += `\n**Repository**: ${task.primary_repository}`;
        }

        // Include all supporting files as context from file system
        try {
            const taskFiles = await this.getTaskFiles(task.id);
            const hasPlan = taskFiles.some(f => f.type === 'plan');
            
            if (taskFiles.length > 0) {
                prompt += `\n\n## Context and Supporting Information`;
                
                for (const file of taskFiles) {
                    if (file.type === 'plan') {
                        prompt += `\n\n### Execution Plan\n${file.content}`;
                    } else {
                        prompt += `\n\n### ${file.name} (${file.type})\n${file.content}`;
                    }
                }
            }

            if (hasPlan) {
                prompt += `\n\nPlease implement the changes described in the execution plan above. Follow the plan step-by-step and make the necessary file modifications. You must actually edit files and make changes - do not just analyze or review.`;
            } else {
                prompt += `\n\nPlease implement the changes described in the task above. You must actually edit files and make changes - do not just analyze or review.`;
            }
        } catch (error) {
            // No supporting files found, just use task description
            this.logger.debug('No supporting files found for execution', { taskId: task.id });
            prompt += `\n\nPlease implement the changes described in the task above.`;
        }
        
        return prompt;
    }

    private emitEvent(event: any): void {
        if (this.debug && event.type !== 'token') {
            // Log all events except tokens (too verbose)
            this.logger.debug('Emitting event', { type: event.type, ts: event.ts });
        }
        this.onEvent?.(event);
    }
}

export { ExecutionMode, PermissionMode } from './types';
export type { Task, SupportingFile, TaskExecutionResult, ExecutionResult, AgentConfig } from './types';