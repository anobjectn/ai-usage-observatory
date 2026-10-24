/** Third-party pages are allowed only in the benchmark viewer. Their subresources are
 * governed by their own policies; app scripts, API calls, fonts, and images stay local. */
export function securityHeaders(options: { development?: boolean; scriptHash?: string } = {}) {
  const scripts = options.scriptHash ? `'self' '${options.scriptHash}'` : `'self'${options.development ? " 'unsafe-inline'" : ""}`;
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src ${scripts}`,
      // React chart geometry and user-selected themes require inline style attributes.
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${options.development ? " ws://localhost:5173 ws://127.0.0.1:5173" : ""}`,
      "frame-src https://slopalytics.com https://deepswe.datacurve.ai https://artificialanalysis.ai",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join("; "),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}

export function secureHandler(handler: (request: Request) => Promise<Response>, options: Parameters<typeof securityHeaders>[0] = {}) {
  const headers = securityHeaders(options);
  return async (request: Request) => {
    const response = await handler(request);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  };
}
