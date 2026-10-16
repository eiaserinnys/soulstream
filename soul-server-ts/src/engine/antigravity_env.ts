/** Keep account authentication: remove only the CLI's three API routing keys. */
export function antigravityEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GOOGLE_GEMINI_BASE_URL;
  return env;
}
