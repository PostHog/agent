import { createAnthropic } from '@ai-sdk/anthropic';

export interface PostHogGatewayConfig {
  apiKey: string;
  gatewayUrl: string;
  modelName?: string;
}

/**
 * Creates an Anthropic model configured for PostHog LLM gateway.
 * 
 * Handles two key differences between AI SDK and PostHog gateway:
 * 1. Appends /v1 to baseURL (gateway expects /v1/messages, SDK appends /messages)
 * 2. Converts x-api-key header to Authorization Bearer token
 */
export function getAnthropicModel(config: PostHogGatewayConfig) {
  const modelName = config.modelName || 'claude-haiku-4-5';
  
  // PostHog gateway expects /v1/messages, but AI SDK appends /messages
  // So we need to append /v1 to the baseURL
  const baseURL = config.gatewayUrl ? `${config.gatewayUrl}/v1` : undefined;

  // Custom fetch to convert x-api-key header to Authorization Bearer
  // PostHog gateway expects Bearer token, but Anthropic SDK sends x-api-key
  const customFetch = async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);

    if (headers.has('x-api-key')) {
      headers.delete('x-api-key');
      headers.set('Authorization', `Bearer ${config.apiKey}`);
    }

    return fetch(url, {
      ...init,
      headers,
    });
  };

  const anthropic = createAnthropic({
    apiKey: config.apiKey,
    baseURL,
    //@ts-ignore
    fetch: customFetch,
  });

  return anthropic(modelName);
}
