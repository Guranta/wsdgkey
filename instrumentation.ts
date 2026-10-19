export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { ensureReady } = await import("./lib/db");
    await ensureReady();
    const { startJobs } = await import("./lib/jobs");
    startJobs();
  }
}
