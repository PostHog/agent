#!/usr/bin/env bun

import { config } from "dotenv";
config();

import { Agent, ExecutionMode, PermissionMode } from './src/agent';

async function testAgent() {
    const REPO_PATH = process.argv[2] || process.cwd();
    const TASK_ID = process.argv[3];
    
    if (!process.env.POSTHOG_API_KEY) {
        console.error("❌ POSTHOG_API_KEY required");
        process.exit(1);
    }
    
    console.log(`📁 Working in: ${REPO_PATH}`);
    
    const agent = new Agent({
        workingDirectory: REPO_PATH,
        posthogApiUrl: process.env.POSTHOG_API_URL || "http://localhost:8010",
        posthogApiKey: process.env.POSTHOG_API_KEY,
        onEvent: (event) => {
            console.log(`[${event.type}]`, event);
        }
    });
    
    if (TASK_ID) {
        console.log(`🎯 Running task: ${TASK_ID}`);
        
        // Suppress stderr during execution to hide Claude debug output
        const originalStderr = process.stderr.write;
        process.stderr.write = () => true;
        
        try {
            const result = await agent.runTask(TASK_ID, ExecutionMode.PLAN_AND_BUILD, {
                repositoryPath: REPO_PATH,
                permissionMode: PermissionMode.ACCEPT_EDITS
            });
            console.log("✅ Done!");
            console.log(`📁 Plan stored in: .posthog/${TASK_ID}/plan.md`);
        } finally {
            // Restore stderr
            process.stderr.write = originalStderr;
        }
    } else {
        console.log("❌ Please provide a task ID");
    }
}

testAgent().catch(console.error);