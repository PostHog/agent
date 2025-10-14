import type { Task, SupportingFile, PostHogAPIConfig, PostHogResource, ResourceType, UrlMention } from './types.js';
import type { WorkflowDefinition, AgentDefinition } from './workflow-types.js';

interface PostHogApiResponse<T> {
  results?: T[];
  count?: number;
  next?: string | null;
  previous?: string | null;
}

interface TaskProgressResponse {
  has_progress: boolean;
  id?: string;
  status?: "started" | "in_progress" | "completed" | "failed";
  current_step?: string;
  completed_steps?: number;
  total_steps?: number;
  progress_percentage?: number;
  output_log?: string;
  error_message?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  workflow_id?: string;
  workflow_run_id?: string;
  message?: string;
}

export interface TaskProgressRecord {
  id: string;
  task: string;
  status: "started" | "in_progress" | "completed" | "failed";
  current_step?: string | null;
  completed_steps?: number | null;
  total_steps?: number | null;
  progress_percentage?: number | null;
  output_log?: string | null;
  error_message?: string | null;
  workflow_id?: string | null;
  workflow_run_id?: string | null;
  activity_id?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

export interface TaskProgressUpdate {
  status?: TaskProgressRecord["status"];
  current_step?: string | null;
  completed_steps?: number | null;
  total_steps?: number | null;
  output_log?: string | null;
  error_message?: string | null;
  workflow_id?: string | null;
  workflow_run_id?: string | null;
  activity_id?: string | null;
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

  async updateTaskStage(taskId: string, stageId: string): Promise<Task> {
    const teamId = await this.getTeamId();
    return this.apiRequest<Task>(`/api/projects/${teamId}/tasks/${taskId}/update_stage/`, {
      method: 'PATCH',
      body: JSON.stringify({ current_stage: stageId }),
    });
  }

  async setTaskBranch(taskId: string, branch: string): Promise<Task> {
    const teamId = await this.getTeamId();
    return this.apiRequest<Task>(`/api/projects/${teamId}/tasks/${taskId}/set_branch/`, {
      method: "POST",
      body: JSON.stringify({ branch }),
    });
  }

  async attachTaskPullRequest(taskId: string, prUrl: string, branch?: string): Promise<Task> {
    const teamId = await this.getTeamId();
    const payload: Record<string, string> = { pr_url: prUrl };
    if (branch) {
      payload.branch = branch;
    }
    return this.apiRequest<Task>(`/api/projects/${teamId}/tasks/${taskId}/attach_pr/`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async getTaskProgress(taskId: string): Promise<TaskProgressResponse> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskProgressResponse>(`/api/projects/${teamId}/tasks/${taskId}/progress/`);
  }

  async createTaskProgress(
    taskId: string,
    payload: TaskProgressUpdate & { status: TaskProgressRecord["status"] }
  ): Promise<TaskProgressRecord> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskProgressRecord>(`/api/projects/${teamId}/task_progress/`, {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        task: taskId,
      }),
    });
  }

  async updateTaskProgress(
    taskId: string,
    progressId: string,
    payload: TaskProgressUpdate
  ): Promise<TaskProgressRecord> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskProgressRecord>(`/api/projects/${teamId}/task_progress/${progressId}/`, {
      method: "PATCH",
      body: JSON.stringify({
        ...payload,
        task: taskId,
      }),
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

  async progressTask(taskId: string, options?: { next_stage_id?: string; auto?: boolean }): Promise<Task> {
    const teamId = await this.getTeamId();
    return this.apiRequest<Task>(`/api/projects/${teamId}/tasks/${taskId}/progress_task/`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
    });
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
