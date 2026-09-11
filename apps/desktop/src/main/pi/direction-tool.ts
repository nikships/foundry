import { defineTool, type ToolDefinition } from './tool-definition.js';
import type { FoundryToolContext } from './transport.js';

export function acknowledgeDirectionTool(ctx: FoundryToolContext): ToolDefinition {
  return defineTool({
    name: 'acknowledge_direction',
    label: 'Acknowledge direction',
    description:
      'Record whether you acted on or dismissed a direction supplied to this phase, with a concrete reason. Does not change gates or run status.',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: 'string' },
        status: { type: 'string', enum: ['acted_on', 'dismissed'] },
        reason: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['messageId', 'status', 'reason'],
      additionalProperties: false,
    },
    execute: (_id, params) => {
      if (!ctx.acknowledgeDirection) throw new Error('phase direction is unavailable');
      ctx.acknowledgeDirection(params);
      return Promise.resolve({
        content: [
          { type: 'text', text: 'Acknowledgment recorded; phase acceptance is unchanged.' },
        ],
        details: undefined,
      });
    },
  });
}
