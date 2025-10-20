import type { PermissionMode, AgentEvent } from './types.js';

export type AgentType = 'research' | 'planning' | 'execution' | 'review' | 'testing';

export interface AgentDefinition {
  id: string;
  name: string;
  agent_type: AgentType;
  description?: string;
  config?: Record<string, any>;
}

export interface WorkflowStage {
  id: string;
  key: string;
  name: string;
  position: number;
  agent_name?: string | null;
  is_manual_only?: boolean;
  color?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description?: string;
  stages: WorkflowStage[];
}

export interface StageOverrideOptions {
  permissionMode?: PermissionMode;
  createPlanningBranch?: boolean;
  createImplementationBranch?: boolean;
  openPullRequest?: boolean;
  queryOverrides?: Record<string, any>;
}

export interface WorkflowStageExecutionResult {
  plan?: string;
  results?: any[];
}

export interface WorkflowExecutionOptions {
  repositoryPath?: string;
  permissionMode?: PermissionMode;
  autoProgress?: boolean;
  resumeFromCurrentStage?: boolean;
  stageOverrides?: Record<string, StageOverrideOptions>;
  onEvent?: (event: AgentEvent) => void;
  queryOverrides?: Record<string, any>;
}

