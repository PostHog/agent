// Main entry point - re-exports from src
export {
    Agent,
} from './src/agent.js';

export {
    PermissionMode,
} from './src/types.js';

export type {
    Task,
    TaskRun,
    SupportingFile,
    ExecutionResult,
    AgentConfig,
    McpServerConfig,
    AgentEvent
} from './src/types.js';

export {
    Logger,
    LogLevel,
} from './src/utils/logger.js';

export type {
    LoggerConfig
} from './src/utils/logger.js';

// Structured extraction types
export type {
    ExtractedQuestion,
    ExtractedQuestionWithAnswer,
    StructuredExtractor
} from './src/structured-extraction.js';

// File manager types
export type {
    QuestionData,
    AnswerData,
    QuestionsFile
} from './src/file-manager.js';

// Provider adapter types
export type { ProviderAdapter } from './src/adapters/types.js';
export { ClaudeAdapter } from './src/adapters/claude/claude-adapter.js';

// Tool types
export type {
    Tool,
    ToolCategory,
    KnownTool,
    ReadTool,
    WriteTool,
    EditTool,
    GlobTool,
    NotebookEditTool,
    BashTool,
    BashOutputTool,
    KillShellTool,
    WebFetchTool,
    WebSearchTool,
    GrepTool,
    TaskTool,
    TodoWriteTool,
    ExitPlanModeTool,
    SlashCommandTool,
} from './src/tools/types.js';
export { ToolRegistry } from './src/tools/registry.js';
