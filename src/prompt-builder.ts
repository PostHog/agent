import type { Task } from './types.js';
import type { TemplateVariables } from './template-manager.js';
import { Logger } from './utils/logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface PromptBuilderDeps {
  getTaskFiles: (taskId: string) => Promise<any[]>;
  generatePlanTemplate: (vars: TemplateVariables) => Promise<string>;
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

  /**
   * Extract file paths from XML tags in description
   * Format: <file path="relative/path.ts" />
   */
  private extractFilePaths(description: string): string[] {
    const fileTagRegex = /<file\s+path="([^"]+)"\s*\/>/g;
    const paths: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = fileTagRegex.exec(description)) !== null) {
      paths.push(match[1]);
    }

    return paths;
  }

  /**
   * Read file contents from repository
   */
  private async readFileContent(repositoryPath: string, filePath: string): Promise<string | null> {
    try {
      const fullPath = join(repositoryPath, filePath);
      const content = await fs.readFile(fullPath, 'utf8');
      return content;
    } catch (error) {
      this.logger.warn(`Failed to read referenced file: ${filePath}`, { error });
      return null;
    }
  }

  /**
   * Process description to extract file tags and read contents
   * Returns processed description and referenced file contents
   */
  private async processFileReferences(
    description: string,
    repositoryPath?: string
  ): Promise<{ description: string; referencedFiles: Array<{ path: string; content: string }> }> {
    const filePaths = this.extractFilePaths(description);
    const referencedFiles: Array<{ path: string; content: string }> = [];

    if (filePaths.length === 0 || !repositoryPath) {
      return { description, referencedFiles };
    }

    // Read all referenced files
    for (const filePath of filePaths) {
      const content = await this.readFileContent(repositoryPath, filePath);
      if (content !== null) {
        referencedFiles.push({ path: filePath, content });
      }
    }

    // Replace file tags with just the filename for readability
    let processedDescription = description;
    for (const filePath of filePaths) {
      const fileName = filePath.split('/').pop() || filePath;
      processedDescription = processedDescription.replace(
        new RegExp(`<file\\s+path="${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*/>`, 'g'),
        `@${fileName}`
      );
    }

    return { description: processedDescription, referencedFiles };
  }

  async buildPlanningPrompt(task: Task, repositoryPath?: string): Promise<string> {
    // Process file references in description
    const { description: processedDescription, referencedFiles } = await this.processFileReferences(
      task.description,
      repositoryPath
    );

    let prompt = '';
    prompt += `## Current Task\n\n**Task**: ${task.title}\n**Description**: ${processedDescription}`;

    if ((task as any).primary_repository) {
      prompt += `\n**Repository**: ${(task as any).primary_repository}`;
    }

    // Add referenced files from @ mentions
    if (referencedFiles.length > 0) {
      prompt += `\n\n## Referenced Files\n\n`;
      for (const file of referencedFiles) {
        prompt += `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
      }
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
      task_description: processedDescription,
      date: new Date().toISOString().split('T')[0],
      repository: ((task as any).primary_repository || '') as string,
    };

    const planTemplate = await this.generatePlanTemplate(templateVariables);

    prompt += `\n\nPlease analyze the codebase and create a detailed implementation plan for this task. Use the following template structure for your plan:\n\n${planTemplate}\n\nFill in each section with specific, actionable information based on your analysis. Replace all placeholder content with actual details about this task.`;

    return prompt;
  }

  async buildExecutionPrompt(task: Task, repositoryPath?: string): Promise<string> {
    // Process file references in description
    const { description: processedDescription, referencedFiles } = await this.processFileReferences(
      task.description,
      repositoryPath
    );

    let prompt = '';
    prompt += `## Current Task\n\n**Task**: ${task.title}\n**Description**: ${processedDescription}`;

    if ((task as any).primary_repository) {
      prompt += `\n**Repository**: ${(task as any).primary_repository}`;
    }

    // Add referenced files from @ mentions
    if (referencedFiles.length > 0) {
      prompt += `\n\n## Referenced Files\n\n`;
      for (const file of referencedFiles) {
        prompt += `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\`\n\n`;
      }
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


