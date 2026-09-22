import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { createClient } from "@/lib/supabase/server";

import { Account360Client } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Conta B2B" };

/**
 * ACCOUNT 360 (Fase 7) — a visão comercial completa de uma conta, direto das
 * fontes authoritative (server-side, RLS intacta): identidade, contatos,
 * oportunidades, pedidos com snapshot, receita por moeda nativa, riscos
 * abertos com a NBA do sistema, e histórico de eventos. Ações do operador
 * passam pelas rotas existentes — nada muta direto.
 */
export default async function Account360Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeAgir =
    (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();

  const { data: conta } = await supabase
    .from("accounts")
    .select(
      "id, organization_id, name, external_id, status, settings, owner_user_id, created_at, updated_at",
    )
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!conta) notFound();

  const { data: contatos } = await supabase
    .from("contacts")
    .select("id, display_name, phone_number, last_activity_at")
    .eq("organization_id", activeOrg.orgId)
    .eq("account_id", id)
    .order("last_activity_at", { ascending: false, nullsFirst: false })
    .limit(50);

  const idsDeContato = (contatos ?? []).map((c) => c.id);
  const placeholder = "00000000-0000-4000-8000-000000000000";

  const [opps, pedidos, riscos, eventos, conversas] = await Promise.all([
    supabase
      .from("crm_leads")
      .select("id, title, status, value_cents, currency, stage_id, lost_reason")
      .eq("organization_id", activeOrg.orgId)
      .in("contact_id", idsDeContato.length > 0 ? idsDeContato : [placeholder])
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("orders")
      .select(
        "id, external_id, origin, status, total_cents, currency, ordered_at, created_at",
      )
      .eq("organization_id", activeOrg.orgId)
      .eq("account_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("revenue_at_risk")
      .select(
        "id, risk_type, status, trigger_detail, estimated_value_cents, currency, nba_action, nba_reason, deadline_at, detected_at",
      )
      .eq("organization_id", activeOrg.orgId)
      .eq("account_id", id)
      .order("detected_at", { ascending: false })
      .limit(50),
    supabase
      .from("revenue_events")
      .select("event_kind, lineage, value_cents, currency, occurred_at, source_kind, source_id")
      .eq("organization_id", activeOrg.orgId)
      .eq("account_id", id)
      .order("occurred_at", { ascending: false })
      .limit(100),
    supabase
      .from("conversations")
      .select("id, contact_id, status, last_message_at")
      .eq("organization_id", activeOrg.orgId)
      .in("contact_id", idsDeContato.length > 0 ? idsDeContato : [placeholder])
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(10),
  ]);

  const pedidosRows = ((pedidos.data ?? []) as unknown as Array<{ id: string; status: string }>);
  const idsDeRascunho = pedidosRows
    .filter((p) => p.status === "draft")
    .map((p) => p.id);
  const { data: itensDeRascunho } = await supabase
    .from("order_items")
    .select("order_id, sku, nome, quantity, unit_price_cents, moeda")
    .eq("organization_id", activeOrg.orgId)
    .in("order_id", idsDeRascunho.length > 0 ? idsDeRascunho : [placeholder]);

  // Confirmação usa o contrato A6: as linhas do rascunho vão no corpo e o
  // servidor RE-RESOLVE os preços na hora — a tela nunca envia preço.
  const linhasPorRascunho = new Map<
    string,
    Array<{ product_id: string; quantity: number }>
  >();
  for (const item of (itensDeRascunho ?? []) as unknown as Array<{
    order_id: string;
    product_id: string | null;
    quantity: number;
  }>) {
    if (item.product_id === null) continue;
    const lista = linhasPorRascunho.get(item.order_id) ?? [];
    lista.push({ product_id: item.product_id, quantity: item.quantity });
    linhasPorRascunho.set(item.order_id, lista);
  }

  const nomesDeContato = new Map((contatos ?? []).map((c) => [c.id, c.display_name ?? "—"]));

  return (
    <Account360Client
      conta={conta as { id: string; name: string; external_id: string | null; status: string }}
      podeAgir={podeAgir}
      contatos={contatos ?? []}
      conversas={((conversas.data ?? []) as unknown as Array<{ id: string; contact_id: string; status: string; last_message_at: string | null }>)}
      oportunidades={((opps.data ?? []) as unknown as Array<{ id: string; title: string | null; status: string; value_cents: number | null; currency: string | null }>)}
      pedidos={((pedidos.data ?? []) as unknown as Array<{ id: string; external_id: string; status: string; total_cents: number; currency: string; ordered_at: string | null }>)}
      itensPorRascunho={Object.fromEntries(linhasPorRascunho)}
      riscos={((riscos.data ?? []) as unknown as Array<{ id: string; risk_type: string; status: string; trigger_detail: string; estimated_value_cents: number | null; currency: string | null; nba_action: string; nba_reason: string; deadline_at: string | null; detected_at: string }>)}
      eventos={((eventos.data ?? []) as unknown as Array<{ event_kind: string; lineage: string; value_cents: number | null; currency: string | null; occurred_at: string }>)}
      nomesDeContato={Object.fromEntries(nomesDeContato)}
      textos={{
        titulo: (conta as { name: string }).name,
        voltar: t("Voltar para contas"),
        secoes: {
          contatos: t("Contatos"),
          conversas: t("Conversas recentes"),
          oportunidades: t("Oportunidades"),
          pedidos: t("Pedidos"),
          receita: t("Receita"),
          risco: t("Receita em risco"),
          eventos: t("Eventos de receita"),
        },
        acoes: {
          confirmar: t("Confirmar pedido"),
          abrirConversa: t("Abrir conversa"),
        },
        vazios: {
          contatos: t("Nenhum contato vinculado."),
          oportunidades: t("Nenhuma oportunidade aberta."),
          pedidos: t("Nenhum pedido ainda."),
          risco: t("Nada em risco nesta conta."),
          eventos: t("Nenhum evento de receita registrado."),
          conversas: t("Nenhuma conversa registrada."),
        },
      }}
    />
  );
}
