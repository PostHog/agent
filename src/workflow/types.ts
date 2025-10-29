import type { Task, TaskExecutionOptions, PermissionMode } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { PostHogFileManager } from '../file-manager.js';
import type { GitManager } from '../git-manager.js';
import type { PromptBuilder } from '../prompt-builder.js';
import type { TaskProgressReporter } from '../task-progress-reporter.js';
import type { PostHogAPIClient } from '../posthog-api.js';
import type { StructuredExtractor } from '../structured-extraction.js';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ACPWrapper } from '../acp-wrapper.js';

export interface WorkflowRuntime {
    task: Task;
    taskSlug: string;
    cwd: string;
    isCloudMode: boolean;
    options: TaskExecutionOptions;
    logger: Logger;
    fileManager: PostHogFileManager;
    gitManager: GitManager;
    promptBuilder: PromptBuilder;
    progressReporter: TaskProgressReporter;
    mcpServers?: Record<string, any>;
    posthogAPI?: PostHogAPIClient;
    extractor?: StructuredExtractor;
    emitEvent: (event: SessionNotification | { method: string; params: Record<string, unknown> }) => void;
    stepResults: Record<string, any>;
    currentWrapper: { wrapper?: ACPWrapper }; // Shared reference for cancellation
}

export interface WorkflowStepDefinition {
    id: string;
    name: string;
    agent: string;
    model: string;
    permissionMode?: PermissionMode | string;
    commit?: boolean;
    push?: boolean;
    run: WorkflowStepRunner;
}

export interface WorkflowStepRuntime {
    step: WorkflowStepDefinition;
    context: WorkflowRuntime;
}

export interface WorkflowStepResult {
    status: 'completed' | 'skipped';
    halt?: boolean;
}

export type WorkflowStepRunner = (runtime: WorkflowStepRuntime) => Promise<WorkflowStepResult>;

export type WorkflowDefinition = WorkflowStepDefinition[];
