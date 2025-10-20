import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import type { SupportingFile } from './types.js';
import { Logger } from './utils/logger.js';

export interface TaskFile {
  name: string;
  content: string;
  type: 'plan' | 'context' | 'reference' | 'output' | 'artifact';
}

export interface QuestionData {
  id: string;
  question: string;
  options: string[];
}

export interface AnswerData {
  questionId: string;
  selectedOption: string;
  customInput?: string;
}

export interface QuestionsFile {
  questions: QuestionData[];
  answered: boolean;
  answers: AnswerData[] | null;
}

export class PostHogFileManager {
  private repositoryPath: string;
  private logger: Logger;

  constructor(repositoryPath: string, logger?: Logger) {
    this.repositoryPath = repositoryPath;
    this.logger = logger || new Logger({ debug: false, prefix: '[FileManager]' });
  }

  private getTaskDirectory(taskId: string): string {
    return join(this.repositoryPath, '.posthog', taskId);
  }

  private getTaskFilePath(taskId: string, fileName: string): string {
    return join(this.getTaskDirectory(taskId), fileName);
  }

  async ensureTaskDirectory(taskId: string): Promise<void> {
    const taskDir = this.getTaskDirectory(taskId);
    try {
      await fs.access(taskDir);
    } catch {
      await fs.mkdir(taskDir, { recursive: true });
    }
  }

  async writeTaskFile(taskId: string, file: TaskFile): Promise<void> {
    await this.ensureTaskDirectory(taskId);
    const filePath = this.getTaskFilePath(taskId, file.name);

    this.logger.debug('Writing task file', {
      filePath,
      contentLength: file.content.length,
      contentType: typeof file.content
    });

    await fs.writeFile(filePath, file.content, 'utf8');

    this.logger.debug('File written successfully', { filePath });
  }

  async readTaskFile(taskId: string, fileName: string): Promise<string | null> {
    try {
      const filePath = this.getTaskFilePath(taskId, fileName);
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async listTaskFiles(taskId: string): Promise<string[]> {
    try {
      const taskDir = this.getTaskDirectory(taskId);
      const files = await fs.readdir(taskDir);
      return files.filter(file => !file.startsWith('.'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async deleteTaskFile(taskId: string, fileName: string): Promise<void> {
    try {
      const filePath = this.getTaskFilePath(taskId, fileName);
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async taskDirectoryExists(taskId: string): Promise<boolean> {
    try {
      const taskDir = this.getTaskDirectory(taskId);
      await fs.access(taskDir);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupTaskDirectory(taskId: string): Promise<void> {
    try {
      const taskDir = this.getTaskDirectory(taskId);
      await fs.rm(taskDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  // Convenience methods for common file types
  async writePlan(taskId: string, plan: string): Promise<void> {
    this.logger.debug('Writing plan', {
      taskId,
      planLength: plan.length,
      contentPreview: plan.substring(0, 200)
    });

    await this.writeTaskFile(taskId, {
      name: 'plan.md',
      content: plan,
      type: 'plan'
    });

    this.logger.info('Plan file written', { taskId });
  }

  async readPlan(taskId: string): Promise<string | null> {
    return await this.readTaskFile(taskId, 'plan.md');
  }

  async writeContext(taskId: string, context: string): Promise<void> {
    await this.writeTaskFile(taskId, {
      name: 'context.md',
      content: context,
      type: 'context'
    });
  }

  async readContext(taskId: string): Promise<string | null> {
    return await this.readTaskFile(taskId, 'context.md');
  }

  async writeRequirements(taskId: string, requirements: string): Promise<void> {
    await this.writeTaskFile(taskId, {
      name: 'requirements.md',
      content: requirements,
      type: 'reference'
    });
  }

  async readRequirements(taskId: string): Promise<string | null> {
    return await this.readTaskFile(taskId, 'requirements.md');
  }

  async writeResearch(taskId: string, content: string): Promise<void> {
    this.logger.debug('Writing research', {
      taskId,
      contentLength: content.length,
      contentPreview: content.substring(0, 200)
    });

    await this.writeTaskFile(taskId, {
      name: 'research.md',
      content: content,
      type: 'artifact'
    });

    this.logger.info('Research file written', { taskId });
  }

  async readResearch(taskId: string): Promise<string | null> {
    return await this.readTaskFile(taskId, 'research.md');
  }

  async writeQuestions(taskId: string, data: QuestionsFile): Promise<void> {
    this.logger.debug('Writing questions', {
      taskId,
      questionCount: data.questions.length,
      answered: data.answered,
    });

    await this.writeTaskFile(taskId, {
      name: 'questions.json',
      content: JSON.stringify(data, null, 2),
      type: 'artifact'
    });

    this.logger.info('Questions file written', { taskId });
  }

  async readQuestions(taskId: string): Promise<QuestionsFile | null> {
    try {
      const content = await this.readTaskFile(taskId, 'questions.json');
      return content ? JSON.parse(content) as QuestionsFile : null;
    } catch (error) {
      this.logger.debug('Failed to parse questions.json', { error });
      return null;
    }
  }

  async getTaskFiles(taskId: string): Promise<SupportingFile[]> {
    const fileNames = await this.listTaskFiles(taskId);
    const files: SupportingFile[] = [];
    
    for (const fileName of fileNames) {
      const content = await this.readTaskFile(taskId, fileName);
      if (content !== null) {
        // Determine type based on file name
        let type: SupportingFile['type'] = 'reference';
        if (fileName === 'plan.md') type = 'plan';
        else if (fileName === 'context.md') type = 'context';
        else if (fileName === 'requirements.md') type = 'reference';
        else if (fileName.startsWith('output_')) type = 'output';
        
        files.push({
          name: fileName,
          content,
          type,
          created_at: new Date().toISOString() // Could be enhanced with file stats
        });
      }
    }
    
    return files;
  }

  async ensureGitignore(): Promise<void> {
    const gitignorePath = join(this.repositoryPath, '.posthog', '.gitignore');
    const gitignoreContent = `# PostHog task artifacts - customize as needed
# Exclude temporary files
*/temp/
*/cache/
*/.env
*/.secrets

# Include plans and documentation by default
!*/plan.md
!*/context.md
!*/requirements.md
!*/README.md
`;

    try {
      await fs.access(gitignorePath);
    } catch {
      await fs.mkdir(dirname(gitignorePath), { recursive: true });
      await fs.writeFile(gitignorePath, gitignoreContent, 'utf8');
    }
  }
}
