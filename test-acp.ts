import { Agent } from './src/agent.js';

async function testACPIntegration() {
    console.log('Testing ACP integration...\n');

    const agent = new Agent({
        workingDirectory: process.cwd(),
        debug: true,
        onEvent: (event) => {
            if ('method' in event) {
                // Custom notification
                console.log(`[Custom Event] ${event.method}:`, JSON.stringify(event.params, null, 2));
            } else if ('update' in event) {
                // SessionNotification
                console.log(`[ACP Event] ${event.update.sessionUpdate}:`,
                    event.update.sessionUpdate === 'agent_message_chunk' ? '[message chunk]' : JSON.stringify(event, null, 2)
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
