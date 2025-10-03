import type { Task } from './types';
import { Logger } from './logger';

export interface PromptBuilderDeps {
  getTaskFiles: (taskId: string) => Promise<any[]>;
  generatePlanTemplate: (vars: Record<string, string>) => Promise<string>;
  logger?: Logger;
}

export class PromptBuilder {
  private getTaskFiles: PromptBuilderDeps['getTaskFiles'];
  private generatePlanTemplate: PromptBuilderDeps['generatePlanTemplate'];
  private logger: Logger;

  constructor(deps: PromptBuilderDeps) {
    this.getTaskFiles = deps.getTaskFiles;
    this.generatePlanTemplate = deps.generatePlanTemplate;
    this.logger = deps.logger || new Logger({ debug: false, prefix: '[PromptBuilder]' });
  }

  async buildPlanningPrompt(task: Task): Promise<string> {
    let prompt = '';
    prompt += `## Current Task\n\n**Task**: ${task.title}\n**Description**: ${task.description}`;

    if ((task as any).primary_repository) {
      prompt += `\n**Repository**: ${(task as any).primary_repository}`;
    }

    try {
      const taskFiles = await this.getTaskFiles(task.id);
      const contextFiles = taskFiles.filter((f: any) => f.type === 'context' || f.type === 'reference');
      if (contextFiles.length > 0) {
        prompt += `\n\n## Supporting Files`;
        for (const file of contextFiles) {
          prompt += `\n\n### ${file.name} (${file.type})\n${file.content}`;
        }
      }
    } catch (error) {
      this.logger.debug('No existing task files found for planning', { taskId: task.id });
    }

    const templateVariables = {
      task_id: task.id,
      task_title: task.title,
      task_description: task.description,
      date: new Date().toISOString().split('T')[0],
      repository: ((task as any).primary_repository || '') as string,
    };

    const planTemplate = await this.generatePlanTemplate(templateVariables);

    prompt += `\n\nPlease analyze the codebase and create a detailed implementation plan for this task. Use the following template structure for your plan:\n\n${planTemplate}\n\nFill in each section with specific, actionable information based on your analysis. Replace all placeholder content with actual details about this task.`;

    return prompt;
  }

  async buildExecutionPrompt(task: Task): Promise<string> {
    let prompt = '';
    prompt += `## Current Task\n\n**Task**: ${task.title}\n**Description**: ${task.description}`;

    if ((task as any).primary_repository) {
      prompt += `\n**Repository**: ${(task as any).primary_repository}`;
    }

    try {
      const taskFiles = await this.getTaskFiles(task.id);
      const hasPlan = taskFiles.some((f: any) => f.type === 'plan');
      if (taskFiles.length > 0) {
        prompt += `\n\n## Context and Supporting Information`;
        for (const file of taskFiles) {
          if (file.type === 'plan') {
            prompt += `\n\n### Execution Plan\n${file.content}`;
          } else {
            prompt += `\n\n### ${file.name} (${file.type})\n${file.content}`;
          }
        }
      }
      if (hasPlan) {
        prompt += `\n\nPlease implement the changes described in the execution plan above. Follow the plan step-by-step and make the necessary file modifications. You must actually edit files and make changes - do not just analyze or review.`;
      } else {
        prompt += `\n\nPlease implement the changes described in the task above. You must actually edit files and make changes - do not just analyze or review.`;
      }
    } catch (error) {
      this.logger.debug('No supporting files found for execution', { taskId: task.id });
      prompt += `\n\nPlease implement the changes described in the task above.`;
    }
    return prompt;
  }
}


