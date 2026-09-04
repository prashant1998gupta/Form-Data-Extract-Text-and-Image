import type { NextConfig } from "next";

/**
 * Content-Security-Policy.
 *
 * `img-src` needs `data:` and `blob:` because the verify screen renders the
 * uploaded form and every extracted crop as in-memory images that never touch
 * the network. `connect-src` is deliberately narrow: it bounds where a
 * compromised script could send a patient's photograph.
 *
 * `script-src-attr 'none'` blocks inline event-handler attributes outright.
 * Nothing here uses them, and they are the most common way an injected payload
 * actually fires. `unsafe-inline` remains in `script-src` for Next's hydration
 * scripts; removing that needs per-request nonces, which costs static
 * prerendering.
 */
const isDevelopment = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  // React's development build needs eval() for its debugging features and
  // reports a CSP violation without it; production never uses eval, so the
  // allowance is confined to `next dev`.
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

/**
 * `camera=(self)` is load-bearing, not boilerplate: the capture control uses
 * `capture="environment"`, and omitting this header blocks the rear camera on
 * mobile — which is the primary way staff will use this.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // sharp is a native binding and must not be bundled. Next externalises it by
  // default in most configurations; naming it makes that independent of version.
  serverExternalPackages: ["sharp"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
