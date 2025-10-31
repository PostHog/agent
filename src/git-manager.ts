import { exec } from 'child_process';
import { promisify } from 'util';
import { Logger } from './utils/logger.js';
import type { WorktreeInfo } from './types.js';

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

  async resetToDefaultBranchIfNeeded(): Promise<boolean> {
    const currentBranch = await this.getCurrentBranch();
    const defaultBranch = await this.getDefaultBranch();

    if (currentBranch === defaultBranch) {
      this.logger.debug('Already on default branch', { branch: defaultBranch });
      return true;
    }

    if (await this.hasChanges()) {
      this.logger.warn('Skipping branch reset - uncommitted changes present', {
        currentBranch,
        defaultBranch
      });
      return false;
    }

    await this.switchToBranch(defaultBranch);
    this.logger.info('Reset to default branch', { from: currentBranch, to: defaultBranch });
    return true;
  }

  async createOrSwitchToBranch(branchName: string, baseBranch?: string): Promise<void> {
    await this.ensureCleanWorkingDirectory('switching branches');

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
    const command = this.buildCommitCommand(message, options);
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

  // Helper: Centralized safety check for uncommitted changes
  private async ensureCleanWorkingDirectory(operation: string): Promise<void> {
    if (await this.hasChanges()) {
      throw new Error(`Uncommitted changes detected. Please commit or stash changes before ${operation}.`);
    }
  }

  private async generateUniqueBranchName(baseName: string): Promise<string> {
    if (!await this.branchExists(baseName)) {
      return baseName;
    }

    let counter = 1;
    let uniqueName = `${baseName}-${counter}`;
    while (await this.branchExists(uniqueName)) {
      counter++;
      uniqueName = `${baseName}-${counter}`;
    }
    return uniqueName;
  }

  private async ensureOnDefaultBranch(): Promise<string> {
    const defaultBranch = await this.getDefaultBranch();
    const currentBranch = await this.getCurrentBranch();

    if (currentBranch !== defaultBranch) {
      await this.ensureCleanWorkingDirectory('switching to default branch');
      await this.switchToBranch(defaultBranch);
    }

    return defaultBranch;
  }

  private buildCommitCommand(message: string, options?: { allowEmpty?: boolean; authorName?: string; authorEmail?: string }): string {
    let command = `commit -m "${message.replace(/"/g, '\\"')}"`;

    if (options?.allowEmpty) {
      command += ' --allow-empty';
    }

    const authorName = options?.authorName || this.authorName;
    const authorEmail = options?.authorEmail || this.authorEmail;

    if (authorName && authorEmail) {
      command += ` --author="${authorName} <${authorEmail}>"`;
    }

    return command;
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

  /**
   * Tracks whether commits were made during an operation by comparing HEAD SHA
   * before and after. Returns an object with methods to finalize the operation.
   *
   * Usage:
   * const tracker = await gitManager.trackCommitsDuring();
   * // ... do work that might create commits ...
   * const result = await tracker.finalize({ commitMessage: 'fallback message', push: true });
   */
  async trackCommitsDuring(): Promise<{
    finalize: (options: {
      commitMessage: string;
      push?: boolean;
    }) => Promise<{ commitCreated: boolean; pushedBranch: boolean }>;
  }> {
    const initialSha = await this.getCommitSha('HEAD');

    return {
      finalize: async (options) => {
        const currentSha = await this.getCommitSha('HEAD');
        const externalCommitsCreated = initialSha !== currentSha;
        const hasUncommittedChanges = await this.hasChanges();

        // If no commits and no changes, nothing to do
        if (!externalCommitsCreated && !hasUncommittedChanges) {
          return { commitCreated: false, pushedBranch: false };
        }

        let commitCreated = externalCommitsCreated;

        // Commit any remaining uncommitted changes
        if (hasUncommittedChanges) {
          await this.runGitCommand('add .');
          const hasStagedChanges = await this.hasStagedChanges();

          if (hasStagedChanges) {
            await this.commitChanges(options.commitMessage);
            commitCreated = true;
          }
        }

        // Push if requested and commits were made
        let pushedBranch = false;
        if (options.push && commitCreated) {
          const currentBranch = await this.getCurrentBranch();
          await this.pushBranch(currentBranch);
          pushedBranch = true;
          this.logger.info('Pushed branch after operation', { branch: currentBranch });
        }

        return { commitCreated, pushedBranch };
      }
    };
  }

  async createTaskBranch(taskSlug: string): Promise<string> {
    const branchName = `posthog/task-${taskSlug}`;

    // Ensure we're on default branch before creating task branch
    const defaultBranch = await this.ensureOnDefaultBranch();

    this.logger.info('Creating task branch from default branch', {
      branchName,
      taskSlug,
      baseBranch: defaultBranch
    });

    await this.createOrSwitchToBranch(branchName, defaultBranch);

    return branchName;
  }

  async createTaskPlanningBranch(taskId: string, baseBranch?: string): Promise<string> {
    const baseName = `posthog/task-${taskId}-planning`;
    const branchName = await this.generateUniqueBranchName(baseName);

    this.logger.debug('Creating unique planning branch', { branchName, taskId });

    const base = baseBranch || await this.ensureOnDefaultBranch();
    await this.createBranch(branchName, base);

    return branchName;
  }

  async createTaskImplementationBranch(taskId: string, planningBranchName?: string): Promise<string> {
    const baseName = `posthog/task-${taskId}-implementation`;
    const branchName = await this.generateUniqueBranchName(baseName);

    this.logger.debug('Creating unique implementation branch', {
      branchName,
      taskId,
      currentBranch: await this.getCurrentBranch()
    });

    // Determine base branch: explicit param > current planning branch > default
    let baseBranch = planningBranchName;

    if (!baseBranch) {
      const currentBranch = await this.getCurrentBranch();
      if (currentBranch.includes('-planning')) {
        baseBranch = currentBranch;
        this.logger.debug('Using current planning branch', { baseBranch });
      } else {
        baseBranch = await this.ensureOnDefaultBranch();
        this.logger.debug('Using default branch', { baseBranch });
      }
    }

    this.logger.debug('Creating implementation branch from base', { baseBranch, branchName });
    await this.createBranch(branchName, baseBranch);

    this.logger.info('Implementation branch created', {
      branchName,
      currentBranch: await this.getCurrentBranch()
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
      await this.ensureCleanWorkingDirectory('creating PR');
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

    const command = this.buildCommitCommand(message, options);
    await this.runGitCommand(command);

    // Push to origin
    const currentBranch = await this.getCurrentBranch();
    await this.pushBranch(currentBranch);

    this.logger.info('Committed and pushed changes', { branch: currentBranch, message });
  }

  // Git worktree methods for concurrent task execution

  /**
   * Creates a git worktree at the specified path with the given branch.
   * If the branch doesn't exist, it will be created from the current HEAD.
   */
  async createWorktree(branchName: string, worktreePath: string): Promise<void> {
    this.logger.info('Creating git worktree', { branchName, worktreePath });

    // Check if branch exists
    const branchExists = await this.branchExists(branchName);

    if (branchExists) {
      // Branch exists, create worktree with existing branch
      await this.runGitCommand(`worktree add "${worktreePath}" ${branchName}`);
    } else {
      // Branch doesn't exist, create it with worktree
      const defaultBranch = await this.getDefaultBranch();
      await this.runGitCommand(`worktree add -b ${branchName} "${worktreePath}" ${defaultBranch}`);
    }

    this.logger.debug('Worktree created successfully', { branchName, worktreePath });
  }

  /**
   * Removes a git worktree at the specified path.
   * @param force If true, removes the worktree even if it has uncommitted changes
   */
  async removeWorktree(worktreePath: string, force: boolean = false): Promise<void> {
    this.logger.info('Removing git worktree', { worktreePath, force });

    const forceFlag = force ? '--force' : '';
    try {
      await this.runGitCommand(`worktree remove ${forceFlag} "${worktreePath}"`);
      this.logger.debug('Worktree removed successfully', { worktreePath });
    } catch (error) {
      this.logger.error('Failed to remove worktree', { worktreePath, error });
      throw error;
    }
  }

  /**
   * Lists all git worktrees in the repository.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    try {
      const output = await this.runGitCommand('worktree list --porcelain');
      return this.parseWorktreeList(output);
    } catch (error) {
      this.logger.error('Failed to list worktrees', error);
      throw error;
    }
  }

  /**
   * Checks if a worktree exists at the specified path.
   */
  async worktreeExists(path: string): Promise<boolean> {
    try {
      const worktrees = await this.listWorktrees();
      return worktrees.some(w => w.path === path);
    } catch {
      return false;
    }
  }

  /**
   * Generates a worktree path for a given task slug.
   * @param taskSlug The task identifier
   * @param basePath Optional base directory (defaults to .posthog/worktrees)
   */
  getWorktreePath(taskSlug: string, basePath?: string): string {
    const base = basePath || '.posthog/worktrees';
    return `${this.repositoryPath}/${base}/${taskSlug}`;
  }

  /**
   * Cleans up stale worktrees that no longer have valid branches.
   */
  async cleanupStaleWorktrees(): Promise<void> {
    this.logger.info('Cleaning up stale worktrees');

    try {
      await this.runGitCommand('worktree prune');
      this.logger.debug('Stale worktrees cleaned up');
    } catch (error) {
      this.logger.error('Failed to cleanup stale worktrees', error);
      throw error;
    }
  }

  /**
   * Parses the output of `git worktree list --porcelain` into WorktreeInfo objects.
   */
  private parseWorktreeList(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const lines = output.split('\n').filter(line => line.trim());

    let currentWorktree: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        // Save previous worktree if exists
        if (currentWorktree.path) {
          worktrees.push(currentWorktree as WorktreeInfo);
        }
        // Start new worktree
        currentWorktree = {
          path: line.substring('worktree '.length),
          branch: '',
          commit: '',
        };
      } else if (line.startsWith('HEAD ')) {
        currentWorktree.commit = line.substring('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        const branchRef = line.substring('branch '.length);
        // Extract branch name from refs/heads/branch-name
        currentWorktree.branch = branchRef.replace('refs/heads/', '');
      }
    }

    // Add last worktree
    if (currentWorktree.path) {
      worktrees.push(currentWorktree as WorktreeInfo);
    }

    return worktrees;
  }
}
