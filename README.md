# PostHog Agent SDK

TypeScript agent framework that wraps the Claude Agent SDK for PostHog's Array desktop app. Features a Git-based workflow that stores task artifacts alongside your code.

## Quick Start

```bash
bun install
bun run example
```

## Key Features

- **Git-Based Workflow**: Plans and artifacts stored in `.posthog/` folders and committed to Git
- **PostHog Integration**: Fetches existing tasks from PostHog API
- **Configurable Workflows**: Execute tasks via PostHog-defined or local workflows
- **Branch Management**: Automatic branch creation for planning and implementation
- **Event Streaming**: Real-time events for UI integration

## Usage

```typescript
import { Agent, PermissionMode } from '@posthog/agent';

const agent = new Agent({
    workingDirectory: "/path/to/repo",
    posthogApiUrl: "https://app.posthog.com",
    posthogApiKey: process.env.POSTHOG_API_KEY
});

// Run by workflow
const taskId = "task_abc123";
const workflowId = "workflow_123";
await agent.runWorkflow(taskId, workflowId, {
  repositoryPath: "/path/to/repo",
  permissionMode: PermissionMode.ACCEPT_EDITS,
  autoProgress: true,
});
```

## Workflow

Each task execution creates Git branches:

1. **Planning**: `posthog/task-{id}-planning` - Contains plan in `.posthog/{id}/plan.md`
2. **Implementation**: `posthog/task-{id}-implementation` - Contains code changes

## Manual Stages and Resume

- Manual stages (no agent, or `is_manual_only`) are stop-points: the SDK will not auto-advance.
- On manual stages, a PR is opened by default for human review (configurable per stage with `openPullRequest`).

Resume from the current stage:

```typescript
await agent.runWorkflow(taskId, workflowId, {
  repositoryPath: "/path/to/repo",
  permissionMode: PermissionMode.ACCEPT_EDITS,
  resumeFromCurrentStage: true,
  autoProgress: true, // ignored on manual stages
});

// Or explicitly progress via API then resume
await agent.progressToNextStage(taskId);
await agent.runWorkflow(taskId, workflowId, { resumeFromCurrentStage: true });
```

## File System

```
your-repo/
├── .posthog/
│   ├── README.md
│   ├── .gitignore
│   └── {task-id}/
│       ├── plan.md
│       └── context.md (optional)
└── (your code)
```

## Array App Integration

```typescript
const result = await agent.runTask(taskId, userSelectedMode, {
    repositoryPath: selectedRepo,
    onEvent: (event) => {
        // Update UI based on event type
        switch (event.type) {
            case 'status': updateProgress(event.data); break;
            case 'file_write': showFileChange(event.data); break;
            case 'done': showCompletion(); break;
        }
    }
});
```

## Requirements

- Bun runtime
- Git repository 
- PostHog API access
- Claude API access via `@anthropic-ai/claude-agent-sdk`

## Development

This replaces `@posthog/code-agent` with Git-based artifact storage, PostHog task integration, and branch-based review workflow.