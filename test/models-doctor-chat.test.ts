import { afterEach, describe, expect, test } from 'bun:test';
import { probeModel } from '../src/commands/models.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { AITransientError } from '../src/core/ai/errors.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

describe('models doctor chat reachability', () => {
  test('does not accept a fallback answer for the requested model', async () => {
    const requestedModel = 'anthropic:claude-sonnet-4-6';
    const fallbackModel = 'deepseek:deepseek-v4-flash';
    const calls: string[] = [];

    configureGateway({
      chat_model: requestedModel,
      chat_fallback_chain: [fallbackModel],
      env: {},
    });
    __setChatTransportForTests(async opts => {
      const model = opts.model!;
      calls.push(model);
      if (model === requestedModel) {
        throw new AITransientError('Anthropic stream error (overloaded_error): Overloaded');
      }
      return {
        text: 'fallback answer',
        blocks: [{ type: 'text', text: 'fallback answer' }],
        stopReason: 'end',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model,
        providerId: 'deepseek',
      };
    });

    const result = await probeModel(requestedModel, 'chat');

    expect(result.status).toBe('unknown');
    expect(result.message).toContain('overloaded_error');
    expect(calls).toEqual([requestedModel]);
  });
});
