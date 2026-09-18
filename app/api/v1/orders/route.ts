import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/orders — os pedidos da organização ativa (nativos + espelhos).
 * POST /api/v1/orders — cria o RASCUNHO do pedido nativo (D3, B7).
 *
 * ─── O que acontece num POST ────────────────────────────────────────────────
 *
 * 1. Cada linha é RESOLVIDA no resolver (`lib/pricing/`) — preço NUNCA vem do
 *    corpo (a IA/operador manda produto + quantidade apenas). Linha sem
 *    preço recusa o pedido inteiro com o motivo (422).
 * 2. `fn_criar_pedido` grava pedido + linhas + evento `created` + event_log
 *    NO MESMO COMMIT (outbox).
 * 3. Rascunho nasce `draft` — confirmar é outra rota (A6/B1: o snapshot vale
 *    na confirmação, e confirmar é decisão de operador/cliente, não da IA).
 *
 * ─── Idempotency-Key ────────────────────────────────────────────────────────
 *
 * O header é HONRADO aqui (padrão `admin/tenants`): mesma chave + mesmo corpo
 * dentro de 24h devolve a MESMA resposta gravada — re-entrega do canal
 * (webhook/agente) não cria segundo pedido. Chave repetida com corpo
 * diferente → 409 (conflito real, não silêncio).
 */
import { createHash, randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { criarRascunho } from "@/lib/orders/engine";
import { pedidoCreateSchema } from "@/lib/orders/tipos";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";



export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "orders" });
  if (!authz.ok) return authz.response;

  const status = req.nextUrl.searchParams.get("status")?.trim();
  const supabase = await createClient();

  let q = supabase
    .from("orders")
    .select(
      "id, organization_id, external_id, external_provider, origin, account_id, contact_id, status, total_cents, currency, ordered_at, created_at, updated_at",
    )
    .eq("organization_id", authz.org.orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return fail("internal_error", "Erro ao listar os pedidos.", 500, { requestId });
  return ok(data ?? [], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "orders" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const corpoBruto = await req.json().catch(() => null);
  const parsed = pedidoCreateSchema.safeParse(corpoBruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  const supabase = await createClient();
  // F4.1: a idempotência é CONSUMIDA DENTRO de fn_criar_pedido — mesma
  // transação do pedido. Crash/concorrência entre "pedido criado" e "chave
  // gravada" não existe mais: ou os dois acontecem, ou nenhum.
  const idempotencyKey = req.headers.get("Idempotency-Key")?.trim() ?? "";
  const requestHash = createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex");

  // ── Resolver + RPC (transacional) ─────────────────────────────────────────
  let statusFinal: number;
  let corpoFinal: Record<string, unknown>;
  let houveEfeito = false;

  try {
    const r = await criarRascunho(supabase, {
      organizationId: authz.org.orgId,
      accountId: parsed.data.account_id,
      linhas: parsed.data.items,
      actorUserId: authz.user.id,
      actorKind: "user",
      externalId: null,
      idempotencyKey,
      requestHash,
    });

    // Recusa de DOMÍNIO (sem preço, moeda mista): resultado legítimo, 422.
    // Nada foi criado e a chave NÃO foi consumida (a RPC nem rodou).
    if (!r.ok) {
      statusFinal = 422;
      corpoFinal = {
        error: { code: "validation_failed", message: t(`Pedido recusado: ${r.motivo}.`), details: { motivo: r.motivo, produto: r.produto } },
      };
    } else {
      // 201 para criação E replay: a re-entrega devolve o MESMO resultado
      // gravado pela primeira execução (contrato idempotente).
      statusFinal = 201;
      corpoFinal = {
        data: {
          order_id: r.pedido.order_id,
          external_id: r.pedido.external_id,
          status: r.pedido.status,
          total_cents: r.pedido.total_cents,
          ...(r.pedido.replay ? { replay: true } : { linhas: r.pedido.linhas }),
        },
      };
      houveEfeito = !r.pedido.replay;
    }
  } catch (e) {
    const mensagem = e instanceof Error ? e.message : String(e);
    if (mensagem.includes("idempotency_conflicting_body")) {
      statusFinal = 409;
      corpoFinal = {
        error: { code: "validation_failed", message: t("Idempotency-Key já usada com outro corpo.") },
      };
    } else if (mensagem.includes("23514") || mensagem.includes("nao pertence")) {
      statusFinal = 422;
      corpoFinal = {
        error: { code: "validation_failed", message: t("Conta ou produto não pertencem a esta organização.") },
      };
    } else {
      statusFinal = 500;
      corpoFinal = { error: { code: "internal_error", message: t("Erro ao criar o pedido.") } };
    }
  }

  // AUDITA quando houve EFEITO: criação nova audita; replay e recusa 422 não
  // mutaram nada (a doutrina "audita quando houve efeito" vale aqui também).
  if (houveEfeito) {
    const dados = corpoFinal.data as { order_id: string; external_id: string };
    await audit({
      action: "order.created",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "order",
      resourceId: dados.order_id,
      requestId,
      metadata: { external_id: dados.external_id, account_id: parsed.data.account_id },
    });
  }

  return new Response(JSON.stringify(corpoFinal), {
    status: statusFinal,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}
