import type { Logger } from './utils/logger.js';
import type { PostHogAPIClient, TaskRunUpdate } from './posthog-api.js';
import type { TaskRun } from './types.js';

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
  private lastLogEntry?: string;

  constructor(posthogAPI: PostHogAPIClient | undefined, logger: Logger) {
    this.posthogAPI = posthogAPI;
    this.logger = logger.child('TaskProgressReporter');
  }

  get runId(): string | undefined {
    return this.taskRun?.id;
  }

  async start(taskId: string, _metadata: ProgressMetadata = {}): Promise<void> {
    if (!this.posthogAPI) {
      return;
    }

    this.taskId = taskId;

    try {
      const run = await this.posthogAPI.createTaskRun(taskId, {
        status: 'started',
        log: [],
      });
      this.taskRun = run;
      this.logger.debug('Created task run', { taskId, runId: run.id });
    } catch (error) {
      this.logger.warn('Failed to create task run', { taskId, error: (error as Error).message });
    }
  }

  async complete(): Promise<void> {
    await this.update({ status: 'completed' }, 'Task execution completed');
  }

  async fail(error: Error | string): Promise<void> {
    const message = typeof error === 'string' ? error : error.message;
    await this.update({ status: 'failed', error_message: message }, `Task execution failed: ${message}`);
  }

  async appendLog(line: string): Promise<void> {
    await this.update({}, line);
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

}
