import { Task, SupportingFile, PostHogAPIConfig } from './types';

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

  private async getTeamId(): Promise<number> {
    if (this._teamId) {
      return this._teamId;
    }

    // Fetch user info to get team ID (following Array's pattern)
    const userResponse = await this.apiRequest<any>('/api/users/@me/');
    
    if (!userResponse.team?.id) {
      throw new Error('No team found for user');
    }

    this._teamId = userResponse.team.id;
    return this._teamId;
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

  async getTaskProgress(taskId: string): Promise<TaskProgressResponse> {
    const teamId = await this.getTeamId();
    return this.apiRequest<TaskProgressResponse>(`/api/projects/${teamId}/tasks/${taskId}/progress/`);
  }

}