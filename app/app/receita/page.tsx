import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { ReceitaClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Operação de Receita" };

/**
 * OPERAÇÃO DE RECEITA (Fase 7) — a fila do dia e o resumo do dinheiro.
 *
 * Fila: riscos abertos priorizados pela NBA determinística (server-side — a
 * UI apenas renderiza a ordem que o backend manda). Métricas: somas nativas
 * do `resumo` (server-side). A UI não calcula dinheiro.
 */
export default async function ReceitaPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  return (
    <ReceitaClient
      textos={{
        titulo: t("Operação de Receita"),
        subtitulo: t(
          "O que está em risco agora, por quê, e qual a próxima ação — prioridade calculada pelo sistema.",
        ),
      }}
    />
  );
}
