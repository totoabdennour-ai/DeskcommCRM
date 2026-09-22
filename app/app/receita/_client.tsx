"use client";

import * as React from "react";
import Link from "next/link";

import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

interface Textos {
  titulo: string;
  subtitulo: string;
}

interface LinhaFila {
  id: string;
  risk_type: string;
  account_id: string | null;
  account_name: string | null;
  order_id: string | null;
  motivo: string;
  estimated_value_cents: number | null;
  currency: string | null;
  deadline_at: string | null;
  nba_action: string;
  nba_reason: string;
  detected_at: string;
}

interface Resumo {
  oportunidades_abertas: { count: number; valor_por_moeda: Array<{ moeda: string; total_cents: number }> };
  revenue_at_risk: { count: number; valor_por_moeda: Array<{ moeda: string; total_cents: number }>; por_tipo: Array<{ risk_type: string; count: number }> };
  receita_direta_por_moeda: Array<{ moeda: string; total_cents: number }>;
  receita_recuperada_por_moeda: Array<{ moeda: string; total_cents: number }>;
  receita_influenciada_por_moeda: Array<{ moeda: string; total_cents: number }>;
  pedidos: { criados: number; confirmados: number };
  itens_nao_resolvidos: number;
  nota: string;
}

const ACAO_LABEL: Record<string, string> = {
  follow_up_customer: "Falar com o cliente",
  request_missing_quantity: "Pedir a quantidade",
  clarify_product: "Esclarecer o produto",
  request_human_pricing_review: "Revisão humana de preço",
  request_confirmation: "Pedir a confirmação do pedido",
  reactivate_customer: "Reativar o cliente",
};

export function ReceitaClient({ textos }: { textos: Textos }) {
  const t = useT();
  const [carregando, setCarregando] = React.useState(true);
  const [indisponivel, setIndisponivel] = React.useState(false);
  const [fila, setFila] = React.useState<LinhaFila[]>([]);
  const [resumo, setResumo] = React.useState<Resumo | null>(null);

  React.useEffect(() => {
    let ativo = true;
    const carregar = async () => {
      try {
        const [filaRes, resumoRes] = await Promise.all([
          apiClient.get<LinhaFila[]>("/api/v1/receita/fila"),
          apiClient.get<Resumo>("/api/v1/receita/resumo"),
        ]);
        if (ativo) {
          setFila(filaRes ?? []);
          setResumo(resumoRes);
          setIndisponivel(false);
        }
      } catch {
        if (ativo) setIndisponivel(true);
      } finally {
        if (ativo) setCarregando(false);
      }
    };
    void carregar();
    const timer = setInterval(carregar, 60_000);
    return () => {
      ativo = false;
      clearInterval(timer);
    };
  }, []);

  const moedaFmt = (v: { moeda: string; total_cents: number }) =>
    `${v.moeda} ${(v.total_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;

  return (
    <div className="mx-auto w-full max-w-6xl p-6" data-testid="tela-receita">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      {resumo ? (
        <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="metricas-receita">
          {[
            { rotulo: t("Oportunidades abertas"), itens: resumo.oportunidades_abertas.valor_por_moeda, count: resumo.oportunidades_abertas.count },
            { rotulo: t("Receita em risco"), itens: resumo.revenue_at_risk.valor_por_moeda, count: resumo.revenue_at_risk.count },
            { rotulo: t("Receita direta"), itens: resumo.receita_direta_por_moeda, count: resumo.pedidos.confirmados },
            { rotulo: t("Receita recuperada"), itens: resumo.receita_recuperada_por_moeda, count: null },
          ].map((m) => (
            <div key={m.rotulo} className="rounded-lg border p-4" data-testid={`metrica-${m.rotulo}`}>
              <p className="text-xs text-muted-foreground">{m.rotulo}</p>
              {m.itens.length === 0 ? (
                <p className="mt-1 text-lg font-medium">{t("Sem valor na janela")}</p>
              ) : (
                m.itens.map((v) => (
                  <p key={v.moeda} className="mt-1 text-lg font-medium tabular-nums">
                    {moedaFmt(v)}
                  </p>
                ))
              )}
              {m.count !== null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {m.count} {t("itens")}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("Fila do operador — prioridade do sistema")}</h2>
        {carregando ? <span className="text-sm text-muted-foreground">{t("Carregando…")}</span> : null}
      </div>

      {indisponivel ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="receita-indisponivel">
          <p className="font-medium">{t("Dados de receita indisponíveis agora.")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("Tente de novo em instantes.")}</p>
        </div>
      ) : !carregando && fila.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="fila-vazia">
          <p className="font-medium">{t("Nada em risco na fila.")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Detectores rodam automaticamente; quando algo esfriar, aparece aqui.")}
          </p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="fila-receita">
          {fila.map((item, i) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 p-3" data-testid={`fila-${item.id}`}>
              <span className="w-6 shrink-0 text-center text-sm font-semibold text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {item.account_name ?? t("Conta não vinculada")}
                </p>
                <p className="text-xs text-muted-foreground">{item.motivo}</p>
                <p className="mt-0.5 text-xs">
                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">
                    {t(ACAO_LABEL[item.nba_action] ?? item.nba_action)}
                  </span>{" "}
                  <span className="text-muted-foreground">{item.nba_reason}</span>
                </p>
              </div>
              {item.estimated_value_cents !== null ? (
                <span className="shrink-0 tabular-nums text-sm font-medium">
                  {item.currency} {(item.estimated_value_cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </span>
              ) : null}
              {item.account_id ? (
                <Link href={`/app/accounts/${item.account_id}`} className="shrink-0 text-sm underline" data-testid={`abrir-conta-${item.id}`}>
                  {t("Abrir conta")}
                </Link>
              ) : null}
              {item.order_id ? (
                <Link
                  href={`/app/accounts/${item.account_id ?? ""}?pedido=${item.order_id}`}
                  className="shrink-0 text-sm underline"
                >
                  {t("Ver pedido")}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-xs text-muted-foreground">
        {t("A prioridade é calculada pelo sistema (severidade, prazo, valor). Resumo em moeda nativa — consolidação multi-moeda não é suportada.")}
      </p>
    </div>
  );
}
