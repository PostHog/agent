
// import and export to keep a single type file
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
export type { CanUseTool, PermissionResult };

// PostHog Task model (matches Array's OpenAPI schema)
export interface Task {
  id: string;
  title: string;
  description: string;
  origin_product: 'error_tracking' | 'eval_clusters' | 'user_created' | 'support_queue' | 'session_summaries';
  position?: number;
  github_integration?: number | null;
  repository_config?: unknown; // JSONField
  repository_list: string;
  primary_repository: string;
  created_at: string;
  updated_at: string;

  // DEPRECATED: These fields have been moved to TaskRun
  // Use task.latest_run instead
  current_stage?: string | null;
  github_branch?: string | null;
  github_pr_url?: string | null;
  latest_run?: TaskRun;
}

// Log entry structure for TaskRun.log
export interface LogEntry {
  type: string; // e.g., "info", "warning", "error", "success", "debug"
  message: string;
  [key: string]: unknown; // Allow additional fields
}

// TaskRun model - represents individual execution runs of tasks
export interface TaskRun {
  id: string;
  task: string; // Task ID
  team: number;
  branch: string | null;
  status: 'started' | 'in_progress' | 'completed' | 'failed';
  log: LogEntry[]; // Array of log entry objects
  error_message: string | null;
  output: Record<string, unknown> | null; // Structured output (PR URL, commit SHA, etc.)
  state: Record<string, unknown>; // Intermediate run state (defaults to {}, never null)
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SupportingFile {
  name: string;
  content: string;
  type: 'plan' | 'context' | 'reference' | 'output';
  created_at: string;
}

export enum PermissionMode {
  PLAN = "plan",
  DEFAULT = "default",
  ACCEPT_EDITS = "acceptEdits",
  BYPASS = "bypassPermissions"
}

export interface ExecutionOptions {
  repositoryPath?: string;
  permissionMode?: PermissionMode;
}

export interface TaskExecutionOptions {
  repositoryPath?: string;
  permissionMode?: PermissionMode;
  isCloudMode?: boolean; // Determines local vs cloud behavior (local pauses after each phase)
  createPR?: boolean; // Whether to create PR after build (defaults to false if local. This setting has no effect if isCloudMode is true.)
  autoProgress?: boolean;
  queryOverrides?: Record<string, any>;
  // Fine-grained permission control (only applied to build phase)
  // See: https://docs.claude.com/en/api/agent-sdk/permissions
  canUseTool?: CanUseTool;
}


export interface ExecutionResult {
  results: any[];
}

export interface PlanResult {
  plan: string;
}

export interface TaskExecutionResult {
  task: Task;
  plan?: string;
  executionResult?: ExecutionResult;
}

// MCP Server configuration types (re-exported from Claude SDK for convenience)
export type McpServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
} | {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
} | {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
} | {
  type: 'sdk';
  name: string;
  instance?: any; // McpServer instance
};

// Notification types
export interface PostHogStatusNotification {
  method: '_posthog/status';
  params: {
    type: string;
    timestamp: number;
    _meta: Record<string, any>;
  };
}

export interface PostHogArtifactNotification {
  method: '_posthog/artifact';
  params: {
    type: string;
    timestamp: number;
    _meta: Record<string, any>;
  };
}

export interface PostHogErrorNotification {
  method: '_posthog/error';
  params: {
    type: string;
    timestamp: number;
    _meta: Record<string, any>;
  };
}

export type PostHogNotification =
  | PostHogStatusNotification
  | PostHogArtifactNotification
  | PostHogErrorNotification;

export type AgentNotification =
  | import('@agentclientprotocol/sdk').SessionNotification
  | PostHogNotification;

export type NotificationHandler = (notification: AgentNotification) => void;

export interface AgentConfig {
  workingDirectory?: string;

  // Provider configuration
  provider?: 'claude'; // Agent provider. Only 'claude' is supported currently (uses claude-code-acp). Future: 'codex', etc.

  // PostHog API configuration
  posthogApiUrl?: string;
  posthogApiKey?: string;

  // PostHog MCP configuration
  posthogMcpUrl?: string;

  // MCP Server configuration
  // Additional MCP servers (PostHog MCP is always included by default)
  // You can override the PostHog MCP config by providing mcpServers.posthog
  mcpServers?: Record<string, McpServerConfig>;

  // Logging configuration
  debug?: boolean;

  // Notification handler - receives all ACP and PostHog notifications
  onNotification?: NotificationHandler;

  // Fine-grained permission control for direct run() calls
  // See: https://docs.claude.com/en/api/agent-sdk/permissions
  canUseTool?: CanUseTool;
}

export interface PostHogAPIConfig {
  apiUrl: string;
  apiKey: string;
}

// URL mention types
export type ResourceType = 'error' | 'experiment' | 'insight' | 'feature_flag' | 'generic';

export interface PostHogResource {
  type: ResourceType;
  id: string;
  url: string;
  title?: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface UrlMention {
  url: string;
  type: ResourceType;
  id?: string;
  label?: string;
}