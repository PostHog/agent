import type { Task, UrlMention, PostHogResource } from './types.js';
import type { TemplateVariables } from './template-manager.js';
import { Logger } from './utils/logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';

export interface PromptBuilderDeps {
  getTaskFiles: (taskId: string) => Promise<any[]>;
  generatePlanTemplate: (vars: TemplateVariables) => Promise<string>;
  posthogClient?: { fetchResourceByUrl: (mention: UrlMention) => Promise<PostHogResource> };
  logger?: Logger;
}

export class PromptBuilder {
  private getTaskFiles: PromptBuilderDeps['getTaskFiles'];
  private generatePlanTemplate: PromptBuilderDeps['generatePlanTemplate'];
  private posthogClient?: PromptBuilderDeps['posthogClient'];
  private logger: Logger;

  constructor(deps: PromptBuilderDeps) {
    this.getTaskFiles = deps.getTaskFiles;
    this.generatePlanTemplate = deps.generatePlanTemplate;
    this.posthogClient = deps.posthogClient;
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
   * Extract URL mentions from XML tags in description
   * Formats: <error id="..." />, <experiment id="..." />, <url href="..." />
   */
  private extractUrlMentions(description: string): UrlMention[] {
    const mentions: UrlMention[] = [];
    
    // PostHog resource mentions: <error id="..." />, <experiment id="..." />, etc.
    const resourceRegex = /<(error|experiment|insight|feature_flag)\s+id="([^"]+)"\s*\/>/g;
    let match: RegExpExecArray | null;

    while ((match = resourceRegex.exec(description)) !== null) {
      const [, type, id] = match;
      mentions.push({
        url: '', // Will be reconstructed if needed
        type: type as any,
        id,
        label: this.generateUrlLabel('', type as any),
      });
    }

    // Generic URL mentions: <url href="..." />
    const urlRegex = /<url\s+href="([^"]+)"\s*\/>/g;
    while ((match = urlRegex.exec(description)) !== null) {
      const [, url] = match;
      mentions.push({
        url,
        type: 'generic',
        label: this.generateUrlLabel(url, 'generic'),
      });
    }

    return mentions;
  }

  /**
   * Generate a display label for a URL mention
   */
  private generateUrlLabel(url: string, type: string): string {
    try {
      const urlObj = new URL(url);
      switch (type) {
        case 'error':
          const errorMatch = url.match(/error_tracking\/([a-f0-9-]+)/);
          return errorMatch ? `Error ${errorMatch[1].slice(0, 8)}...` : 'Error';
        case 'experiment':
          const expMatch = url.match(/experiments\/(\d+)/);
          return expMatch ? `Experiment #${expMatch[1]}` : 'Experiment';
        case 'insight':
          return 'Insight';
        case 'feature_flag':
          return 'Feature Flag';
        default:
          return urlObj.hostname;
      }
    } catch {
      return 'URL';
    }
  }

  /**
   * Process URL references and fetch their content
   */
  private async processUrlReferences(
    description: string
  ): Promise<{ description: string; referencedResources: PostHogResource[] }> {
    const urlMentions = this.extractUrlMentions(description);
    const referencedResources: PostHogResource[] = [];

    if (urlMentions.length === 0 || !this.posthogClient) {
      return { description, referencedResources };
    }

    // Fetch all referenced resources
    for (const mention of urlMentions) {
      try {
        const resource = await this.posthogClient.fetchResourceByUrl(mention);
        referencedResources.push(resource);
      } catch (error) {
        this.logger.warn(`Failed to fetch resource from URL: ${mention.url}`, { error });
        // Add a placeholder resource for failed fetches
        referencedResources.push({
          type: mention.type,
          id: mention.id || '',
          url: mention.url,
          title: mention.label || 'Unknown Resource',
          content: `Failed to fetch resource from ${mention.url}: ${error}`,
          metadata: {},
        });
      }
    }

    // Replace URL tags with just the label for readability
    let processedDescription = description;
    for (const mention of urlMentions) {
      if (mention.type === 'generic') {
        // Generic URLs: <url href="..." />
        const escapedUrl = mention.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        processedDescription = processedDescription.replace(
          new RegExp(`<url\\s+href="${escapedUrl}"\\s*/>`, 'g'),
          `@${mention.label}`
        );
      } else {
        // PostHog resources: <error id="..." />, <experiment id="..." />, etc.
        const escapedType = mention.type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedId = mention.id ? mention.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        processedDescription = processedDescription.replace(
          new RegExp(`<${escapedType}\\s+id="${escapedId}"\\s*/>`, 'g'),
          `@${mention.label}`
        );
      }
    }

    return { description: processedDescription, referencedResources };
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

  async buildResearchPrompt(task: Task, repositoryPath?: string): Promise<string> {
    // Process file references in description
    const { description: descriptionAfterFiles, referencedFiles } = await this.processFileReferences(
      task.description,
      repositoryPath
    );

    // Process URL references in description  
    const { description: processedDescription, referencedResources } = await this.processUrlReferences(
      descriptionAfterFiles
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

    // Add referenced resources from URL mentions
    if (referencedResources.length > 0) {
      prompt += `\n\n## Referenced Resources\n\n`;
      for (const resource of referencedResources) {
        prompt += `### ${resource.title} (${resource.type})\n**URL**: ${resource.url}\n\n${resource.content}\n\n`;
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
      this.logger.debug('No existing task files found for research', { taskId: task.id });
    }

    prompt += `\n\nPlease explore the codebase thoroughly and generate 3-5 clarifying questions that will help guide the implementation of this task. Use the \`create_plan\` tool to create a research.md artifact with your questions in the markdown format specified in your system prompt.`;

    return prompt;
  }

  async buildPlanningPrompt(task: Task, repositoryPath?: string): Promise<string> {
    // Process file references in description
    const { description: descriptionAfterFiles, referencedFiles } = await this.processFileReferences(
      task.description,
      repositoryPath
    );

    // Process URL references in description  
    const { description: processedDescription, referencedResources } = await this.processUrlReferences(
      descriptionAfterFiles
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

    // Add referenced resources from URL mentions
    if (referencedResources.length > 0) {
      prompt += `\n\n## Referenced Resources\n\n`;
      for (const resource of referencedResources) {
        prompt += `### ${resource.title} (${resource.type})\n**URL**: ${resource.url}\n\n${resource.content}\n\n`;
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
    const { description: descriptionAfterFiles, referencedFiles } = await this.processFileReferences(
      task.description,
      repositoryPath
    );

    // Process URL references in description  
    const { description: processedDescription, referencedResources } = await this.processUrlReferences(
      descriptionAfterFiles
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

    // Add referenced resources from URL mentions
    if (referencedResources.length > 0) {
      prompt += `\n\n## Referenced Resources\n\n`;
      for (const resource of referencedResources) {
        prompt += `### ${resource.title} (${resource.type})\n**URL**: ${resource.url}\n\n${resource.content}\n\n`;
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


