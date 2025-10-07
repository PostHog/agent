import { query } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './utils/logger';
import { EventTransformer } from './event-transformer';
import { AgentRegistry } from './agent-registry';
import type { Task } from './types';
import type { WorkflowStage, WorkflowStageExecutionResult, WorkflowExecutionOptions } from './workflow-types';
import { PLANNING_SYSTEM_PROMPT } from './agents/planning';
import { EXECUTION_SYSTEM_PROMPT } from './agents/execution';
import { PromptBuilder } from './prompt-builder';
import { POSTHOG_MCP } from './utils/mcp';

export class StageExecutor {
  private registry: AgentRegistry;
  private logger: Logger;
  private eventTransformer: EventTransformer;
  private promptBuilder: PromptBuilder;

  constructor(registry: AgentRegistry, logger: Logger, promptBuilder?: PromptBuilder) {
    this.registry = registry;
    this.logger = logger.child('StageExecutor');
    this.eventTransformer = new EventTransformer();
    this.promptBuilder = promptBuilder || new PromptBuilder({
      getTaskFiles: async () => [],
      generatePlanTemplate: async () => '',
      logger,
    });
  }

  async execute(task: Task, stage: WorkflowStage, options: WorkflowExecutionOptions): Promise<WorkflowStageExecutionResult> {
    const isManual = stage.is_manual_only === true;
    if (isManual) {
      this.logger.info('Manual stage detected; skipping agent execution', { stage: stage.key });
      return { results: [] };
    }

    const inferredAgent = stage.key.toLowerCase().includes('plan') ? 'planning_basic' : 'code_generation';
    const agentName = stage.agent_name || inferredAgent;
    const agent = this.registry.getAgent(agentName);
    if (!agent) {
      throw new Error(`Unknown agent '${agentName}' for stage '${stage.key}'`);
    }

    const permissionMode = (options.permissionMode as any) || 'acceptEdits';
    const cwd = options.repositoryPath || process.cwd();

    switch (agent.agent_type) {
      case 'planning':
        return this.runPlanning(task, cwd, options, stage.key);
      case 'execution':
        return this.runExecution(task, cwd, permissionMode, options, stage.key);
      case 'review': // TODO: Implement review
      case 'testing': // TODO: Implement testing
      default:
        // throw new Error(`Unsupported agent type: ${agent.agent_type}`);
        console.warn(`Unsupported agent type: ${agent.agent_type}`);
        return { results: [] };
    }
  }

  private async runPlanning(task: Task, cwd: string, options: WorkflowExecutionOptions, stageKey: string): Promise<WorkflowStageExecutionResult> {
    const contextPrompt = await this.promptBuilder.buildPlanningPrompt(task);
    let prompt = PLANNING_SYSTEM_PROMPT + '\n\n' + contextPrompt;

    const stageOverrides = options.stageOverrides?.[stageKey] || options.stageOverrides?.['plan'];
    const mergedOverrides = {
      ...(options.queryOverrides || {}),
      ...(stageOverrides?.queryOverrides || {}),
    } as Record<string, any>;

    const baseOptions: Record<string, any> = {
      model: 'claude-sonnet-4-5-20250929',
      cwd,
      permissionMode: 'plan',
      settingSources: ['local'],
      mcpServers: {
        ...POSTHOG_MCP
      }
    };

    const response = query({
      prompt,
      options: { ...baseOptions, ...mergedOverrides },
    });

    let plan = '';
    for await (const message of response) {
      const transformed = this.eventTransformer.transform(message);
      if (transformed && transformed.type !== 'token') {
        this.logger.debug('Planning event', { type: transformed.type });
      }
      if (message.type === 'assistant' && message.message?.content) {
        for (const c of message.message.content) {
          if (c.type === 'text' && c.text) plan += c.text + '\n';
        }
      }
    }

    return { plan: plan.trim() };
  }

  private async runExecution(task: Task, cwd: string, permissionMode: WorkflowExecutionOptions['permissionMode'], options: WorkflowExecutionOptions, stageKey: string): Promise<WorkflowStageExecutionResult> {
    const contextPrompt = await this.promptBuilder.buildExecutionPrompt(task);
    let prompt = EXECUTION_SYSTEM_PROMPT + '\n\n' + contextPrompt;

    const stageOverrides = options.stageOverrides?.[stageKey];
    const mergedOverrides = {
      ...(options.queryOverrides || {}),
      ...(stageOverrides?.queryOverrides || {}),
    } as Record<string, any>;

    const baseOptions: Record<string, any> = {
      model: 'claude-sonnet-4-5-20250929',
      cwd,
      permissionMode,
      settingSources: ['local'],
      mcpServers: {
        ...POSTHOG_MCP
      }
    };

    const response = query({
      prompt,
      options: { ...baseOptions, ...mergedOverrides },
    });
    const results: any[] = [];
    for await (const message of response) {
      const transformed = this.eventTransformer.transform(message);
      if (transformed && transformed.type !== 'token') {
        this.logger.debug('Execution event', { type: transformed.type });
      }
      results.push(message);
    }
    return { results };
  }
}


