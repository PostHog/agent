import type { AgentEvent } from './types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export class EventTransformer {
  transform(sdkMessage: SDKMessage): AgentEvent | null {
    const baseEvent = { ts: Date.now() };

    // Handle stream events
    if (sdkMessage.type === 'stream_event') {
      const event = sdkMessage.event;

      switch (event.type) {
        case 'message_start':
          return {
            ...baseEvent,
            type: 'message_start',
            messageId: event.message?.id,
            model: event.message?.model
          };

        case 'content_block_start':
          const contentBlock = event.content_block;
          if (!contentBlock) return null;

          return {
            ...baseEvent,
            type: 'content_block_start',
            index: event.index,
            contentType: contentBlock.type as 'text' | 'tool_use' | 'thinking',
            toolName: contentBlock.type === 'tool_use' ? contentBlock.name : undefined,
            toolId: contentBlock.type === 'tool_use' ? contentBlock.id : undefined
          };

        case 'content_block_delta':
          const delta = event.delta;
          if (!delta) return null;

          if (delta.type === 'text_delta') {
            return {
              ...baseEvent,
              type: 'token',
              content: delta.text,
              contentType: 'text'
            };
          } else if (delta.type === 'input_json_delta') {
            return {
              ...baseEvent,
              type: 'token',
              content: delta.partial_json,
              contentType: 'tool_input'
            };
          } else if (delta.type === 'thinking_delta') {
            return {
              ...baseEvent,
              type: 'token',
              content: delta.thinking,
              contentType: 'thinking'
            };
          }
          return null;

        case 'content_block_stop':
          return {
            ...baseEvent,
            type: 'content_block_stop',
            index: event.index
          };

        case 'message_delta':
          return {
            ...baseEvent,
            type: 'message_delta',
            stopReason: event.delta?.stop_reason,
            stopSequence: event.delta?.stop_sequence,
            usage: event.usage ? {
              outputTokens: event.usage.output_tokens
            } : undefined
          };

        case 'message_stop':
          return {
            ...baseEvent,
            type: 'message_stop'
          };

        case 'ping':
          // Ignore ping events
          return null;

        case 'error':
          return {
            ...baseEvent,
            type: 'error',
            message: event.error?.message || 'Unknown error',
            error: event.error,
            errorType: event.error?.type
          };

        default:
          return null;
      }
    }

    // Handle assistant messages (full message, not streaming)
    if (sdkMessage.type === 'assistant') {
      // Extract tool calls from assistant message
      const message = sdkMessage.message;
      // We could emit individual tool_call events here if needed
      // For now, just emit a status event
      return {
        ...baseEvent,
        type: 'status',
        phase: 'assistant_message',
        messageId: message.id,
        model: message.model
      };
    }

    // Handle user messages
    if (sdkMessage.type === 'user') {
      const content = sdkMessage.message.content;
      const textContent = Array.isArray(content)
        ? content.find(c => c.type === 'text')?.text
        : typeof content === 'string' ? content : '';

      return {
        ...baseEvent,
        type: 'user_message',
        content: textContent || '',
        isSynthetic: sdkMessage.isSynthetic
      };
    }

    // Handle result messages
    if (sdkMessage.type === 'result') {
      if (sdkMessage.subtype === 'success') {
        return {
          ...baseEvent,
          type: 'done',
          durationMs: sdkMessage.duration_ms,
          numTurns: sdkMessage.num_turns,
          totalCostUsd: sdkMessage.total_cost_usd,
          usage: sdkMessage.usage
        };
      } else {
        return {
          ...baseEvent,
          type: 'error',
          message: `Execution failed: ${sdkMessage.subtype}`,
          error: { subtype: sdkMessage.subtype },
          errorType: sdkMessage.subtype
        };
      }
    }

    // Handle system messages
    if (sdkMessage.type === 'system') {
      if (sdkMessage.subtype === 'init') {
        return {
          ...baseEvent,
          type: 'init',
          model: sdkMessage.model,
          tools: sdkMessage.tools,
          permissionMode: sdkMessage.permissionMode,
          cwd: sdkMessage.cwd,
          apiKeySource: sdkMessage.apiKeySource
        };
      } else if (sdkMessage.subtype === 'compact_boundary') {
        return {
          ...baseEvent,
          type: 'compact_boundary',
          trigger: sdkMessage.compact_metadata.trigger,
          preTokens: sdkMessage.compact_metadata.pre_tokens
        };
      }
    }

    return null;
  }
  
  createStatusEvent(phase: string, additionalData?: any): AgentEvent {
    return {
      type: 'status',
      ts: Date.now(),
      phase,
      ...additionalData
    };
  }
}