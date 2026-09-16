import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { COLUNAS_DA_CONTA, type Conta } from "@/lib/schemas/contas";
import { createClient } from "@/lib/supabase/server";

import { ContasClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Contas B2B" };

/**
 * AS CONTAS B2B — a empresa-cliente do tenant (RevenueOS Fase 2, 0239).
 *
 * ─── Por que esta tela nasce agora ───────────────────────────────────────
 *
 * O funil e a conversa já operam sobre PESSOAS (`contacts`), e o B2C nunca
 * precisou de mais nada. No atacado, quem negocia é a EMPRESA: condições,
 * referência externa e o rep responsável são da conta — sem ela, pricing
 * (Fase 3) e pedido (Fase 4) não têm onde ancorar. A tela é o cadastro;
 * a conversa continua acontecendo com o contato.
 *
 * ─── Quem pode o quê ─────────────────────────────────────────────────────
 *
 * `viewer` VÊ (informação de operação, como o catálogo); criar e editar é
 * `manager`, e a rota cobra de novo — a tela esconder o botão é cortesia,
 * não autorização. Arquivar (status `archived`) é o "remover": contatos
 * vinculados nunca são órfãos por trás do operador.
 */
export default async function ContasPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  const supabase = await createClient();
  const { data } = await supabase
    .from("accounts")
    .select(COLUNAS_DA_CONTA)
    .eq("organization_id", activeOrg.orgId)
    .order("status", { ascending: true })
    .order("name")
    .limit(500);

  return (
    <ContasClient
      inicial={(data ?? []) as unknown as Conta[]}
      podeEditar={podeEditar}
      textos={{
        titulo: t("Contas B2B"),
        subtitulo: t(
          "As empresas-cliente. É da conta que saem as condições comerciais — o preço e o pedido da Fase 3-4 ancoram aqui.",
        ),
        vazio: t("Nenhuma conta cadastrada ainda"),
        vazioDica: t(
          "Cadastre a empresa-cliente e vincule os contatos a ela na edição do contato. Vender sem conta funciona como sempre.",
        ),
      }}
    />
  );
}
