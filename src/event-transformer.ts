import type { AgentEvent } from './types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export class EventTransformer {
  createRawSDKEvent(sdkMessage: any): AgentEvent {
    return {
      type: 'raw_sdk_event',
      ts: Date.now(),
      sdkMessage
    };
  }

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
            errorType: event.error?.type || 'stream_error',
            context: event.error ? {
              type: event.error.type,
              code: event.error.code,
            } : undefined,
            sdkError: event.error
          };

        default:
          return null;
      }
    }

    // Handle assistant messages (full message, not streaming)
    if (sdkMessage.type === 'assistant') {
      const message = sdkMessage.message;
      
      // Extract tool calls from content blocks
      if (message.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_use') {
            // Return first tool_call event found
            return {
              ...baseEvent,
              type: 'tool_call',
              toolName: block.name,
              callId: block.id,
              args: block.input || {}
            };
          }
        }
      }
      
      // If no tool calls, emit status event
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
      const message = sdkMessage.message;
      
      // Check for tool results in content blocks
      if (message?.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'tool_result') {
            return {
              ...baseEvent,
              type: 'tool_result',
              toolName: block.tool_name || 'unknown',
              callId: block.tool_use_id || '',
              result: block.content
            };
          }
        }
      }
      
      // Otherwise extract text content
      const textContent = this.extractUserContent(message?.content);
      if (!textContent) {
        return null;
      }
      return {
        ...baseEvent,
        type: 'user_message',
        content: textContent,
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
          errorType: sdkMessage.subtype || 'result_error',
          context: {
            subtype: sdkMessage.subtype,
            duration_ms: sdkMessage.duration_ms,
            num_turns: sdkMessage.num_turns
          },
          sdkError: sdkMessage
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

  private extractUserContent(content: unknown): string | null {
    if (!content) {
      return null;
    }

    if (typeof content === 'string') {
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        const extracted = this.extractUserContent(block);
        if (extracted) {
          parts.push(extracted);
        } else if (block && typeof block === 'object') {
          const candidate = this.extractFromObject(block as Record<string, unknown>);
          if (candidate) {
            parts.push(candidate);
          }
        }
      }
      const text = parts.join('\n').trim();
      return text.length > 0 ? text : null;
    }

    if (typeof content === 'object') {
      return this.extractFromObject(content as Record<string, unknown>);
    }

    return null;
  }

  private extractFromObject(value: Record<string, unknown>): string | null {
    const preferredKeys = ['text', 'input_text', 'input', 'markdown', 'content', 'message'];
    for (const key of preferredKeys) {
      if (typeof value[key] === 'string') {
        const trimmed = (value[key] as string).trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }

    for (const entry of Object.values(value)) {
      const extracted = this.extractUserContent(entry);
      if (extracted) {
        return extracted;
      }
    }

    return null;
  }
}
