import type { SessionNotification } from '@agentclientprotocol/sdk';
import { ACPWrapper } from '../acp-wrapper.js';
import type { WorkflowRuntime } from './types.js';

export interface RunACPStepOptions {
    context: WorkflowRuntime;
    systemPrompt: string;
    prompt: string;
}

/**
 * Run an ACP session and collect text content from agent messages
 */
export async function runACPStep(options: RunACPStepOptions): Promise<string> {
    const { context, systemPrompt, prompt } = options;
    const { logger, cwd, mcpServers, agent, currentWrapper } = context;

    const contentCollector: string[] = [];

    // Wrap agent to collect text content while forwarding notifications
    const notificationHandler = {
        sendNotification: (notification: SessionNotification | any) => {
            // Forward notification to agent
            agent.sendNotification(notification);

            // Collect text content from agent message chunks
            // Only process if it's a SessionNotification (has 'update' field)
            if ('update' in notification && notification.update?.sessionUpdate === 'agent_message_chunk') {
                const update = notification.update as any;
                // ACP protocol: content is a single ContentBlock object
                if (update.content && update.content.type === 'text' && update.content.text) {
                    contentCollector.push(update.content.text);
                }
            }
        }
    };

    const acpWrapper = new ACPWrapper({
        logger: logger.child('ACPStep'),
        cwd,
        notificationHandler,
    });

    // Store reference for cancellation support
    if (currentWrapper) {
        currentWrapper.wrapper = acpWrapper;
    }

    try {
        await acpWrapper.start();
        await acpWrapper.createSession({ cwd, mcpServers, systemPrompt });
        await acpWrapper.prompt(prompt);
        const collectedContent = contentCollector.join('');
        logger.debug('DEBUG: Content collected from agent_message_chunk', {
            chunkCount: contentCollector.length,
            totalLength: collectedContent.length,
            preview: collectedContent.substring(0, 200)
        });
        return collectedContent;
    } finally {
        await acpWrapper.stop();
        if (currentWrapper) {
            currentWrapper.wrapper = undefined;
        }
    }
}
