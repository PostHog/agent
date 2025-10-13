#!/usr/bin/env bun

import { config } from "dotenv";
config();

import { Agent, PermissionMode } from './src/agent.js';
import type { WorkflowExecutionOptions } from './src/workflow-types.js';

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
            if (event.type === 'token') {
                return;
            }
            console.log(`[event:${event.type}]`, event);
        },
        debug: true,
    });
    
    if (TASK_ID) {
        console.log(`🎯 Running task: ${TASK_ID}`);
        const posthogApi = agent.getPostHogClient();
        let poller: ReturnType<typeof setInterval> | undefined;
        try {
            // Example: list and run a workflow
            await agent['workflowRegistry'].loadWorkflows();
            const workflows = agent['workflowRegistry'].listWorkflows();
            if (workflows.length === 0) {
                throw new Error('No workflows available');
            }
            const selectedWorkflow = workflows[0];
            const options: WorkflowExecutionOptions = {
                repositoryPath: REPO_PATH,
                permissionMode: PermissionMode.ACCEPT_EDITS,
                autoProgress: true,
            };

            if (posthogApi) {
                poller = setInterval(async () => {
                    try {
                        const progress = await posthogApi.getTaskProgress(TASK_ID);
                        if (progress?.has_progress) {
                            console.log(
                                `📊 Progress: ${progress.status} | step=${progress.current_step} (${progress.completed_steps}/${progress.total_steps})`
                            );
                        }
                    } catch (err) {
                        console.warn('Failed to fetch task progress', err);
                    }
                }, 5000);
            }
            await agent.runWorkflow(TASK_ID, selectedWorkflow.id, options);
            console.log("✅ Done!");
            console.log(`📁 Plan stored in: .posthog/${TASK_ID}/plan.md`);
        } finally {
            if (poller) {
                clearInterval(poller);
            }
        }
    } else {
        console.log("❌ Please provide a task ID");
    }
}

testAgent().catch(console.error);
