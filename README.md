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
- **Three Execution Modes**: PLAN_ONLY, BUILD_ONLY, PLAN_AND_BUILD
- **Branch Management**: Automatic branch creation for planning and implementation
- **Event Streaming**: Real-time events for UI integration

## Usage

```typescript
import { Agent, ExecutionMode } from '@posthog/agent';

const agent = new Agent({
    workingDirectory: "/path/to/repo",
    posthogApiUrl: "https://app.posthog.com",
    posthogApiKey: process.env.POSTHOG_API_KEY
});

// Fetch and execute a PostHog task
const task = await agent.fetchTask("task_abc123");
const result = await agent.runTask(task, ExecutionMode.PLAN_AND_BUILD);
```

## Workflow

Each task execution creates Git branches:

1. **Planning**: `posthog/task-{id}-planning` - Contains plan in `.posthog/{id}/plan.md`
2. **Implementation**: `posthog/task-{id}-implementation` - Contains code changes

## Three Execution Modes

```typescript
// Plan only - generates plan and commits to planning branch
await agent.runTask(taskId, ExecutionMode.PLAN_ONLY);

// Build only - uses existing plan, creates implementation branch  
await agent.runTask(taskId, ExecutionMode.BUILD_ONLY);

// Plan and build - full workflow
await agent.runTask(taskId, ExecutionMode.PLAN_AND_BUILD);
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