import type { SessionNotification } from '@agentclientprotocol/sdk';
import { ACPWrapper } from '../acp-wrapper.js';
import type { Logger } from '../utils/logger.js';

export interface RunACPStepOptions {
    logger: Logger;
    cwd: string;
    mcpServers?: Record<string, any>;
    prompt: string;
    onSessionUpdate: (notification: SessionNotification) => void;
    currentWrapper?: { wrapper?: ACPWrapper }; // Shared reference for cancellation support
}

/**
 * Run an ACP session and collect text content from agent messages
 */
export async function runACPStep(options: RunACPStepOptions): Promise<string> {
    const { logger, cwd, mcpServers, prompt, onSessionUpdate, currentWrapper } = options;

    const contentCollector: string[] = [];

    const acpWrapper = new ACPWrapper({
        logger: logger.child('ACPStep'),
        cwd,
        onSessionUpdate: (notification: SessionNotification) => {
            // Forward to caller
            onSessionUpdate(notification);

            // Collect text content from agent message chunks
            if (notification.update.sessionUpdate === 'agent_message_chunk') {
                const update = notification.update as any;
                if (update.content?.type === 'text' && update.content?.text) {
                    contentCollector.push(update.content.text);
                }
            }
        },
    });

    // Store reference for cancellation support
    if (currentWrapper) {
        currentWrapper.wrapper = acpWrapper;
    }

    try {
        await acpWrapper.start();
        await acpWrapper.createSession({ cwd, mcpServers });
        await acpWrapper.prompt(prompt);
        return contentCollector.join('');
    } finally {
        await acpWrapper.stop();
        if (currentWrapper) {
            currentWrapper.wrapper = undefined;
        }
    }
}
