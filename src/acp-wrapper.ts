import { spawn, type ChildProcess } from 'child_process';
import { ClientSideConnection, ndJsonStream, type Client, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse, type CreateTerminalRequest, type CreateTerminalResponse, type TerminalOutputRequest, type TerminalOutputResponse, type ReleaseTerminalRequest, type ReleaseTerminalResponse, type WaitForTerminalExitRequest, type WaitForTerminalExitResponse, type KillTerminalCommandRequest, type KillTerminalResponse } from '@agentclientprotocol/sdk';
import type { Logger } from './utils/logger.js';
import type { PermissionModeValue } from './types.js';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';

export interface NotificationHandler {
    sendNotification(notification: SessionNotification): void;
}

export interface ACPWrapperConfig {
    logger: Logger;
    cwd: string;
    /** Agent that will receive ACP notifications */
    notificationHandler: NotificationHandler;
}

interface TerminalState {
    process: ChildProcess;
    output: string[];
    exitCode?: number;
    signal?: string;
    exitResolvers: Array<(value: { exitCode?: number; signal?: string }) => void>;
}

/**
 * Wrapper for claude-code-acp subprocess that implements ACP client interface.
 *
 * This class spawns claude-code-acp as a subprocess and manages JSON-RPC
 * communication over stdin/stdout. It implements the Client interface to
 * handle agent requests for permissions, file system access, and terminals.
 */
export class ACPWrapper {
    private connection?: ClientSideConnection;
    private sessionId?: string;
    private logger: Logger;
    private cwd: string;
    private notificationHandler: NotificationHandler;
    private subprocess?: ReturnType<typeof spawn>;
    private terminals = new Map<string, TerminalState>();

    constructor(config: ACPWrapperConfig) {
        this.logger = config.logger;
        this.cwd = config.cwd;
        this.notificationHandler = config.notificationHandler;
    }

    /**
     * Start the claude-code-acp subprocess and establish ACP connection
     */
    async start(): Promise<void> {
        this.logger.debug('Starting claude-code-acp subprocess');

        const env = { ...process.env };

        // Spawn claude-code-acp as subprocess
        this.subprocess = spawn('npx', ['@zed-industries/claude-code-acp'], {
            cwd: this.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...env,
                // Force line buffering for stdout to prevent Electron buffering issues
                NODE_NO_WARNINGS: '1',
            },
            windowsHide: true,
        });

        // Log stderr for debugging
        this.subprocess.stderr?.on('data', (data) => {
            this.logger.debug('claude-code-acp stderr:', data.toString());
        });

        // Handle subprocess exit
        this.subprocess.on('exit', (code, signal) => {
            this.logger.debug('claude-code-acp exited', { code, signal });
        });

        // Create streams for JSON-RPC communication
        const writable = new WritableStream<Uint8Array>({
            write: (chunk: Uint8Array) => {
                if (this.subprocess?.stdin) {
                    this.subprocess.stdin.write(chunk);
                }
            },
            close: () => {
                this.subprocess?.stdin?.end();
            },
        });

        const readable = new ReadableStream<Uint8Array>({
            start: (controller: ReadableStreamDefaultController<Uint8Array>) => {
                if (!this.subprocess?.stdout) {
                    controller.close();
                    return;
                }

                this.subprocess.stdout.on('data', (chunk: Buffer) => {
                    controller.enqueue(new Uint8Array(chunk));
                });

                this.subprocess.stdout.on('end', () => {
                    controller.close();
                });

                this.subprocess.stdout.on('error', (error) => {
                    controller.error(error);
                });
            },
        });

        // Create ACP stream from stdio
        const stream = ndJsonStream(writable, readable);

        // Create client-side connection with our client implementation
        this.connection = new ClientSideConnection(
            (agent) => this.createClient(),
            stream
        );

        // Initialize connection
        await this.initialize();
    }

    /**
     * Initialize the ACP connection and negotiate capabilities
     */
    private async initialize(): Promise<void> {
        if (!this.connection) {
            throw new Error('Connection not established');
        }

        this.logger.debug('Initializing ACP connection');

        const response = await this.connection.initialize({
            protocolVersion: 1,
            clientCapabilities: {
                fs: {
                    readTextFile: true,
                    writeTextFile: true,
                },
                terminal: true,
            },
            clientInfo: {
                name: '@posthog/agent',
                version: '1.0.0',
            },
        });

        this.logger.debug('ACP initialized', response);
    }

    /**
     * Create a new session
     */
    async createSession(options: {
        cwd: string;
        mcpServers?: Record<string, any>;
        systemPrompt?: string;
        permissionMode?: PermissionModeValue;
    }): Promise<string> {
        if (!this.connection) {
            throw new Error('Connection not established');
        }

        this.logger.debug('Creating new ACP session', options);

        // Convert mcpServers object to array format expected by ACP
        const mcpServersArray = options.mcpServers
            ? Object.entries(options.mcpServers).map(([name, config]) => ({
                  ...config,
                  name,
              }))
            : undefined;

        const permissionMode = options.permissionMode ?? 'bypassPermissions';

        const response = await this.connection.newSession({
            cwd: options.cwd,
            mcpServers: mcpServersArray || [],
            _meta: {
                ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
                permissionMode,
            },
        });

        this.sessionId = response.sessionId;
        this.logger.debug('ACP session created', { sessionId: this.sessionId });

        return this.sessionId;
    }

    /**
     * Send a prompt to the agent
     */
    async prompt(prompt: string): Promise<void> {
        if (!this.connection) {
            throw new Error('Connection not established');
        }

        if (!this.sessionId) {
            throw new Error('No active session');
        }

        this.logger.debug('Sending prompt to ACP agent', {
            sessionId: this.sessionId,
            promptLength: prompt.length,
            promptPreview: prompt.substring(0, 200)
        });

        const response = await this.connection.prompt({
            sessionId: this.sessionId,
            prompt: [
                {
                    type: 'text',
                    text: prompt,
                },
            ],
        });

        this.logger.debug('Prompt completed', {
            stopReason: response.stopReason
        });
    }

    /**
     * Cancel the current prompt
     */
    async cancel(): Promise<void> {
        if (!this.connection || !this.sessionId) {
            return;
        }

        this.logger.debug('Cancelling ACP session', { sessionId: this.sessionId });

        await this.connection.cancel({
            sessionId: this.sessionId,
        });
    }

    /**
     * Stop the subprocess and close the connection
     */
    async stop(): Promise<void> {
        this.logger.debug('Stopping ACP wrapper');

        for (const [terminalId, terminal] of this.terminals.entries()) {
            if (terminal.exitCode === undefined && terminal.signal === undefined) {
                this.logger.debug('Killing terminal on cleanup', { terminalId });
                terminal.process.kill('SIGTERM');
            }
        }
        
        this.terminals.clear();

        if (this.subprocess) {
            this.subprocess.kill('SIGTERM');
            this.subprocess = undefined;
        }

        this.connection = undefined;
        this.sessionId = undefined;
    }

    /**
     * Create the Client implementation for handling agent requests
     */
    private createClient(): Client {
        return {
            // Forward ACP session notifications to agent
            sessionUpdate: async (params: SessionNotification): Promise<void> => {
                this.notificationHandler.sendNotification(params);
            },

            // Handle permission requests
            requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
                this.logger.debug('Permission requested', { toolCallId: params.toolCall.toolCallId });

                // For now, auto-approve all permissions
                // TODO: Implement proper permission handling based on permissionMode
                const allowOption = params.options.find(opt => opt.kind === 'allow_once' || opt.kind === 'allow_always');
                if (allowOption) {
                    return {
                        outcome: {
                            outcome: 'selected',
                            optionId: allowOption.optionId,
                        },
                    };
                }

                // Fallback to first option
                return {
                    outcome: {
                        outcome: 'selected',
                        optionId: params.options[0]?.optionId || '',
                    },
                };
            },

            // Read text file from file system
            readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
                this.logger.debug('Reading file', { path: params.path });

                try {
                    const content = await fs.readFile(params.path, 'utf-8');
                    return { content };
                } catch (error) {
                    this.logger.error('Failed to read file', { path: params.path, error });
                    throw error;
                }
            },

            // Write text file to file system
            writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
                this.logger.debug('Writing file', { path: params.path });

                try {
                    await fs.writeFile(params.path, params.content, 'utf-8');
                    return {};
                } catch (error) {
                    this.logger.error('Failed to write file', { path: params.path, error });
                    throw error;
                }
            },

            // Terminal support - execute commands in child processes
            createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
                const terminalId = randomUUID();
                this.logger.debug('Creating terminal', { terminalId, command: params.command });

                // Spawn the process - use shell: true to execute command string
                const envVars: NodeJS.ProcessEnv = process.env;
                if (params.env) {
                    Object.assign(envVars, params.env);
                }

                const proc: ChildProcess = spawn(params.command, params.args || [], {
                    cwd: params.cwd || this.cwd,
                    env: envVars,
                    shell: true,
                });

                const terminalState: TerminalState = {
                    process: proc,
                    output: [],
                    exitResolvers: [],
                };

                // Collect stdout
                if (proc.stdout) {
                    proc.stdout.on('data', (data: Buffer) => {
                        terminalState.output.push(data.toString());
                    });
                }

                // Collect stderr
                if (proc.stderr) {
                    proc.stderr.on('data', (data: Buffer) => {
                        terminalState.output.push(data.toString());
                    });
                }

                // Handle exit
                proc.on('exit', (code: number | null, signal: string | null) => {
                    terminalState.exitCode = code ?? undefined;
                    terminalState.signal = signal ?? undefined;

                    // Resolve any pending waiters
                    for (const resolver of terminalState.exitResolvers) {
                        resolver({ exitCode: terminalState.exitCode, signal: terminalState.signal });
                    }
                    terminalState.exitResolvers = [];

                    this.logger.debug('Terminal exited', { terminalId, exitCode: code, signal });
                });

                this.terminals.set(terminalId, terminalState);

                return { terminalId };
            },

            terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
                const terminal = this.terminals.get(params.terminalId);
                if (!terminal) {
                    throw new Error(`Terminal ${params.terminalId} not found`);
                }

                this.logger.debug('Getting terminal output', { terminalId: params.terminalId });

                const output = terminal.output.join('');

                let exitStatus: TerminalOutputResponse['exitStatus'] = null;
                if (terminal.exitCode !== undefined) {
                    exitStatus = {
                        exitCode: terminal.exitCode,
                        signal: null,
                    };
                } else if (terminal.signal !== undefined) {
                    exitStatus = {
                        exitCode: null,
                        signal: terminal.signal,
                    };
                }

                return {
                    output,
                    exitStatus,
                    truncated: false,
                };
            },

            waitForTerminalExit: async (params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> => {
                const terminal = this.terminals.get(params.terminalId);
                if (!terminal) {
                    throw new Error(`Terminal ${params.terminalId} not found`);
                }

                this.logger.debug('Waiting for terminal exit', { terminalId: params.terminalId });

                // If already exited, return immediately
                if (terminal.exitCode !== undefined || terminal.signal !== undefined) {
                    return {
                        exitCode: terminal.exitCode ?? null,
                        signal: terminal.signal ?? null,
                    };
                }

                // Wait for exit
                const exitInfo = await new Promise<{ exitCode?: number; signal?: string }>((resolve) => {
                    terminal.exitResolvers.push(resolve);
                });

                return {
                    exitCode: exitInfo.exitCode ?? null,
                    signal: exitInfo.signal ?? null,
                };
            },

            killTerminal: async (params: KillTerminalCommandRequest): Promise<KillTerminalResponse> => {
                const terminal = this.terminals.get(params.terminalId);
                if (!terminal) {
                    throw new Error(`Terminal ${params.terminalId} not found`);
                }

                this.logger.debug('Killing terminal', { terminalId: params.terminalId });

                terminal.process.kill('SIGTERM');
                return {};
            },

            releaseTerminal: async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
                const terminal = this.terminals.get(params.terminalId);
                if (!terminal) {
                    throw new Error(`Terminal ${params.terminalId} not found`);
                }

                this.logger.debug('Releasing terminal', { terminalId: params.terminalId });

                // Kill the process if still running
                if (terminal.exitCode === undefined && terminal.signal === undefined) {
                    terminal.process.kill('SIGTERM');
                }

                // Remove from map
                this.terminals.delete(params.terminalId);
                return {};
            },
        };
    }
}
