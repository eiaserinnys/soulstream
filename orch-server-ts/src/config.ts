import { z } from "zod";

const ConfigSchema = z
  .object({
    environment: z.enum(["development", "test", "production"]),
    databaseUrl: z.string().min(1),
    authBearerToken: z.string().min(1),
  })
  .strict();

export type OrchServerTsConfig = z.infer<typeof ConfigSchema>;

export function parseOrchServerConfig(input: unknown): OrchServerTsConfig {
  return ConfigSchema.parse(input);
}
