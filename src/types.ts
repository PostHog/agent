// PostHog Task model (matches Array's OpenAPI schema)
export interface Task {
  id: string;
  title: string;
  description: string;
  origin_product: 'error_tracking' | 'eval_clusters' | 'user_created' | 'support_queue' | 'session_summaries';
  position?: number;
  workflow?: string | null;
  current_stage?: string | null;
  github_integration?: number | null;
  repository_config?: unknown; // JSONField
  repository_list: string;
  primary_repository: string;
  github_branch: string | null;
  github_pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportingFile {
  name: string;
  content: string;
  type: 'plan' | 'context' | 'reference' | 'output';
  created_at: string;
}

// Removed legacy ExecutionMode in favor of configurable workflows

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

// Base event with timestamp
interface BaseEvent {
  ts: number;
}

// Streaming content events
export interface TokenEvent extends BaseEvent {
  type: 'token';
  content: string;
  contentType?: 'text' | 'thinking' | 'tool_input';
}

export interface ContentBlockStartEvent extends BaseEvent {
  type: 'content_block_start';
  index: number;
  contentType: 'text' | 'tool_use' | 'thinking';
  toolName?: string;
  toolId?: string;
}

export interface ContentBlockStopEvent extends BaseEvent {
  type: 'content_block_stop';
  index: number;
}

// Tool events
export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  toolName: string;
  callId: string;
  args: Record<string, any>;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolName: string;
  callId: string;
  result: any;
}

// Message lifecycle events
export interface MessageStartEvent extends BaseEvent {
  type: 'message_start';
  messageId?: string;
  model?: string;
}

export interface MessageDeltaEvent extends BaseEvent {
  type: 'message_delta';
  stopReason?: string;
  stopSequence?: string;
  usage?: {
    outputTokens: number;
  };
}

export interface MessageStopEvent extends BaseEvent {
  type: 'message_stop';
}

// User message events
export interface UserMessageEvent extends BaseEvent {
  type: 'user_message';
  content: string;
  isSynthetic?: boolean;
}

// System events
export interface StatusEvent extends BaseEvent {
  type: 'status';
  phase: string;
  [key: string]: any;
}

export interface InitEvent extends BaseEvent {
  type: 'init';
  model: string;
  tools: string[];
  permissionMode: string;
  cwd: string;
  apiKeySource: string;
}

export interface CompactBoundaryEvent extends BaseEvent {
  type: 'compact_boundary';
  trigger: 'manual' | 'auto';
  preTokens: number;
}

// Result events
export interface DoneEvent extends BaseEvent {
  type: 'done';
  durationMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
  usage?: any;
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  message: string;
  error?: any;
  errorType?: string;
  context?: Record<string, any>; // Partial error context for debugging
  sdkError?: any; // Original SDK error object
}

// Legacy events (keeping for backwards compatibility)
export interface DiffEvent extends BaseEvent {
  type: 'diff';
  file: string;
  patch: string;
  summary?: string;
}

export interface FileWriteEvent extends BaseEvent {
  type: 'file_write';
  path: string;
  bytes: number;
}

export interface MetricEvent extends BaseEvent {
  type: 'metric';
  key: string;
  value: number;
  unit?: string;
}

export interface ArtifactEvent extends BaseEvent {
  type: 'artifact';
  kind: string;
  content: any;
}

export interface RawSDKEvent extends BaseEvent {
  type: 'raw_sdk_event';
  sdkMessage: any; // Full SDK message for debugging
}

export type AgentEvent =
  | TokenEvent
  | ContentBlockStartEvent
  | ContentBlockStopEvent
  | ToolCallEvent
  | ToolResultEvent
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | UserMessageEvent
  | StatusEvent
  | InitEvent
  | CompactBoundaryEvent
  | DoneEvent
  | ErrorEvent
  | DiffEvent
  | FileWriteEvent
  | MetricEvent
  | ArtifactEvent
  | RawSDKEvent;

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
  // Deprecated: mode removed in workflow-based execution
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

export interface AgentConfig {
  workingDirectory?: string;
  onEvent?: (event: AgentEvent) => void;

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