import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { materializarRiscos } from "@/lib/receita/ativacao";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET/POST /api/v1/cron/revenue-activation — materializa os detectores de
 * vazamento (Fase 6, `fn_materializar_riscos`) e faz o backfill idempotente
 * de atribuição. Agendado a cada 15 min no `scheduler` (docker/scheduler/entrypoint.sh;
 * gate: cron-routes-scheduled). Auth: Bearer fail-closed (mesmo contrato dos
 * demais crons). Idempotente por construção — rodar 2× não duplica risco
 * nem evento (unique parcial/total no 0242).
 */
function autorizado(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  const esperado = env.INTERNAL_CRON_SECRET || env.INTERNAL_SECRET;
  if (!esperado || token === "") return false;
  const a = createHash("sha256").update(token).digest();
  const b = createHash("sha256").update(esperado).digest();
  return a.equals(b);
}

async function executar(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  if (!autorizado(req)) {
    return new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Bearer inválido." } }), {
      status: 403,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    });
  }

  const admin = createAdminClient();
  const orgId = req.nextUrl.searchParams.get("org_id") ?? undefined;
  const r = await materializarRiscos(admin, orgId ?? undefined);

  logger.info("[revenue-activation] detectores materializados", { contagem: r.contagem });
  return ok(r.contagem, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return executar(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return executar(req);
}
