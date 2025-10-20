import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from './utils/logger.js';

const execAsync = promisify(exec);

export interface GitConfig {
  repositoryPath: string;
  authorName?: string;
  authorEmail?: string;
  logger?: Logger;
}

export interface BranchInfo {
  name: string;
  exists: boolean;
  isCurrentBranch: boolean;
}

export class GitManager {
  private repositoryPath: string;
  private authorName?: string;
  private authorEmail?: string;
  private logger: Logger;

  constructor(config: GitConfig) {
    this.repositoryPath = config.repositoryPath;
    this.authorName = config.authorName;
    this.authorEmail = config.authorEmail;
    this.logger = config.logger || new Logger({ debug: false, prefix: '[GitManager]' });
  }

  private async runGitCommand(command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`cd "${this.repositoryPath}" && git ${command}`);
      return stdout.trim();
    } catch (error) {
      throw new Error(`Git command failed: ${command}\n${error}`);
    }
  }

  private async runCommand(command: string): Promise<string> {
    try {
      const { stdout } = await execAsync(`cd "${this.repositoryPath}" && ${command}`);
      return stdout.trim();
    } catch (error) {
      throw new Error(`Command failed: ${command}\n${error}`);
    }
  }

  async isGitRepository(): Promise<boolean> {
    try {
      await this.runGitCommand('rev-parse --git-dir');
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentBranch(): Promise<string> {
    return await this.runGitCommand('branch --show-current');
  }

  async getDefaultBranch(): Promise<string> {
    try {
      // Try to get the default branch from remote
      const remoteBranch = await this.runGitCommand('symbolic-ref refs/remotes/origin/HEAD');
      return remoteBranch.replace('refs/remotes/origin/', '');
    } catch {
      // Fallback: check if main exists, otherwise use master
      if (await this.branchExists('main')) {
        return 'main';
      } else if (await this.branchExists('master')) {
        return 'master';
      } else {
        throw new Error('Cannot determine default branch. No main or master branch found.');
      }
    }
  }

  async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.runGitCommand(`rev-parse --verify ${branchName}`);
      return true;
    } catch {
      return false;
    }
  }

  async createBranch(branchName: string, baseBranch?: string): Promise<void> {
    const base = baseBranch || await this.getCurrentBranch();
    await this.runGitCommand(`checkout -b ${branchName} ${base}`);
  }

  async switchToBranch(branchName: string): Promise<void> {
    await this.runGitCommand(`checkout ${branchName}`);
  }

  async createOrSwitchToBranch(branchName: string, baseBranch?: string): Promise<void> {
    const exists = await this.branchExists(branchName);
    if (exists) {
      await this.switchToBranch(branchName);
    } else {
      await this.createBranch(branchName, baseBranch);
    }
  }

  async addFiles(paths: string[]): Promise<void> {
    const pathList = paths.map(p => `"${p}"`).join(' ');
    await this.runGitCommand(`add ${pathList}`);
  }

  async addAllPostHogFiles(): Promise<void> {
    await this.runGitCommand('add .posthog/');
  }

  async commitChanges(message: string, options?: {
    authorName?: string;
    authorEmail?: string;
  }): Promise<string> {
    let command = 'commit -m "' + message.replace(/"/g, '\\"') + '"';

    const authorName = options?.authorName || this.authorName;
    const authorEmail = options?.authorEmail || this.authorEmail;

    if (authorName && authorEmail) {
      command += ` --author="${authorName} <${authorEmail}>"`;
    }

    return await this.runGitCommand(command);
  }

  async hasChanges(): Promise<boolean> {
    try {
      const status = await this.runGitCommand('status --porcelain');
      return status.length > 0;
    } catch {
      return false;
    }
  }

  async hasStagedChanges(): Promise<boolean> {
    try {
      const status = await this.runGitCommand('diff --cached --name-only');
      return status.length > 0;
    } catch {
      return false;
    }
  }

  async getRemoteUrl(): Promise<string | null> {
    try {
      return await this.runGitCommand('remote get-url origin');
    } catch {
      return null;
    }
  }

  async pushBranch(branchName: string, force: boolean = false): Promise<void> {
    const forceFlag = force ? '--force' : '';
    await this.runGitCommand(`push ${forceFlag} -u origin ${branchName}`);
  }

  // Utility methods for PostHog task workflow
  async createTaskPlanningBranch(taskId: string, baseBranch?: string): Promise<string> {
    let branchName = `posthog/task-${taskId}-planning`;
    let counter = 1;

    // Find a unique branch name if the base name already exists
    while (await this.branchExists(branchName)) {
      branchName = `posthog/task-${taskId}-planning-${counter}`;
      counter++;
    }

    this.logger.debug('Creating unique planning branch', { branchName, taskId });

    // If no base branch specified, ensure we're on main/master
    if (!baseBranch) {
      baseBranch = await this.getDefaultBranch();
      await this.switchToBranch(baseBranch);

      // Check for uncommitted changes
      if (await this.hasChanges()) {
        throw new Error(`Uncommitted changes detected. Please commit or stash changes before running tasks.`);
      }
    }

    await this.createBranch(branchName, baseBranch); // Use createBranch instead of createOrSwitchToBranch for new branches
    return branchName;
  }

  async createTaskImplementationBranch(taskId: string, planningBranchName?: string): Promise<string> {
    let branchName = `posthog/task-${taskId}-implementation`;
    let counter = 1;

    // Find a unique branch name if the base name already exists
    while (await this.branchExists(branchName)) {
      branchName = `posthog/task-${taskId}-implementation-${counter}`;
      counter++;
    }

    const currentBranchBefore = await this.getCurrentBranch();
    this.logger.debug('Creating unique implementation branch', {
      branchName,
      taskId,
      currentBranch: currentBranchBefore
    });

    // Implementation branch should branch from the specific planning branch
    let baseBranch = planningBranchName;

    if (!baseBranch) {
      // Try to find the corresponding planning branch
      const currentBranch = await this.getCurrentBranch();
      if (currentBranch.includes('-planning')) {
        baseBranch = currentBranch; // Use current planning branch
        this.logger.debug('Using current planning branch', { baseBranch });
      } else {
        // Fallback to default branch
        baseBranch = await this.getDefaultBranch();
        this.logger.debug('No planning branch found, using default', { baseBranch });
        await this.switchToBranch(baseBranch);
      }
    }

    this.logger.debug('Creating implementation branch from base', { baseBranch, branchName });
    await this.createBranch(branchName, baseBranch); // Create fresh branch from base

    const currentBranchAfter = await this.getCurrentBranch();
    this.logger.info('Implementation branch created', {
      branchName,
      currentBranch: currentBranchAfter
    });

    return branchName;
  }

  async commitPlan(taskId: string, taskTitle: string): Promise<string> {
    const currentBranch = await this.getCurrentBranch();
    this.logger.debug('Committing plan', { taskId, currentBranch });

    await this.addAllPostHogFiles();

    const hasChanges = await this.hasStagedChanges();
    this.logger.debug('Checking for staged changes', { hasChanges });

    if (!hasChanges) {
      this.logger.info('No plan changes to commit', { taskId });
      return 'No changes to commit';
    }

    const message = `📋 Add plan for task: ${taskTitle}

Task ID: ${taskId}
Generated by PostHog Agent

This commit contains the implementation plan and supporting documentation
for the task. Review the plan before proceeding with implementation.`;

    const result = await this.commitChanges(message);
    this.logger.info('Plan committed', { taskId, taskTitle });
    return result;
  }

  async commitImplementation(taskId: string, taskTitle: string, planSummary?: string): Promise<string> {
    await this.runGitCommand('add .');

    const hasChanges = await this.hasStagedChanges();
    if (!hasChanges) {
      this.logger.warn('No implementation changes to commit', { taskId });
      return 'No changes to commit';
    }

    let message = `✨ Implement task: ${taskTitle}

Task ID: ${taskId}
Generated by PostHog Agent`;

    if (planSummary) {
      message += `\n\nPlan Summary:\n${planSummary}`;
    }

    message += `\n\nThis commit implements the changes described in the task plan.`;

    const result = await this.commitChanges(message);
    this.logger.info('Implementation committed', { taskId, taskTitle });
    return result;
  }

  async deleteBranch(branchName: string, force: boolean = false): Promise<void> {
    const forceFlag = force ? '-D' : '-d';
    await this.runGitCommand(`branch ${forceFlag} ${branchName}`);
  }

  async deleteRemoteBranch(branchName: string): Promise<void> {
    await this.runGitCommand(`push origin --delete ${branchName}`);
  }

  async getBranchInfo(branchName: string): Promise<BranchInfo> {
    const exists = await this.branchExists(branchName);
    const currentBranch = await this.getCurrentBranch();

    return {
      name: branchName,
      exists,
      isCurrentBranch: branchName === currentBranch
    };
  }

  async getCommitSha(ref: string = 'HEAD'): Promise<string> {
    return await this.runGitCommand(`rev-parse ${ref}`);
  }

  async getCommitMessage(ref: string = 'HEAD'): Promise<string> {
    return await this.runGitCommand(`log -1 --pretty=%B ${ref}`);
  }

  async createPullRequest(
    branchName: string,
    title: string,
    body: string,
    baseBranch?: string
  ): Promise<string> {
    const currentBranch = await this.getCurrentBranch();
    if (currentBranch !== branchName) {
      await this.switchToBranch(branchName);
    }

    await this.pushBranch(branchName);

    let command = `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`;

    if (baseBranch) {
      command += ` --base ${baseBranch}`;
    }

    try {
      const prUrl = await this.runCommand(command);
      return prUrl.trim();
    } catch (error) {
      throw new Error(`Failed to create PR: ${error}`);
    }
  }

  async getTaskBranch(taskSlug: string): Promise<string | null> {
    try {
      // Get all branches matching the task slug pattern
      const branches = await this.runGitCommand('branch --list --all');
      const branchPattern = `posthog/task-${taskSlug}`;
      
      // Look for exact match or with counter suffix
      const lines = branches.split('\n').map(l => l.trim().replace(/^\*\s+/, ''));
      for (const line of lines) {
        const cleanBranch = line.replace('remotes/origin/', '');
        if (cleanBranch.startsWith(branchPattern)) {
          return cleanBranch;
        }
      }
      
      return null;
    } catch (error) {
      this.logger.debug('Failed to get task branch', { taskSlug, error });
      return null;
    }
  }

  async commitAndPush(message: string, options?: { allowEmpty?: boolean }): Promise<void> {
    const hasChanges = await this.hasStagedChanges();
    
    if (!hasChanges && !options?.allowEmpty) {
      this.logger.debug('No changes to commit, skipping');
      return;
    }

    let command = `commit -m "${message.replace(/"/g, '\\"')}"`;
    
    if (options?.allowEmpty) {
      command += ' --allow-empty';
    }

    const authorName = this.authorName;
    const authorEmail = this.authorEmail;

    if (authorName && authorEmail) {
      command += ` --author="${authorName} <${authorEmail}>"`;
    }

    await this.runGitCommand(command);
    
    // Push to origin
    const currentBranch = await this.getCurrentBranch();
    await this.pushBranch(currentBranch);
    
    this.logger.info('Committed and pushed changes', { branch: currentBranch, message });
  }
}
