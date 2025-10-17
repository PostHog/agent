import type { Task, TaskRun, LogEntry, SupportingFile, PostHogAPIConfig, PostHogResource, ResourceType, UrlMention } from './types.js';
import type { WorkflowDefinition, AgentDefinition } from './workflow-types.js';

interface PostHogApiResponse<T> {
  results?: T[];
  count?: number;
  next?: string | null;
  previous?: string | null;
}

export interface TaskRunUpdate {
  status?: TaskRun["status"];
  branch?: string | null;
  current_stage?: string | null;
  log?: LogEntry[];
  error_message?: string | null;
  output?: Record<string, unknown> | null;
  state?: Record<string, unknown>;
}

export class PostHogAPIClient {
  private config: PostHogAPIConfig;
  private _teamId: number | null = null;

  constructor(config: PostHogAPIConfig) {
    this.config = config;
  }

  private get baseUrl(): string {
    const host = this.config.apiUrl.endsWith("/") 
      ? this.config.apiUrl.slice(0, -1) 
      : this.config.apiUrl;
    return host;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async apiRequest<T>(
    endpoint: string, 
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers,
      },
    });

    if (!response.ok) {
      let errorMessage: string;
      try {
        const errorResponse = await response.json();
        errorMessage = `Failed request: [${response.status}] ${JSON.stringify(errorResponse)}`;
      } catch {
        errorMessage = `Failed request: [${response.status}] ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }

  async getTeamId(): Promise<number> {
    if (this._teamId !== null) {
      return this._teamId;
    }

    // Fetch user info to get team ID (following Array's pattern)
    const userResponse = await this.apiRequest<any>('/api/users/@me/');

    if (!userResponse.team?.id) {
      throw new Error('No team found for user');
    }

    const teamId = Number(userResponse.team.id);
    this._teamId = teamId;
    return teamId;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getApiKey(): string {
    return this.config.apiKey;
  }

  async getLlmGatewayUrl(): Promise<string> {
    const teamId = await this.getTeamId();
    return `${this.baseUrl}/api/projects/${teamId}/llm_gateway`;
  }

  async fetchTask(taskId: string): Promise<Task> {
    const teamId = await this.getTeamId();
    return this.apiRequest<Task>(`/api/projects/${teamId}/tasks/${taskId}/`);
  }

  async listTasks(filters?: {
    repository?: string;
    organization?: string;
    origin_product?: string;
    workflow?: string;
    current_stage?: string;
  }): Promise<Task[]> {
    const teamId = await this.getTeamId();
    const url = new URL(`${this.baseUrl}/api/projects/${teamId}/tasks/`);
    
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value) url.searchParams.append(key, value);
      });
    }

    const response = await this.apiRequest<PostHogApiResponse<Task>>(
      url.pathname + url.search
    );
    
    return response.results || [];
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    const teamId = await this.getTeamId();
    return this.apiRequest<Task>(`/api/projects/${teamId}/tasks/${taskId}/`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  }

  // TaskRun methods
  async listTaskRuns(taskId: string): Promise<TaskRun[]> {
    const teamId = await this.getTeamId();
    const response = await this.apiRequest<PostHogApiResponse<TaskRun>>(
      `/api/projects/${teamId}/tasks/${taskId}/runs/`
    );
    return response.results || [];
  }

  async getTaskRun(taskId: string, runId: string): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/${runId}/`);
  }

  async createTaskRun(
    taskId: string,
    payload?: Partial<Omit<TaskRun, 'id' | 'task' | 'team' | 'created_at' | 'updated_at' | 'completed_at'>>
  ): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/`, {
      method: "POST",
      body: JSON.stringify(payload || {}),
    });
  }

  async updateTaskRun(
    taskId: string,
    runId: string,
    payload: TaskRunUpdate
  ): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/${runId}/`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }

  async updateTaskRunStage(taskId: string, runId: string, stageId: string): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/${runId}/update_stage/`, {
      method: 'PATCH',
      body: JSON.stringify({ current_stage: stageId }),
    });
  }

  async progressTaskRun(taskId: string, runId: string, nextStageId?: string): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    const payload: Record<string, string> = {};
    if (nextStageId) {
      payload.next_stage_id = nextStageId;
    }
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/${runId}/progress_run/`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async setTaskRunOutput(taskId: string, runId: string, output: Record<string, unknown>): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/${runId}/set_output/`, {
      method: 'PATCH',
      body: JSON.stringify({ output }),
    });
  }

  async appendTaskRunLog(taskId: string, runId: string, entries: LogEntry[]): Promise<TaskRun> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskRun>(`/api/projects/${teamId}/tasks/${taskId}/runs/${runId}/append_log/`, {
      method: 'POST',
      body: JSON.stringify({ entries }),
    });
  }

  // Workflow endpoints
  async fetchWorkflow(workflowId: string): Promise<WorkflowDefinition> {
    const teamId = await this.getTeamId();
    return this.apiRequest<WorkflowDefinition>(`/api/projects/${teamId}/workflows/${workflowId}/`);
  }

  async listWorkflows(): Promise<WorkflowDefinition[]> {
    const teamId = await this.getTeamId();
    const response = await this.apiRequest<PostHogApiResponse<WorkflowDefinition>>(`/api/projects/${teamId}/workflows/`);
    return response.results || [];
  }

  // Agent catalog exposure
  async listAgents(): Promise<AgentDefinition[]> {
    return this.apiRequest<AgentDefinition[]>(`/api/agents/`);
  }

  /**
   * Fetch error details from PostHog error tracking
   */
  async fetchErrorDetails(errorId: string, projectId?: string): Promise<PostHogResource> {
    const teamId = projectId ? parseInt(projectId) : await this.getTeamId();
    
    try {
      const errorData = await this.apiRequest<any>(`/api/projects/${teamId}/error_tracking/${errorId}/`);
      
      // Format error details for agent consumption
      const content = this.formatErrorContent(errorData);
      
      return {
        type: 'error',
        id: errorId,
        url: `${this.baseUrl}/project/${teamId}/error_tracking/${errorId}`,
        title: errorData.exception_type || 'Unknown Error',
        content,
        metadata: {
          exception_type: errorData.exception_type,
          first_seen: errorData.first_seen,
          last_seen: errorData.last_seen,
          volume: errorData.volume,
          users_affected: errorData.users_affected,
        },
      };
    } catch (error) {
      throw new Error(`Failed to fetch error details for ${errorId}: ${error}`);
    }
  }

  /**
   * Generic resource fetcher by URL or ID
   */
  async fetchResourceByUrl(urlMention: UrlMention): Promise<PostHogResource> {
    switch (urlMention.type) {
      case 'error':
        if (!urlMention.id) {
          throw new Error('Error ID is required for error resources');
        }
        // Extract project ID from URL if available, otherwise use default team
        let projectId: string | undefined;
        if (urlMention.url) {
          const projectIdMatch = urlMention.url.match(/\/project\/(\d+)\//);
          projectId = projectIdMatch ? projectIdMatch[1] : undefined;
        }
        return this.fetchErrorDetails(urlMention.id, projectId);
      
      case 'experiment':
      case 'insight':
      case 'feature_flag':
        throw new Error(`Resource type '${urlMention.type}' not yet implemented`);
      
      case 'generic':
        // Return a minimal resource for generic URLs
        return {
          type: 'generic',
          id: '',
          url: urlMention.url,
          title: 'Generic Resource',
          content: `Generic resource: ${urlMention.url}`,
          metadata: {},
        };
      
      default:
        throw new Error(`Unknown resource type: ${urlMention.type}`);
    }
  }

  /**
   * Format error data for agent consumption
   */
  private formatErrorContent(errorData: any): string {
    const sections = [];
    
    if (errorData.exception_type) {
      sections.push(`**Error Type**: ${errorData.exception_type}`);
    }
    
    if (errorData.exception_message) {
      sections.push(`**Message**: ${errorData.exception_message}`);
    }
    
    if (errorData.stack_trace) {
      sections.push(`**Stack Trace**:\n\`\`\`\n${errorData.stack_trace}\n\`\`\``);
    }
    
    if (errorData.volume) {
      sections.push(`**Volume**: ${errorData.volume} occurrences`);
    }
    
    if (errorData.users_affected) {
      sections.push(`**Users Affected**: ${errorData.users_affected}`);
    }
    
    if (errorData.first_seen && errorData.last_seen) {
      sections.push(`**First Seen**: ${errorData.first_seen}`);
      sections.push(`**Last Seen**: ${errorData.last_seen}`);
    }
    
    if (errorData.properties && Object.keys(errorData.properties).length > 0) {
      sections.push(`**Properties**: ${JSON.stringify(errorData.properties, null, 2)}`);
    }
    
    return sections.join('\n\n');
  }
}
