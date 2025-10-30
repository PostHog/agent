#!/usr/bin/env bun

import { config } from "dotenv";
config();

import { Agent, PermissionMode } from './src/agent.js';

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
        debug: true,
    });

    if (TASK_ID) {
        console.log(`🎯 Running task: ${TASK_ID}`);
        const posthogApi = agent.getPostHogClient();
        let poller: ReturnType<typeof setInterval> | undefined;
        try {
            // Fetch task details
            if (!posthogApi) {
                throw new Error('PostHog API client not initialized');
            }
            const task = await posthogApi.fetchTask(TASK_ID);

            // Set up progress polling
            poller = setInterval(async () => {
                try {
                    const updatedTask = await posthogApi.fetchTask(TASK_ID);
                    const latestRun = updatedTask?.latest_run;
                    if (latestRun) {
                        console.log(`📊 Progress: ${latestRun.status}`);
                    }
                } catch (err) {
                    console.warn('Failed to fetch task progress', err);
                }
            }, 5000);

            // Run task with plan mode
            await agent.runTask(task, {
                repositoryPath: REPO_PATH,
                permissionMode: PermissionMode.ACCEPT_EDITS,
                isCloudMode: false,
                autoProgress: true,
            });

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
