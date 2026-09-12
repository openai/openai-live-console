import type { FunctionTool } from 'openai/resources/responses/responses';

// Fictional data, authored for this sample. No orders, customers, or external services.
// Generic sample labels are placeholders, not backpack brands or model names.
export const products = [
  {
    id: 'sample-backpack-a',
    name: 'Sample Backpack A',
    price: 65,
    liters: 18,
    useCases: ['commute', 'hike'],
    details: 'A light daypack with a water-resistant shell and a 13-inch laptop sleeve.',
  },
  {
    id: 'sample-backpack-b',
    name: 'Sample Backpack B',
    price: 95,
    liters: 28,
    useCases: ['weekend', 'commute'],
    details: 'A clamshell travel pack with a 16-inch laptop sleeve. Designed for a two-night trip.',
  },
  {
    id: 'sample-backpack-c',
    name: 'Sample Backpack C',
    price: 145,
    liters: 32,
    useCases: ['hike', 'weekend'],
    details: 'A trail pack with a ventilated back panel, hip belt, and rain cover.',
  },
] as const;

export const toolDefinitions: FunctionTool[] = [
  {
    type: 'function',
    name: 'search_catalog',
    strict: true,
    description:
      'Search a small fictional backpack catalog by use case and maximum price in USD. Read-only; does not make purchases.',
    parameters: {
      type: 'object',
      properties: {
        use_case: { type: 'string', enum: ['commute', 'weekend', 'hike'] },
        max_price: { type: 'number', minimum: 0, maximum: 1000 },
      },
      required: ['use_case', 'max_price'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_product',
    strict: true,
    description:
      'Read specifications for one fictional product. Use the exact catalog ID. Does not access customer data.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', enum: products.map((p) => p.id) } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Arguments must be an object.');
  return value as Record<string, unknown>;
}

export function executeTool(
  name: string,
  raw: string,
): { arguments: Record<string, unknown>; result: unknown } {
  if (Buffer.byteLength(raw) > 2048) throw new Error('Tool arguments exceed the sample limit.');
  const args = object(JSON.parse(raw));
  if (name === 'search_catalog') {
    if (
      Object.keys(args).sort().join(',') !== 'max_price,use_case' ||
      !['commute', 'weekend', 'hike'].includes(String(args.use_case)) ||
      typeof args.max_price !== 'number' ||
      !Number.isFinite(args.max_price) ||
      args.max_price < 0 ||
      args.max_price > 1000
    ) {
      throw new Error('Expected use_case and a finite max_price between 0 and 1000.');
    }
    return {
      arguments: args,
      result: {
        source: 'fictional_sample_catalog',
        currency: 'USD',
        products: products.filter(
          (p) =>
            (p.useCases as readonly string[]).includes(args.use_case as string) &&
            p.price <= (args.max_price as number),
        ),
      },
    };
  }
  if (name === 'get_product') {
    if (Object.keys(args).join(',') !== 'id' || typeof args.id !== 'string')
      throw new Error('Expected exactly one catalog ID.');
    const product = products.find((p) => p.id === args.id);
    if (!product) throw new Error('Unknown catalog ID.');
    return { arguments: args, result: { source: 'fictional_sample_catalog', currency: 'USD', product } };
  }
  throw new Error('This sample does not authorize that tool.');
}
