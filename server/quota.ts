const baseUrl = process.env.QUOTA_SERVICE_URL ?? "http://127.0.0.1:8787";

export async function collectQuota() {
  try {
    const [usage, resets, status] = await Promise.all(["/usage", "/resets", "/status"].map(async (path) => {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return response.json();
    }));
    return { available: true, source: baseUrl, usage, resets, status, collectedAt: new Date().toISOString() };
  } catch (error) {
    return { available: false, source: baseUrl, error: error instanceof Error ? error.message : String(error), collectedAt: new Date().toISOString() };
  }
}
