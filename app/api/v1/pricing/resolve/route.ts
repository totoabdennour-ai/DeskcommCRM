import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/pricing/resolve?product_id=&account_id=&quantidade=
 *
 * O CONTRATO CANÔNICO DE PREÇO — a única porta de consulta. Chama o resolver
 * determinístico (`lib/pricing/consultar.ts` → `resolver.ts`); NÃO expõe o
 * catálogo cru, NÃO aceita preço de quem pergunta, NÃO calcula nada aqui.
 *
 * IA pode PERGUNTAR (identificar produto, extrair quantidade, pedir preço,
 * explicar a resposta) — IA nunca inventa, sobrescreve ou muta (a mutação é
 * manager+ nas rotas de lista; a tool de consulta do agente, na Fase 5,
 * chamará o MESMO serviço deste resolver, com o token efêmero da org).
 *
 * Sem preço a resposta é 200 com `status: "no_price"` e motivo — ausência de
 * preço é RESULTADO legítimo, não erro de transporte.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { consultarPreco } from "@/lib/pricing/consultar";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "pricing" });
  if (!authz.ok) return authz.response;

  const url = req.nextUrl.searchParams;
  const productId = url.get("product_id") ?? "";
  const accountId = url.get("account_id") || null;
  const quantidadeBruta = url.get("quantidade");
  const quantidade = quantidadeBruta === null ? 1 : Number.parseInt(quantidadeBruta, 10);

  if (!UUID_RX.test(productId)) {
    return fail("validation_failed", "product_id inválido.", 422, { requestId });
  }
  if (accountId !== null && !UUID_RX.test(accountId)) {
    return fail("validation_failed", "account_id inválido.", 422, { requestId });
  }
  if (!Number.isFinite(quantidade) || quantidade < 1 || quantidade > 1_000_000) {
    return fail("validation_failed", "quantidade inválida (1..1000000).", 422, { requestId });
  }

  const supabase = await createClient();
  const preco = await consultarPreco(supabase, {
    organizationId: authz.org.orgId,
    productId,
    accountId,
    quantidade,
  });

  return ok(preco, { requestId });
}
