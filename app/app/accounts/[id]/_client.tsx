"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { rotuloDoEstadoDoCanal } from "@/lib/channels/estado";
import { formatCents } from "@/lib/money";

export interface Conta360 {
  id: string;
  name: string;
  external_id: string | null;
  status: string;
}

export interface Contato360 {
  id: string;
  display_name: string | null;
  phone_number: string | null;
  last_activity_at: string | null;
}

export interface Conversa360 {
  id: string;
  contact_id: string;
  status: string;
  last_message_at: string | null;
}

export interface Oportunidade360 {
  id: string;
  title: string | null;
  status: string;
  value_cents: number | null;
  currency: string | null;
}

export interface Pedido360 {
  id: string;
  external_id: string;
  status: string;
  total_cents: number;
  currency: string;
  ordered_at: string | null;
}

export interface Risco360 {
  id: string;
  risk_type: string;
  status: string;
  trigger_detail: string;
  estimated_value_cents: number | null;
  currency: string | null;
  nba_action: string;
  nba_reason: string;
  deadline_at: string | null;
  detected_at: string;
}

export interface Evento360 {
  event_kind: string;
  lineage: string;
  value_cents: number | null;
  currency: string | null;
  occurred_at: string;
}

interface Props {
  conta: Conta360;
  podeAgir: boolean;
  contatos: Contato360[];
  conversas: Conversa360[];
  oportunidades: Oportunidade360[];
  pedidos: Pedido360[];
  itensPorRascunho: Record<string, Array<{ product_id: string; quantity: number }>>;
  riscos: Risco360[];
  eventos: Evento360[];
  nomesDeContato: Record<string, string>;
  textos: {
    titulo: string;
    voltar: string;
    secoes: {
      contatos: string;
      conversas: string;
      oportunidades: string;
      pedidos: string;
      receita: string;
      risco: string;
      eventos: string;
    };
    acoes: { confirmar: string; abrirConversa: string };
    vazios: {
      contatos: string;
      oportunidades: string;
      pedidos: string;
      risco: string;
      eventos: string;
      conversas: string;
    };
  };
}

const ROTULO_STATUS_CONTA: Record<string, { es: string; classe: string }> = {
  active: { es: "Activa", classe: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" },
  inactive: { es: "Inactiva", classe: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  archived: { es: "Archivada", classe: "bg-muted text-muted-foreground" },
};

const ROTULO_STATUS_PEDIDO: Record<string, { es: string }> = {
  draft: { es: "Borrador" },
  confirmed: { es: "Confirmado" },
  pending: { es: "Pendiente" },
  paid: { es: "Pagado" },
  cancelled: { es: "Cancelado" },
  fulfilled: { es: "Preparado" },
  shipped: { es: "Enviado" },
  delivered: { es: "Entregado" },
  closed: { es: "Cerrado" },
  refunded: { es: "Reembolsado" },
};

export function Account360Client({
  conta,
  podeAgir,
  contatos,
  conversas,
  oportunidades,
  pedidos,
  itensPorRascunho,
  riscos,
  eventos,
  nomesDeContato,
}: Props) {
  const t = useT();
  const router = useRouter();
  const [confirmando, setConfirmando] = React.useState<string | null>(null);

  async function confirmarPedido(pedido: Pedido360) {
    const linhas = itensPorRascunho[pedido.id] ?? [];
    if (linhas.length === 0) {
      toast.error(t("Rascunho sem linhas — atualize-o antes de confirmar."));
      return;
    }
    setConfirmando(pedido.id);
    try {
      await apiClient.post(`/api/v1/orders/${pedido.id}/confirm`, {
        items: linhas,
      });
      toast.success(t("Pedido confirmado"));
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setConfirmando(null);
    }
  }

  const riscosAbertos = riscos.filter((r) => r.status === "open");

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-account-360">
      <Link href="/app/accounts" className="text-sm text-muted-foreground underline">
        {t("← Contas B2B")}
      </Link>
      <header className="mt-2 mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{conta.name}</h1>
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            ROTULO_STATUS_CONTA[conta.status]?.classe ?? "bg-muted text-muted-foreground"
          }`}
        >
          {ROTULO_STATUS_CONTA[conta.status]?.es ?? conta.status}
        </span>
        {conta.external_id ? (
          <span className="text-sm text-muted-foreground">{conta.external_id}</span>
        ) : null}
      </header>

      <section className="mb-8" data-testid="secao-contatos">
        <h2 className="mb-2 text-lg font-semibold">{t("Contatos")}</h2>
        {contatos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum contato vinculado.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {contatos.map((c) => (
              <li key={c.id} className="flex items-center justify-between p-3">
                <span className="text-sm font-medium">{c.display_name ?? "—"}</span>
                <span className="text-xs text-muted-foreground">{c.phone_number ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8" data-testid="secao-conversas">
        <h2 className="mb-2 text-lg font-semibold">{t("Conversas recentes")}</h2>
        {conversas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhuma conversa registrada.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {conversas.map((cv) => (
              <li key={cv.id} className="flex items-center justify-between p-3">
                <span className="text-sm">
                  {nomesDeContato[cv.contact_id] ?? "—"}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {rotuloDoEstadoDoCanal(cv.status, t)}
                  </span>
                </span>
                <Link
                  href={`/app/inbox/${cv.id}`}
                  className="text-sm underline"
                  data-testid={`abrir-conversa-${cv.id}`}
                >
                  {t("Abrir conversa")}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8" data-testid="secao-oportunidades">
        <h2 className="mb-2 text-lg font-semibold">{t("Oportunidades")}</h2>
        {oportunidades.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhuma oportunidade aberta.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {oportunidades.map((o) => (
              <li key={o.id} className="flex items-center justify-between p-3">
                <span className="text-sm font-medium">{o.title ?? "—"}</span>
                <span className="text-sm tabular-nums">
                  {o.value_cents !== null && o.currency
                    ? formatCents(o.value_cents, o.currency)
                    : "—"}
                </span>
                <span className="text-xs text-muted-foreground">{o.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mb-8" data-testid="secao-pedidos">
        <h2 className="mb-2 text-lg font-semibold">{t("Pedidos")}</h2>
        {pedidos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum pedido ainda.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {pedidos.map((p) => {
              const itens = itensPorRascunho[p.id] ?? [];
              const totalLinhas = itens.reduce((acc, i) => acc + i.quantity, 0);
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{p.external_id}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.status === "draft" && totalLinhas > 0
                        ? `${t("Rascunho")} · ${totalLinhas} ${t("itens")}`
                        : (ROTULO_STATUS_PEDIDO[p.status]?.es ?? p.status)}
                    </p>
                  </div>
                  <span className="shrink-0 tabular-nums text-sm font-medium">
                    {formatCents(p.total_cents, p.currency)}
                  </span>
                  {podeAgir && p.status === "draft" && itens.length > 0 ? (
                    <Button
                      size="sm"
                      disabled={confirmando === p.id}
                      onClick={() => void confirmarPedido(p)}
                      data-testid={`confirmar-pedido-${p.id}`}
                    >
                      {confirmando === p.id ? t("Confirmando…") : t("Confirmar pedido")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mb-8" data-testid="secao-risco">
        <h2 className="mb-2 text-lg font-semibold">{t("Receita em risco")}</h2>
        {riscosAbertos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nada em risco nesta conta.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {riscosAbertos.map((r) => (
              <li key={r.id} className="p-3">
                <p className="text-sm">{r.trigger_detail}</p>
                <p className="mt-0.5 text-xs">
                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                    {r.nba_action}
                  </span>{" "}
                  <span className="text-muted-foreground">{r.nba_reason}</span>
                  {r.estimated_value_cents !== null && r.currency ? (
                    <span className="ml-2 tabular-nums">
                      {formatCents(r.estimated_value_cents, r.currency)}
                    </span>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section data-testid="secao-eventos">
        <h2 className="mb-2 text-lg font-semibold">{t("Eventos de receita")}</h2>
        {eventos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum evento de receita registrado.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {eventos.slice(0, 20).map((e, i) => (
              <li key={`${e.event_kind}-${i}`} className="flex items-center justify-between p-3 text-sm">
                <span>{e.event_kind}</span>
                <span className="tabular-nums text-muted-foreground">
                  {e.value_cents !== null && e.currency ? formatCents(e.value_cents, e.currency) : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
