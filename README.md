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
- **Progress Tracking**: Execution status stored in PostHog `TaskRun` records for easy polling

## Usage

```typescript
import { Agent, PermissionMode } from '@posthog/agent';
import type { AgentEvent } from '@posthog/agent';

const agent = new Agent({
    workingDirectory: "/path/to/repo",
    posthogApiUrl: "https://app.posthog.com",
    posthogApiKey: process.env.POSTHOG_API_KEY, // Used for both API and MCP
    onEvent: (event) => {
      // Streamed updates for responsive UIs
      if (event.type !== 'token') {
        handleLiveEvent(event);
      }
    },
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

For local MCP development:

```typescript
const agent = new Agent({
  workingDirectory: "/path/to/repo",
  posthogMcpUrl: 'http://localhost:8787/mcp',
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

## Progress Updates

Progress for each task execution is persisted to PostHog's `TaskRun` model, so UIs can poll for updates without relying on streaming hooks:

```typescript
const agent = new Agent({
  workingDirectory: repoPath,
  posthogApiUrl: "https://app.posthog.com",
  posthogApiKey: process.env.POSTHOG_KEY,
});

const poller = setInterval(async () => {
  const runs = await agent.getPostHogClient()?.listTaskRuns(taskId);
  const latestRun = runs?.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )[0];
  if (latestRun) {
    renderProgress(latestRun.status, latestRun.log, latestRun.current_stage);
  }
}, 3000);

try {
  await agent.runWorkflow(taskId, workflowId, { repositoryPath: repoPath });
} finally {
  clearInterval(poller);
}

// Live stream still available through the onEvent hook
function handleLiveEvent(event: AgentEvent) {
  switch (event.type) {
    case 'status':
      // optimistic UI update
      break;
    case 'error':
      notifyError(event.message);
      break;
    default:
      break;
  }
}
```

> Prefer streaming updates? Pass an `onEvent` handler when constructing the agent to keep receiving real-time events while progress is also written to PostHog.

## Requirements

- Bun runtime
- Git repository 
- PostHog API access
- Claude API access via `@anthropic-ai/claude-agent-sdk`


## Stage overrides and query overrides

You can customize behavior per workflow stage using `stageOverrides`, and pass low-level model options using `queryOverrides`.

```ts
await agent.runWorkflow(taskId, workflowId, {
  repositoryPath: "/path/to/repo",
  // Global defaults for this run
  permissionMode: PermissionMode.ACCEPT_EDITS,
  queryOverrides: { model: 'claude-3-7-sonnet' },

  // Per-stage overrides (keys must match your workflow's stage keys)
  stageOverrides: {
    plan: {
      permissionMode: PermissionMode.PLAN,
      createPlanningBranch: true,
      // Only applied during the planning stage
      queryOverrides: { temperature: 0.2 }
    },
    build: {
      createImplementationBranch: true,
      openPullRequest: false,
      // Inject custom MCP servers or any other query option
      queryOverrides: {
        mcpServers: {
          // example: override or add servers
        }
      }
    },
    complete: {
      // ensure a PR is opened at the end regardless of edits
      openPullRequest: true
    }
  }
});
```

Precedence for query options: base defaults in the SDK < global `queryOverrides` < per-stage `stageOverrides[stageKey].queryOverrides`.
