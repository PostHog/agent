import type { AgentDefinition, AgentType } from './workflow-types.js';

export class AgentRegistry {
  private agentsByName: Map<string, AgentDefinition> = new Map();

  constructor(definitions?: AgentDefinition[]) {
    if (definitions) {
      for (const def of definitions) this.register(def);
    } else {
      for (const def of AgentRegistry.getDefaultAgents()) this.register(def);
    }
  }

  static getDefaultAgents(): AgentDefinition[] {
    return [
      {
        id: 'research',
        name: 'research',
        agent_type: 'research',
        description: 'Explore codebase and generate clarifying questions',
      },
      {
        id: 'planning',
        name: 'planning',
        agent_type: 'planning',
        description: 'Analyze repo and produce implementation plan',
      },
      {
        id: 'code_generation',
        name: 'code_generation',
        agent_type: 'execution',
        description: 'Implements code changes using Claude SDK',
      },
      {
        id: 'review',
        name: 'review',
        agent_type: 'review',
        description: 'Reviews changes and suggests fixes',
      },
      {
        id: 'testing',
        name: 'testing',
        agent_type: 'testing',
        description: 'Runs tests and reports results',
      },
    ];
  }

  register(def: AgentDefinition): void {
    this.agentsByName.set(def.name, def);
  }

  getAgent(name: string): AgentDefinition | undefined {
    return this.agentsByName.get(name);
  }

  listAgents(): AgentDefinition[] {
    return Array.from(this.agentsByName.values());
  }

  exportForPostHog(): { id: string; name: string; agent_type: AgentType; description?: string }[] {
    return this.listAgents().map(({ id, name, agent_type, description }) => ({ id, name, agent_type, description }));
  }
}

