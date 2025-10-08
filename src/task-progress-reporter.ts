import type { Logger } from './utils/logger.js';
import type { PostHogAPIClient, TaskProgressRecord, TaskProgressUpdate } from './posthog-api.js';
import type { AgentEvent } from './types.js';

interface ProgressMetadata {
  workflowId?: string;
  workflowRunId?: string;
  activityId?: string;
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
  private progressRecord?: TaskProgressRecord;
  private taskId?: string;
  private outputLog: string[] = [];
  private totalSteps?: number;
  private lastLogEntry?: string;

  constructor(posthogAPI: PostHogAPIClient | undefined, logger: Logger) {
    this.posthogAPI = posthogAPI;
    this.logger = logger.child('TaskProgressReporter');
  }

  get progressId(): string | undefined {
    return this.progressRecord?.id;
  }

  async start(taskId: string, metadata: ProgressMetadata = {}): Promise<void> {
    if (!this.posthogAPI) {
      return;
    }

    this.taskId = taskId;
    this.totalSteps = metadata.totalSteps;

    try {
      const record = await this.posthogAPI.createTaskProgress(taskId, {
        status: 'started',
        current_step: 'initializing',
        total_steps: metadata.totalSteps ?? 0,
        completed_steps: 0,
        workflow_id: metadata.workflowId,
        workflow_run_id: metadata.workflowRunId,
        activity_id: metadata.activityId,
        output_log: '',
      });
      this.progressRecord = record;
      this.outputLog = record.output_log ? record.output_log.split('\n') : [];
      this.logger.debug('Created task progress record', { taskId, progressId: record.id });
    } catch (error) {
      this.logger.warn('Failed to create task progress record', { taskId, error: (error as Error).message });
    }
  }

  async stageStarted(stageKey: string, stageIndex: number): Promise<void> {
    await this.update({
      status: 'in_progress',
      current_step: stageKey,
      completed_steps: Math.min(stageIndex, this.totalSteps ?? stageIndex),
    }, `Stage started: ${stageKey}`);
  }

  async stageCompleted(stageKey: string, completedStages: number): Promise<void> {
    await this.update({
      status: 'in_progress',
      current_step: stageKey,
      completed_steps: Math.min(completedStages, this.totalSteps ?? completedStages),
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
    await this.update({ status: 'completed', completed_steps: this.totalSteps }, 'Workflow execution completed');
  }

  async fail(error: Error | string): Promise<void> {
    const message = typeof error === 'string' ? error : error.message;
    await this.update({ status: 'failed', error_message: message }, `Workflow execution failed: ${message}`);
  }

  async appendLog(line: string): Promise<void> {
    await this.update({}, line);
  }

  async recordEvent(event: AgentEvent): Promise<void> {
    if (!this.posthogAPI || !this.progressId || !this.taskId) {
      return;
    }

    switch (event.type) {
      case 'token':
      case 'message_delta':
      case 'content_block_start':
      case 'content_block_stop':
      case 'compact_boundary':
      case 'tool_call':
      case 'tool_result':
      case 'message_start':
      case 'message_stop':
      case 'metric':
      case 'artifact':
        // Skip verbose streaming artifacts from persistence
        return;

      case 'file_write':
        await this.appendLog(this.formatFileWriteEvent(event));
        return;

      case 'diff':
        await this.appendLog(this.formatDiffEvent(event));
        return;

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

  private async update(update: TaskProgressUpdate, logLine?: string): Promise<void> {
    if (!this.posthogAPI || !this.progressId || !this.taskId) {
      return;
    }

    if (logLine) {
      if (logLine !== this.lastLogEntry) {
        this.outputLog.push(logLine);
        this.lastLogEntry = logLine;
      }
      update.output_log = this.outputLog.join('\n');
    }

    try {
      const record = await this.posthogAPI.updateTaskProgress(this.taskId, this.progressId, update);
      // Sync local cache with server response to avoid drift if server modifies values
      this.progressRecord = record;
      if (record.output_log !== undefined && record.output_log !== null) {
        this.outputLog = record.output_log ? record.output_log.split('\n') : [];
      }
    } catch (error) {
      this.logger.warn('Failed to update task progress record', {
        taskId: this.taskId,
        progressId: this.progressId,
        error: (error as Error).message,
      });
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

  private formatFileWriteEvent(event: Extract<AgentEvent, { type: 'file_write' }>): string {
    const size = event.bytes !== undefined ? ` (${event.bytes} bytes)` : '';
    return `[file] wrote ${event.path}${size}`;
  }

  private formatDiffEvent(event: Extract<AgentEvent, { type: 'diff' }>): string {
    const summary = event.summary
      ? event.summary.trim()
      : this.truncateMultiline(event.patch ?? '', 160);
    return `[diff] ${event.file}${summary ? ` | ${summary}` : ''}`;
  }

  private truncateMultiline(text: string, max = 160): string {
    if (!text) {
      return '';
    }
    const compact = text.replace(/\s+/g, ' ').trim();
    return compact.length > max ? `${compact.slice(0, max)}…` : compact;
  }
}
