import { Agent, type AgentNotification } from './src/agent.js';

async function testACPIntegration() {
    console.log('Testing ACP integration...\n');

    const agent = new Agent({
        workingDirectory: process.cwd(),
        debug: true,
        onNotification: (notification: AgentNotification) => {
            if ('method' in notification) {
                // PostHog notification
                console.log(`[PostHog] ${notification.method}:`, JSON.stringify(notification.params, null, 2));
            } else if ('update' in notification) {
                // ACP SessionNotification
                console.log(`[ACP] ${notification.update.sessionUpdate}:`,
                    notification.update.sessionUpdate === 'agent_message_chunk' ? '[message chunk]' : JSON.stringify(notification, null, 2)
                );
            }
        },
    });

    try {
        console.log('Running simple prompt...');
        await agent.run('Echo "Hello from ACP!"');
        console.log('\n✅ Test completed successfully!');
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

testACPIntegration();
