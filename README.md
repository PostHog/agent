# PostHog Agent SDK

TypeScript agent framework that wraps the Claude Agent SDK for PostHog's Array desktop app. Features a Git-based task execution system that stores task artifacts alongside your code.

## Quick Start

```bash
bun install
bun run example
```

## Key Features

- **Git-Based Task Execution**: Plans and artifacts stored in `.posthog/` folders and committed to Git
- **PostHog Integration**: Fetches existing tasks from PostHog API
- **3-Phase Execution**: Research → Plan → Build with automatic progression
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

// Run a task
const taskId = "task_abc123";
const task = await agent.getPostHogClient()?.fetchTask(taskId);

await agent.runTask(task, {
  repositoryPath: "/path/to/repo",
  permissionMode: PermissionMode.ACCEPT_EDITS,
  isCloudMode: false,
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

## Task Execution

Each task execution creates Git branches and follows a 3-phase approach:

1. **Research Phase**: Analyzes the codebase and may generate clarifying questions
2. **Planning Phase**: Creates an implementation plan in `.posthog/{id}/plan.md` on branch `posthog/task-{id}-planning`
3. **Build Phase**: Implements code changes on branch `posthog/task-{id}-implementation`

## File System

```
your-repo/
├── .posthog/
│   ├── README.md
│   ├── .gitignore
│   └── {task-id}/
│       ├── plan.md
│       ├── questions.json (if research phase generated questions)
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
    renderProgress(latestRun.status, latestRun.log);
  }
}, 3000);

try {
  await agent.runTask(task, { repositoryPath: repoPath });
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

## Configuration Options

You can customize behavior using `TaskExecutionOptions`:

```ts
await agent.runTask(task, {
  repositoryPath: "/path/to/repo",
  permissionMode: PermissionMode.ACCEPT_EDITS, // or PLAN, DEFAULT, BYPASS
  isCloudMode: false, // local execution with pauses between phases
  autoProgress: true, // automatically progress through phases
  queryOverrides: {
    model: 'claude-sonnet-4-5-20250929',
    temperature: 0.7
  }
});
```

---

## 🤖 Agent Humor Break

**Q:** Why did the AI agent go to therapy?
**A:** It had too many unresolved dependencies!

*Happy coding! 🚀*
