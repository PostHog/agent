I'll analyze the agent.ts file to understand its current structure and identify areas for simplification.
Now let me examine the constructor and key dependencies more closely:
Let me also check the workflow structure to understand how it's being used:
Now let me look at how the dependencies are used in the main methods:
Let me check if taskManager is actually used beyond the cancelTask and getTaskExecutionStatus methods:
Perfect. Now I have a comprehensive understanding of the codebase. Let me generate the research questions:
# Research Questions

Based on my analysis of the codebase, here are the key questions to guide implementation:

## Question 1: Should we consolidate or remove the TaskManager dependency?

**Options:**
- a) Remove TaskManager entirely - it's only used in cancelTask() and getTaskExecutionStatus() which directly access private executionStates via bracket notation. Workflow-based execution (TASK_WORKFLOW) handles state tracking through WorkflowRuntime context instead (src/workflow/types.ts)
- b) Keep TaskManager but integrate it properly with the workflow runtime - pass it through WorkflowRuntime and use public methods instead of private state access
- c) Something else (please specify)

## Question 2: Should we simplify the constructor initialization by using a dependency injection builder?

**Options:**
- a) Extract constructor logic into a separate builder/factory function that reduces the 60+ line constructor by grouping related initializations (PostHog API setup, MCP servers config, logger/adapter setup)
- b) Keep current constructor but reorganize it into private helper methods like _initializePostHogServices(), _initializeMcpServers(), _initializeManagers()
- c) Something else (please specify)

## Question 3: How should we handle the separation between direct prompt execution (run()) and task-based execution (runTask())?

**Options:**
- a) Consolidate both into a single unified execute() method that accepts either a Task or a string prompt, eliminating code duplication
- b) Keep them separate but extract their common concerns (LLM gateway configuration, event emission) into shared private methods like _executeWorkflow() and _executeDirectQuery()
- c) Something else (please specify)

## Question 4: Should we reduce the public API surface by consolidating Git and file operations?

**Options:**
- a) Create high-level convenience methods like executeAndCommit() that wrap the lower-level git and file operations (currently scattered across createPlanningBranch, commitPlan, writeTaskFile, etc.)
- b) Keep all operations exposed but move internal-only methods (prepareTaskBranch, ensurePullRequest, ensureOpenAIGatewayEnv) to a separate internal class
- c) Something else (please specify)

## Question 5: Should we extract the LLM gateway configuration and PostHog integration into separate service classes?

**Options:**
- a) Create LlmGatewayService and PostHogIntegrationService classes to encapsulate the _configureLlmGateway(), ensureOpenAIGatewayEnv(), and PostHog API initialization logic currently scattered in agent.ts
- b) Keep everything in Agent but reorganize into clearly marked "Private PostHog Services" and "Private LLM Services" sections with helper methods
- c) Something else (please specify)