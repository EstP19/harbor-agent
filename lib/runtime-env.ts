// Vercel injects configuration into process.env; no .env file is required there.
// Run before modules such as db.ts construct clients from the environment.
if (!process.env.VERCEL) {
  try {
    process.loadEnvFile();
  } catch (error) {
    // A local .env is optional. Other file errors must remain visible.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
