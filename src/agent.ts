import type { Task, ExecutionResult, AgentConfig, CanUseTool } from './types.js';
import { TaskManager } from './task-manager.js';
import { PostHogAPIClient } from './posthog-api.js';
import { PostHogFileManager } from './file-manager.js';
import { GitManager } from './git-manager.js';
import { TemplateManager } from './template-manager.js';
import { Logger } from './utils/logger.js';
import { PromptBuilder } from './prompt-builder.js';
import { TaskProgressReporter } from './task-progress-reporter.js';
import { AISDKExtractor, type StructuredExtractor, type ExtractedQuestion, type ExtractedQuestionWithAnswer } from './structured-extraction.js';
import { TASK_WORKFLOW } from './workflow/config.js';
import type { WorkflowRuntime } from './workflow/types.js';
import { ACPWrapper } from './acp-wrapper.js';

export class Agent {
    private workingDirectory: string;
    private taskManager: TaskManager;
    private posthogAPI?: PostHogAPIClient;
    private fileManager: PostHogFileManager;
    private gitManager: GitManager;
    private templateManager: TemplateManager;
    private acpWrapper?: ACPWrapper;
    private currentTaskWrapper?: { wrapper?: ACPWrapper }; // For workflow cancellation
    private logger: Logger;
    private progressReporter: TaskProgressReporter;
    private promptBuilder: PromptBuilder;
    private extractor?: StructuredExtractor;
    private mcpServers?: Record<string, any>;
    private canUseTool?: CanUseTool;
    private notificationHandler?: import('./types.js').NotificationHandler;
    public debug: boolean;

    constructor(config: AgentConfig = {}) {
        this.workingDirectory = config.workingDirectory || process.cwd();
        this.canUseTool = config.canUseTool;
        this.debug = config.debug || false;
        this.notificationHandler = config.onNotification;

        // Build default PostHog MCP server configuration
        const posthogMcpUrl = config.posthogMcpUrl
            || process.env.POSTHOG_MCP_URL
            || 'https://mcp.posthog.com/mcp';

        // Add auth if API key provided
        const headers: Array<{ name: string; value: string }> = [];
        if (config.posthogApiKey) {
            headers.push({
                name: 'Authorization',
                value: `Bearer ${config.posthogApiKey}`,
            });
        }

        const defaultMcpServers = {
            posthog: {
                type: 'http' as const,
                url: posthogMcpUrl,
                headers,
            }
        };

        // Merge default PostHog MCP with user-provided servers (user config takes precedence)
        this.mcpServers = {
            ...defaultMcpServers,
            ...config.mcpServers
        };
        this.logger = new Logger({ debug: this.debug, prefix: '[PostHog Agent]' });
        this.taskManager = new TaskManager();

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

        this.promptBuilder = new PromptBuilder({
            getTaskFiles: (taskId: string) => this.getTaskFiles(taskId),
            generatePlanTemplate: (vars) => this.templateManager.generatePlan(vars),
            posthogClient: this.posthogAPI,
            logger: this.logger.child('PromptBuilder')
        });
        this.progressReporter = new TaskProgressReporter(this.posthogAPI, this.logger);
        this.extractor = new AISDKExtractor(this.logger.child('AISDKExtractor'));
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
            this.ensureOpenAIGatewayEnv();
            return;
        }

        try {
            const gatewayUrl = await this.posthogAPI.getLlmGatewayUrl();
            const apiKey = this.posthogAPI.getApiKey();

            process.env.ANTHROPIC_BASE_URL = gatewayUrl;
            process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
            this.ensureOpenAIGatewayEnv(gatewayUrl, apiKey);

            this.logger.debug('Configured LLM gateway', { gatewayUrl });
        } catch (error) {
            this.logger.error('Failed to configure LLM gateway', error);
            throw error;
        }
    }

    // Adaptive task execution orchestrated via workflow steps
    async runTask(taskOrId: Task | string, options: import('./types.js').TaskExecutionOptions = {}): Promise<void> {
        await this._configureLlmGateway();

        const task = typeof taskOrId === 'string' ? await this.fetchTask(taskOrId) : taskOrId;
        const cwd = options.repositoryPath || this.workingDirectory;
        const isCloudMode = options.isCloudMode ?? false;
        const taskSlug = (task as any).slug || task.id;

        this.notifyStatus('run_started', 'Starting adaptive task execution', {
            taskId: task.id,
            taskSlug,
            isCloudMode,
            runId: this.progressReporter.runId
        });

        // Initialize progress reporter for task run tracking (needed for PR attachment)
        await this.progressReporter.start(task.id, { totalSteps: TASK_WORKFLOW.length });

        await this.prepareTaskBranch(taskSlug, isCloudMode);

        // Create shared wrapper reference for cancellation support
        const currentWrapper: { wrapper?: ACPWrapper } = {};

        const workflowContext: WorkflowRuntime = {
            task,
            taskSlug,
            cwd,
            isCloudMode,
            options,
            logger: this.logger,
            fileManager: this.fileManager,
            gitManager: this.gitManager,
            promptBuilder: this.promptBuilder,
            progressReporter: this.progressReporter,
            mcpServers: this.mcpServers,
            posthogAPI: this.posthogAPI,
            extractor: this.extractor,
            agent: this,
            stepResults: {},
            currentWrapper,
        };

        // Store wrapper reference for cancellation
        this.currentTaskWrapper = currentWrapper;

        try {
            for (const step of TASK_WORKFLOW) {
                const result = await step.run({ step, context: workflowContext });
                if (result.halt) {
                    return;
                }
            }

            const shouldCreatePR = options.createPR ?? isCloudMode;
            if (shouldCreatePR) {
                await this.ensurePullRequest(task, workflowContext.stepResults);
            }

            await this.progressReporter.complete();
            this.notifyStatus('task_complete', 'Task execution complete', { taskId: task.id });
        } finally {
            this.currentTaskWrapper = undefined;
        }
    }

    // Direct prompt execution via ACP
    async run(prompt: string, options: { repositoryPath?: string; permissionMode?: import('./types.js').PermissionMode; queryOverrides?: Record<string, any>; canUseTool?: CanUseTool } = {}): Promise<ExecutionResult> {
        await this._configureLlmGateway();

        const cwd = options.repositoryPath || this.workingDirectory;

        // Initialize ACP wrapper for direct execution
        this.acpWrapper = new ACPWrapper({
            logger: this.logger.child('ACPWrapper'),
            cwd,
            notificationHandler: this,
        });

        try {
            await this.acpWrapper.start();
            const sessionId = await this.acpWrapper.createSession({
                cwd,
                mcpServers: this.mcpServers,
            });

            this.logger.info('Direct execution - ACP session created', { sessionId });
            await this.acpWrapper.prompt(prompt);

            return { results: [] };
        } finally {
            if (this.acpWrapper) {
                await this.acpWrapper.stop();
                this.acpWrapper = undefined;
            }
        }
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
            throw new Error('OpenAI extractor not initialized. Ensure the LLM gateway is configured.');
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

    // Git operations for task execution
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
    async cancelTask(taskId: string): Promise<void> {
        // Cancel the ACP session if running in workflow
        if (this.currentTaskWrapper?.wrapper) {
            try {
                await this.currentTaskWrapper.wrapper.cancel();
                this.logger.info('ACP workflow session cancelled', { taskId });
            } catch (error) {
                this.logger.error('Failed to cancel ACP workflow session', {
                    taskId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        // Cancel the ACP session if running in direct execution
        if (this.acpWrapper) {
            try {
                await this.acpWrapper.cancel();
                this.logger.info('ACP direct session cancelled', { taskId });
            } catch (error) {
                this.logger.error('Failed to cancel ACP direct session', {
                    taskId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

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

    private async prepareTaskBranch(taskSlug: string, isCloudMode: boolean): Promise<void> {
        const existingBranch = await this.gitManager.getTaskBranch(taskSlug);
        if (!existingBranch) {
            const branchName = await this.gitManager.createTaskBranch(taskSlug);
            this.notifyStatus('branch_created', 'Created task branch', { branch: branchName });

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
    }

    private ensureOpenAIGatewayEnv(baseUrl?: string, token?: string): void {
        const resolvedBaseUrl = baseUrl || process.env.ANTHROPIC_BASE_URL;
        const resolvedToken = token || process.env.ANTHROPIC_AUTH_TOKEN;

        if (resolvedBaseUrl) {
            process.env.OPENAI_BASE_URL = resolvedBaseUrl;
        }

        if (resolvedToken) {
            process.env.OPENAI_API_KEY = resolvedToken;
        }

        if (!this.extractor) {
            this.extractor = new AISDKExtractor(this.logger.child('AISDKExtractor'));
        }
    }

    private async ensurePullRequest(task: Task, stepResults: Record<string, any>): Promise<void> {
        const latestRun = task.latest_run;
        const existingPr =
            latestRun?.output && typeof latestRun.output === 'object'
                ? (latestRun.output as any).pr_url
                : null;

        if (existingPr) {
            this.logger.info('PR already exists, skipping creation', { taskId: task.id, prUrl: existingPr });
            return;
        }

        const branchName = await this.gitManager.getCurrentBranch();
        const prUrl = await this.createPullRequest(
            task.id,
            branchName,
            task.title,
            task.description ?? ''
        );

        this.notifyStatus('pr_created', 'Pull request created', { prUrl });

        try {
            await this.attachPullRequestToTask(task.id, prUrl, branchName);
            this.logger.info('PR attached to task successfully', { taskId: task.id, prUrl });
        } catch (error) {
            this.logger.warn('Could not attach PR to task', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Send a PostHog notification (status, artifact, error, etc.)
     */
    sendPostHogNotification(method: 'status' | 'artifact' | 'error', type: string, data: Record<string, any>): void {
        const notification = {
            method: `_posthog/${method}` as const,
            params: {
                type,
                timestamp: Date.now(),
                _meta: data,
            },
        };

        this.logger.debug('Sending PostHog notification', { method, type, data });
        this.sendNotification(notification);
    }

    /**
     * Log and notify phase start
     */
    notifyPhaseStart(phase: string, data?: Record<string, any>): void {
        this.logger.info(`Starting ${phase} phase`, data);
        this.sendPostHogNotification('status', 'phase_start', { phase, ...data });
    }

    /**
     * Log and notify phase complete
     */
    notifyPhaseComplete(phase: string, data?: Record<string, any>): void {
        this.logger.info(`${phase} phase complete`, data);
        this.sendPostHogNotification('status', 'phase_complete', { phase, ...data });
    }

    /**
     * Log and notify artifact
     */
    notifyArtifact(type: string, content: any, data?: Record<string, any>): void {
        this.logger.info(`Artifact: ${type}`, data);
        this.sendPostHogNotification('artifact', type, { content, ...data });
    }

    /**
     * Log and notify error
     */
    notifyError(type: string, message: string, error?: Error | any): void {
        this.logger.error(message, error);
        this.sendPostHogNotification('error', type, {
            message,
            error: error instanceof Error ? error.message : String(error)
        });
    }

    /**
     * Log and notify custom status
     */
    notifyStatus(type: string, message: string, data?: Record<string, any>): void {
        this.logger.info(message, data);
        this.sendPostHogNotification('status', type, data || {});
    }

    /**
     * Send a notification to the user (either ACP SessionNotification or custom PostHog notification)
     * This is the single point where all notifications flow out
     */
    sendNotification(notification: import('./types.js').AgentNotification): void {
        // Log if debug is enabled
        if (this.debug) {
            console.log(JSON.stringify(notification, null, 2));
        }

        // Forward to user-provided handler
        if (this.notificationHandler) {
            this.notificationHandler(notification);
        }
    }
}

export { PermissionMode } from './types.js';
export type {
    Task,
    SupportingFile,
    ExecutionResult,
    AgentConfig,
    AgentNotification,
    PostHogNotification,
    PostHogStatusNotification,
    PostHogArtifactNotification,
    PostHogErrorNotification,
    NotificationHandler
} from './types.js';
