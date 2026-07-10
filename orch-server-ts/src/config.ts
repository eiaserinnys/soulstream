import { z } from "zod";

const ConfigSchema = z
  .object({
    environment: z.enum(["development", "test", "production"]),
    databaseUrl: z.string().min(1),
    authBearerToken: z.string().min(1),
    r2_board_assets_access_key_id: z.string().optional(),
    r2_board_assets_secret_access_key: z.string().optional(),
    r2_board_assets_bucket: z.string().optional(),
    r2_board_assets_endpoint: z.string().optional(),
  })
  .strict();

export type OrchServerTsConfig = z.infer<typeof ConfigSchema>;

export function parseOrchServerConfig(input: unknown): OrchServerTsConfig {
  return ConfigSchema.parse(input);
}
