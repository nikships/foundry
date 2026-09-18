import { z } from 'zod';

/**
 * Pi compiles tool schemas across providers with different draft support.
 * These schemas use no dialect-specific features, so omitting the declaration
 * is the one representation every supported compiler accepts.
 */
export function jsonSchemaWithoutDialect(
  schema: z.ZodType,
  params?: { io?: 'input' | 'output' },
): z.core.JSONSchema.BaseSchema {
  const jsonSchema = z.toJSONSchema(schema, params);
  delete jsonSchema.$schema;
  return jsonSchema;
}
