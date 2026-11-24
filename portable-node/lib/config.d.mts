export function writeConfigGeneration(options: {
  templatesDir: string;
  stateRoot: string;
  configRoot: string;
  hostPort: number;
  catalogPath: string;
}): Promise<{ dir: string; files: Record<string, string>; generation: string }>;
