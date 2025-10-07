export const POSTHOG_MCP = {
    posthog: {
        command: "npx",
        args: [
            "-y",
            "mcp-remote@latest",
            "https://mcp.posthog.com/mcp",
            "--header",
            "Authorization:${POSTHOG_AUTH_HEADER}"
        ],
        env: {
            "POSTHOG_AUTH_HEADER": `Bearer ${process.env.POSTHOG_API_KEY}`
        }
    }
};