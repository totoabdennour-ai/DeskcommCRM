import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DA_LISTA, type ListaDePreco } from "@/lib/schemas/precos";
import { createClient } from "@/lib/supabase/server";

import { PrecosClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Preços B2B" };

/**
 * PREÇOS B2B — as listas que sobrepõem o preço base do catálogo (0240).
 *
 * ─── Por que esta tela é mínima de propósito ─────────────────────────────
 *
 * O que o operador B2B precisa: criar a lista da conta, dizer quanto custa
 * cada produto NELA, e ligar/desligar. O RESOLVER (`lib/pricing/`) é quem
 * decide na hora da venda — esta tela só cadastra insumo, como Produtos.
 * Campanhas, desconto composto, preço por quantidade: fora de escopo (doc 24).
 *
 * ─── Quem pode o quê ─────────────────────────────────────────────────────
 *
 * `viewer` VÊ (o preço é informação de operação); mutação é `manager`, e a
 * rota cobra de novo — a tela esconder o botão é cortesia, não autorização.
 */
export default async function PrecosPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const { data } = await supabase
    .from("price_lists")
    .select(COLUNAS_DA_LISTA)
    .eq("organization_id", activeOrg.orgId)
    .order("status", { ascending: true })
    .order("nome")
    .limit(200);

  return (
    <PrecosClient
      inicial={(data ?? []) as unknown as ListaDePreco[]}
      podeEditar={podeEditar}
      textos={{
        titulo: t("Preços B2B"),
        subtitulo: t(
          "Listas de preço por conta. O produto que está na lista usa o preço dela; o que não está, usa o preço do catálogo.",
        ),
        vazio: t("Nenhuma lista de preço ainda"),
        vazioDica: t(
          "Crie uma lista, cadastre os preços especiais e escolha-a na conta do cliente. Sem lista, vale o preço do catálogo.",
        ),
      }}
    />
  );
}
