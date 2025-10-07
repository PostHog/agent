import type { WorkflowDefinition } from './workflow-types.js';
import { PostHogAPIClient } from './posthog-api.js';

export class WorkflowRegistry {
  private workflowsById: Map<string, WorkflowDefinition> = new Map();
  private apiClient?: PostHogAPIClient;

  constructor(apiClient?: PostHogAPIClient, staticDefinitions?: WorkflowDefinition[]) {
    this.apiClient = apiClient;
    if (staticDefinitions) {
      for (const w of staticDefinitions) this.workflowsById.set(w.id, w);
    }
  }

  async loadWorkflows(): Promise<void> {
    if (this.apiClient) {
      const workflows = await this.apiClient.listWorkflows();
      for (const w of workflows) this.workflowsById.set(w.id, w);
    }
  }

  getWorkflow(id: string): WorkflowDefinition | undefined {
    return this.workflowsById.get(id);
  }

  listWorkflows(): WorkflowDefinition[] {
    return Array.from(this.workflowsById.values());
  }
}

