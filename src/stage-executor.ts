import { query } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './utils/logger.js';
import { ClaudeAdapter } from './adapters/claude/claude-adapter.js';
import { AgentRegistry } from './agent-registry.js';
import type { AgentEvent, Task, McpServerConfig } from './types.js';
import type { WorkflowStage, WorkflowStageExecutionResult, WorkflowExecutionOptions } from './workflow-types.js';
import { RESEARCH_SYSTEM_PROMPT } from './agents/research.js';
import { PLANNING_SYSTEM_PROMPT } from './agents/planning.js';
import { EXECUTION_SYSTEM_PROMPT } from './agents/execution.js';
import { PromptBuilder } from './prompt-builder.js';

export class StageExecutor {
  private registry: AgentRegistry;
  private logger: Logger;
  private adapter: ClaudeAdapter;
  private promptBuilder: PromptBuilder;
  private eventHandler?: (event: AgentEvent) => void;
  private mcpServers?: Record<string, McpServerConfig>;

  constructor(
    registry: AgentRegistry,
    logger: Logger,
    promptBuilder?: PromptBuilder,
    eventHandler?: (event: AgentEvent) => void,
    mcpServers?: Record<string, McpServerConfig>,
  ) {
    this.registry = registry;
    this.logger = logger.child('StageExecutor');
    this.adapter = new ClaudeAdapter();
    this.promptBuilder = promptBuilder || new PromptBuilder({
      getTaskFiles: async () => [],
      generatePlanTemplate: async () => '',
      logger,
    });
    this.eventHandler = eventHandler;
    this.mcpServers = mcpServers;
  }

  setEventHandler(handler?: (event: AgentEvent) => void): void {
    this.eventHandler = handler;
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
      case 'research':
        return this.runResearch(task, cwd, options, stage.key);
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

  private async runResearch(task: Task, cwd: string, options: WorkflowExecutionOptions, stageKey: string): Promise<WorkflowStageExecutionResult> {
    const contextPrompt = await this.promptBuilder.buildResearchPrompt(task, cwd);
    let prompt = RESEARCH_SYSTEM_PROMPT + '\n\n' + contextPrompt;

    const stageOverrides = options.stageOverrides?.[stageKey] || options.stageOverrides?.['research'];
    const mergedOverrides = {
      ...(options.queryOverrides || {}),
      ...(stageOverrides?.queryOverrides || {}),
    } as Record<string, any>;

    const baseOptions: Record<string, any> = {
      model: 'claude-sonnet-4-5-20250929',
      cwd,
      permissionMode: 'plan',
      settingSources: ['local'],
      mcpServers: this.mcpServers
    };

    const response = query({
      prompt,
      options: { ...baseOptions, ...mergedOverrides },
    });

    let research = '';
    for await (const message of response) {
      // Emit raw SDK event first
      this.eventHandler?.(this.adapter.createRawSDKEvent(message));

      // Then emit transformed event
      const transformed = this.adapter.transform(message);
      if (transformed) {
        if (transformed.type !== 'token') {
          this.logger.debug('Research event', { type: transformed.type });
        }
        this.eventHandler?.(transformed);
      }

      if (message.type === 'assistant' && message.message?.content) {
        for (const c of message.message.content) {
          if (c.type === 'text' && c.text) research += c.text + '\n';
        }
      }
    }

    return { plan: research.trim() }; // Return as 'plan' field to match existing interface
  }

  private async runPlanning(task: Task, cwd: string, options: WorkflowExecutionOptions, stageKey: string): Promise<WorkflowStageExecutionResult> {
    const contextPrompt = await this.promptBuilder.buildPlanningPrompt(task, cwd);
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
      mcpServers: this.mcpServers
    };

    const response = query({
      prompt,
      options: { ...baseOptions, ...mergedOverrides },
    });

    let plan = '';
    for await (const message of response) {
      // Emit raw SDK event first
      this.eventHandler?.(this.adapter.createRawSDKEvent(message));

      // Then emit transformed event
      const transformed = this.adapter.transform(message);
      if (transformed) {
        if (transformed.type !== 'token') {
          this.logger.debug('Planning event', { type: transformed.type });
        }
        this.eventHandler?.(transformed);
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
    const contextPrompt = await this.promptBuilder.buildExecutionPrompt(task, cwd);
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
      mcpServers: this.mcpServers
    };

    const response = query({
      prompt,
      options: { ...baseOptions, ...mergedOverrides },
    });
    const results: any[] = [];
    for await (const message of response) {
      // Emit raw SDK event first
      this.eventHandler?.(this.adapter.createRawSDKEvent(message));

      // Then emit transformed event
      const transformed = this.adapter.transform(message);
      if (transformed) {
        if (transformed.type !== 'token') {
          this.logger.debug('Execution event', { type: transformed.type });
        }
        this.eventHandler?.(transformed);
      }

      results.push(message);
    }
    return { results };
  }
}
