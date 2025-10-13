#!/usr/bin/env bun

import { config } from "dotenv";
config();

import { Agent, PermissionMode } from './src/agent.js';

async function testAgent() {
    const REPO_PATH = process.argv[2] || process.cwd();
    const PROMPT = process.argv.slice(3).join(' ');

    if (!PROMPT) {
        console.error("❌ Please provide a prompt");
        console.log("\nUsage: bun run example.ts [repo_path] <prompt>");
        console.log("Example: bun run example.ts . 'Add a new function to calculate fibonacci numbers'");
        process.exit(1);
    }

    console.log(`📁 Working in: ${REPO_PATH}`);
    console.log(`💬 Prompt: ${PROMPT}\n`);

    const agent = new Agent({
        workingDirectory: REPO_PATH,
        posthogApiUrl: process.env.POSTHOG_API_URL,
        posthogApiKey: process.env.POSTHOG_API_KEY,
        onEvent: (event) => {
            if (event.type === 'token') {
                process.stdout.write(event.content || '');
                return;
            }
            console.log(`\n[event:${event.type}]`, event);
        },
        debug: true,
    });

    try {
        console.log("🚀 Starting execution...\n");
        const result = await agent.run(PROMPT, {
            repositoryPath: REPO_PATH,
            permissionMode: PermissionMode.ACCEPT_EDITS,
        });
        console.log("\n\n✅ Done!");
        console.log(`📊 Processed ${result.results.length} messages`);
    } catch (error) {
        console.error("\n❌ Error:", error);
        process.exit(1);
    }
}

testAgent().catch(console.error);
