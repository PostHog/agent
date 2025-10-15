import type { AgentEvent, StatusEvent } from '../types.js';

/**
 * Provider adapter interface for transforming provider-specific messages
 * into our standardized AgentEvent format.
 *
 * This allows us to support multiple AI providers (Claude, Gemini, OpenAI, etc.)
 * while maintaining a consistent event interface for consumers.
 */
export interface ProviderAdapter {
  /** Provider name (e.g., 'claude', 'gemini') */
  name: string;

  /**
   * Transform a provider-specific SDK message into an AgentEvent.
   * Returns null if the message should be ignored.
   */
  transform(sdkMessage: unknown): AgentEvent | null;

  /**
   * Create a standardized status event.
   * Used for workflow stage transitions and other status updates.
   */
  createStatusEvent(phase: string, additionalData?: any): StatusEvent;

  /**
   * Create a raw SDK event for debugging purposes.
   * Wraps the original SDK message in a raw_sdk_event.
   */
  createRawSDKEvent(sdkMessage: any): AgentEvent;
}
