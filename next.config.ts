import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

/** Performance budget (EPIC-12 §S-12.05):
 *  - LCP < 2.5s p75
 *  - CLS < 0.1 p75
 *  - INP < 200ms p75
 *  - Initial bundle /app/inbox < 250KB gzipped
 */
const nextConfig: NextConfig = {
  // Self-host: gera .next/standalone pro container Docker (node server.js).
  // Na Vercel (VERCEL=1) fica desligado — Next 16.3 + adapter + standalone
  // quebra o onBuildComplete com ENOENT next-server.js.nft.json (#96646).
  output: process.env.VERCEL ? undefined : "standalone",
  /**
   * O `standalone` copia SÓ o que o file tracing detecta — e ele não detecta
   * tudo de `@swc/helpers`.
   *
   * Medido no build da `main`: o pacote real tem 108 arquivos em `esm/`, e o
   * standalone levava **2**. Em runtime o Node pedia
   * `@swc/helpers/esm/_interop_require_default`, não achava, e o container
   * subia em crashloop com `MODULE_NOT_FOUND` — a imagem construía, publicava e
   * só morria ao dar `docker compose up` na VPS.
   *
   * Não aparecia no `next@16.3.0`: aquela versão resolvia o helper pelo CJS. O
   * bump para `16.3.1` passou a resolvê-lo por `exports`/ESM, e o buraco do
   * trace virou falha dura. Como o helper é injetado pelo COMPILADOR (nenhum
   * arquivo nosso o importa), não há import para o trace seguir — a inclusão
   * precisa ser declarada.
   *
   * O glob passa pelo layout do pnpm (`.pnpm/@swc+helpers@<versão>/…`) porque é
   * onde o pacote realmente mora aqui; o `*` cobre o bump de versão seguinte
   * sem exigir que alguém lembre de editar esta linha.
   */
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**"],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // typedRoutes moved out of experimental in Next 15.5+
  typedRoutes: true,
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react", "lucide-react", "date-fns"],
  },
  images: {
    // O app não usa next/image de fato (só <img> raw); desligar o otimizador
    // evita exigir o binário `sharp` no runtime do container.
    unoptimized: true,
    remotePatterns: [
      // Supabase Storage (assinado)
      { protocol: "https", hostname: "*.supabase.co" },
      { protocol: "https", hostname: "*.supabase.in" },
    ],
  },
  async headers() {
    // ─── CSP + HSTS (Fase 1, risco R5) ──────────────────────────────────────
    //
    // A origem do Supabase entra DINÂMICA: `next.config` roda no boot do
    // servidor (`next start`/standalone), então `process.env` aqui é o do
    // runtime, não do build — e o clone self-host tem o URL dele. Fallback em
    // wildcard cobre build sem env (preview).
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    // Origem tal qual (o esquema http de um Supabase local de dev é válido em
    // connect-src); a variante ws/wss deriva trocando o esquema.
    const supabaseOrigem = supabaseUrl
      ? [supabaseUrl.replace(/\/$/, "")]
      : ["https://*.supabase.co", "https://*.supabase.in"];
    const supabaseWs = supabaseUrl
      ? [supabaseUrl.replace(/^http/, "ws").replace(/\/$/, "")]
      : ["wss://*.supabase.co", "wss://*.supabase.in"];

    /**
     * Escolhas de política, com a razão:
     *  - `script-src 'unsafe-inline' 'unsafe-eval'`: sem infra de nonce, o
     *    bootstrap do Next e o refresh do dev exigem ambos. É a parte fraca da
     *    CSP — o valor real está em object-src/base-uri/frame-ancestors
     *    (anti-embed, anti-plugin, anti-base hijack) e em restringir onde o
     *    browser pode falar. Endurecer para nonce é trabalho de app, não de
     *    header, e fica anotado como dívida no doc 21.
     *  - `connect-src`: só self + Supabase. Verificado no código: o browser
     *    fala com o próprio app (SSE de voz `/api/v1/voice/events`, Realtime
     *    via supabase-js, tunnel do Sentry em `/monitoring`) — o WebRTC do
     *    WACALLS não é governado por connect-src. O PDF/mídia entra por URL
     *    assinada do Supabase (img/media).
     *  - `upgrade-insecure-requests` só em produção: em dev (http://localhost)
     *    ele quebraria todos os subrecursos.
     */
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src 'self' ${[...supabaseOrigem, ...supabaseWs].join(" ")}`,
      "media-src 'self' blob: https:",
      "worker-src 'self'",
      "manifest-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
    ].join("; ");

    return [
      {
        source: "/notify-sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // HSTS sem includeSubDomains de propósito: o domínio do self-hoster
          // pode carregar outros serviços em subdomínios que não falam HTTPS —
          // forçá-los via HSTS do CRM seria quebrar a máquina de outra pessoa.
          { key: "Strict-Transport-Security", value: "max-age=15552000" },
          { key: "Content-Security-Policy", value: csp },
          // microphone=(self): o gravador de voz do composer (PTT estilo WhatsApp)
          // usa getUserMedia({audio}); microphone=() bloquearia em TODA origem,
          // inclusive a própria — daria "microphone is not allowed in this document".
          // Câmera e geolocalização seguem bloqueadas (não usadas).
          // notifications=(self): bandeja do SO quando a janela está minimizada.
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), notifications=(self)",
          },
        ],
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "automatik-labs",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
