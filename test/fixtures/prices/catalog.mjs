// The shape models.dev publishes: providers with models with a cost per 1M tokens. A real catalog has thousands of models.
export const catalog = () => ({
  filler: { models: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`m${i}`, { cost: { input: 1, output: 2 } }])) },
  openai: { models: { 'gpt-test': { cost: { input: 2, output: 10, cache_read: 0.5 } } } },
  reseller: { models: { 'gpt-test': { cost: { input: 9, output: 9, cache_read: 0.9 } }, 'only-here': { cost: { input: 7, output: 8 } } } },
  anthropic: { models: { 'claude-test': { cost: { input: 4, output: 20, cache_read: 0.4 } } } },
  google: { models: { 'gemini-2.5-flash': { cost: { input: 0.3, output: 2.5, cache_read: 0.03 }, free: {}, tiered: { cost: { input: 'x' } } }, 'gemini-3.8-flash': { cost: { input: 0.4, output: 3, cache_read: 0.04 } } } },
});
