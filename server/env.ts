// Platform-level settings from environment variables (Netlify: Site configuration > Environment variables).
// Everything specific to one business lives in that org's settings in the database instead.

const env = (name: string, def = "") => process.env[name] ?? def;

export const platform = {
  get databaseUrl() { return env("DATABASE_URL") || env("NETLIFY_DATABASE_URL"); },
  get sessionSecret() { return env("SESSION_SECRET"); },
  get encryptionKey() { return env("APP_ENCRYPTION_KEY"); },
  /** Public URL of the dashboard, used to show webhook and invite links. */
  get publicUrl() { return (env("PUBLIC_URL") || env("URL") || "http://localhost:5173").replace(/\/$/, ""); },
  /** If set, new sign-ups must enter this code. */
  get signupCode() { return env("SIGNUP_CODE"); },
  get signupsClosed() { return env("SIGNUPS_CLOSED") === "true"; },
  /** Default AI key for every workspace; a workspace can use its own instead. */
  get anthropicApiKey() { return env("ANTHROPIC_API_KEY"); },
  get anthropicModel() { return env("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"); },
  get whatsappApiBase() { return env("WA_API_BASE", "https://graph.facebook.com/v23.0"); },
  /** Deployed (on Netlify/AWS) or explicitly production: secrets must be configured, no dev fallbacks. */
  get isProduction() {
    return env("NODE_ENV") === "production" || env("CONTEXT") === "production" || Boolean(env("AWS_LAMBDA_FUNCTION_NAME")) || env("NETLIFY") === "true";
  },
};
