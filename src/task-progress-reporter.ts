import type { Logger } from './utils/logger.js';
import type { PostHogAPIClient, TaskRunUpdate } from './posthog-api.js';
import type { AgentEvent, TaskRun } from './types.js';

interface ProgressMetadata {
  totalSteps?: number;
}

/**
 * Persists task execution progress to PostHog so clients can poll for updates.
 *
 * The reporter is intentionally best-effort – failures are logged but never
 * allowed to break the agent execution flow.
 */
export class TaskProgressReporter {
  private posthogAPI?: PostHogAPIClient;
  private logger: Logger;
  private taskRun?: TaskRun;
  private taskId?: string;
  private outputLog: string[] = [];
  private totalSteps?: number;
  private lastLogEntry?: string;

  constructor(posthogAPI: PostHogAPIClient | undefined, logger: Logger) {
    this.posthogAPI = posthogAPI;
    this.logger = logger.child('TaskProgressReporter');
  }

  get runId(): string | undefined {
    return this.taskRun?.id;
  }

  async start(taskId: string, metadata: ProgressMetadata = {}): Promise<void> {
    if (!this.posthogAPI) {
      return;
    }

    this.taskId = taskId;
    this.totalSteps = metadata.totalSteps;

    try {
      const run = await this.posthogAPI.createTaskRun(taskId, {
        status: 'started',
        log: [],
      });
      this.taskRun = run;
      this.outputLog = [];
      this.logger.debug('Created task run', { taskId, runId: run.id });
    } catch (error) {
      this.logger.warn('Failed to create task run', { taskId, error: (error as Error).message });
    }
  }

  async stageStarted(stageKey: string, stageIndex: number): Promise<void> {
    await this.update({
      status: 'in_progress',
    }, `Stage started: ${stageKey}`);
  }

  async stageCompleted(stageKey: string, completedStages: number): Promise<void> {
    await this.update({
      status: 'in_progress',
    }, `Stage completed: ${stageKey}`);
  }

  async branchCreated(stageKey: string, branchName: string): Promise<void> {
    await this.appendLog(`Branch created (${stageKey}): ${branchName}`);
  }

  async commitMade(stageKey: string, kind: 'plan' | 'implementation'): Promise<void> {
    await this.appendLog(`Commit made (${stageKey}, ${kind})`);
  }

  async pullRequestCreated(stageKey: string, prUrl: string): Promise<void> {
    await this.appendLog(`Pull request created (${stageKey}): ${prUrl}`);
  }

  async noNextStage(stageKey?: string): Promise<void> {
    await this.appendLog(
      stageKey
        ? `No next stage available after '${stageKey}'. Execution halted.`
        : 'No next stage available. Execution halted.'
    );
  }

  async complete(): Promise<void> {
    await this.update({ status: 'completed' }, 'Workflow execution completed');
  }

  async fail(error: Error | string): Promise<void> {
    const message = typeof error === 'string' ? error : error.message;
    await this.update({ status: 'failed', error_message: message }, `Workflow execution failed: ${message}`);
  }

  async appendLog(line: string): Promise<void> {
    await this.update({}, line);
  }

  async recordEvent(event: AgentEvent): Promise<void> {
    if (!this.posthogAPI || !this.runId || !this.taskId) {
      return;
    }

    switch (event.type) {
      case 'token':
      case 'message_delta':
      case 'content_block_start':
      case 'content_block_stop':
      case 'compact_boundary':
      case 'message_start':
      case 'message_stop':
      case 'metric':
      case 'artifact':
      case 'raw_sdk_event':
        // Skip verbose streaming artifacts from persistence
        return;

      case 'tool_call': {
        const logLine = this.formatToolCallEvent(event);
        if (logLine) {
          await this.appendLog(logLine);
        }
        return;
      }

      case 'tool_result': {
        const logLine = this.formatToolResultEvent(event);
        if (logLine) {
          await this.appendLog(logLine);
        }
        return;
      }

      case 'status':
        // Status events are covered by dedicated progress updates
        return;

      case 'error':
        await this.appendLog(`[error] ${event.message}`);
        return;

      case 'done': {
        const cost = event.totalCostUsd !== undefined ? ` cost=$${event.totalCostUsd.toFixed(2)}` : '';
        await this.appendLog(
          `[done] duration=${event.durationMs ?? 'unknown'}ms turns=${event.numTurns ?? 'unknown'}${cost}`
        );
        return;
      }

      case 'init':
        // Omit verbose init messages from persisted log
        return;

      case 'user_message': {
        const summary = this.summarizeUserMessage(event.content);
        if (summary) {
          await this.appendLog(summary);
        }
        return;
      }

      default:
        // For any unfamiliar event types, avoid spamming the log.
        return;
    }
  }

  private async update(update: TaskRunUpdate, logLine?: string): Promise<void> {
    if (!this.posthogAPI || !this.runId || !this.taskId) {
      return;
    }

    // If there's a log line, append it separately using the append_log endpoint
    if (logLine && logLine !== this.lastLogEntry) {
      try {
        await this.posthogAPI.appendTaskRunLog(this.taskId, this.runId, [
          { type: 'info', message: logLine }
        ]);
        this.lastLogEntry = logLine;
      } catch (error) {
        this.logger.warn('Failed to append log entry', {
          taskId: this.taskId,
          runId: this.runId,
          error: (error as Error).message,
        });
      }
    }

    // Update other fields if provided
    if (Object.keys(update).length > 0) {
      try {
        const run = await this.posthogAPI.updateTaskRun(this.taskId, this.runId, update);
        this.taskRun = run;
      } catch (error) {
        this.logger.warn('Failed to update task run', {
          taskId: this.taskId,
          runId: this.runId,
          error: (error as Error).message,
        });
      }
    }
  }

  private summarizeUserMessage(content?: string): string | null {
    if (!content) {
      return null;
    }
    const trimmed = content.trim();
    if (!trimmed) {
      return null;
    }

    const fileUpdateMatch = trimmed.match(/The file\s+([^\s]+)\s+has been updated/i);
    if (fileUpdateMatch) {
      return `[user] file updated: ${fileUpdateMatch[1]}`;
    }

    if (/Todos have been modified/i.test(trimmed)) {
      return '[todo] list updated';
    }

    const diffMatch = trimmed.match(/diff --git a\/([^\s]+) b\/([^\s]+)/);
    if (diffMatch) {
      return `[diff] ${diffMatch[2] ?? diffMatch[1]}`;
    }

    const gitStatusMatch = trimmed.match(/^On branch ([^\n]+)/);
    if (gitStatusMatch) {
      return `[git] status ${gitStatusMatch[1]}`;
    }

    if (/This Bash command contains multiple operations/i.test(trimmed)) {
      return '[approval] multi-step command pending';
    }

    if (/This command requires approval/i.test(trimmed)) {
      return '[approval] command awaiting approval';
    }

    if (/^Exit plan mode\?/i.test(trimmed)) {
      return null;
    }

    if (trimmed.includes('node_modules')) {
      return null;
    }

    if (trimmed.includes('total ') && trimmed.includes('drwx')) {
      return null;
    }

    if (trimmed.includes('→')) {
      return null;
    }

    if (trimmed.split('\n').length > 2) {
      return null;
    }

    const normalized = trimmed.replace(/\s+/g, ' ');
    const maxLen = 120;
    if (!normalized) {
      return null;
    }
    const preview = normalized.length > maxLen ? `${normalized.slice(0, maxLen)}…` : normalized;
    return `[user] ${preview}`;
  }


  private truncateMultiline(text: string, max = 160): string {
    if (!text) {
      return '';
    }
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > max ? `${compact.slice(0, max)}…` : compact;
  }

  private formatToolCallEvent(event: Extract<AgentEvent, { type: 'tool_call' }>): string | null {
    // File operations to track
    const fileOps = ['read_file', 'write', 'search_replace', 'delete_file', 'glob_file_search', 'file_search', 'list_dir', 'edit_notebook'];
    // Terminal commands to track
    const terminalOps = ['run_terminal_cmd', 'bash', 'shell'];

    if (fileOps.includes(event.toolName)) {
      // Extract file path from args
      const path = event.args?.target_file || event.args?.file_path || event.args?.target_notebook || event.args?.target_directory || '';
      return `[tool] ${event.toolName}${path ? `: ${path}` : ''}`;
    } else if (terminalOps.includes(event.toolName)) {
      // Extract command from args
      const cmd = event.args?.command || '';
      const truncated = cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
      return `[cmd] ${truncated}`;
    }

    // Skip other tools from persistence
    return null;
  }

  private formatToolResultEvent(event: Extract<AgentEvent, { type: 'tool_result' }>): string | null {
    // We don't need to log tool results separately - tool calls are sufficient
    // This keeps the log concise
    return null;
  }
}
