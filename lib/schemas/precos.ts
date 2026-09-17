import { z } from "zod";

/**
 * O CONTRATO DE PRECIFICAÇÃO B2B — um só, lido pela tela, pelas rotas e pelo
 * resolver (mesma doutrina de `produtos.ts`/`contas.ts`).
 *
 * O preço BASE é `catalog_products.preco_cents` — nada paralelo. A lista
 * SOBREPÕE o base por produto, para as contas que apontam para ela
 * (`accounts.price_list_id`, 0240). A RESOLUÇÃO é determinística e mora em
 * `lib/pricing/` — IA nunca calcula, nunca inventa, nunca sobrescreve preço
 * (doc 24 §fronteira; o guardrail de promessa segue vetando a SAÍDA).
 */

/** Vocabulário do ciclo de vida da lista — tem CHECK no banco (0240). */
export const STATUS_DA_LISTA = ["active", "inactive"] as const;
export type StatusDaLista = (typeof STATUS_DA_LISTA)[number];

export const listaCreateSchema = z.object({
  nome: z.string().trim().min(1).max(200),
  status: z.enum(STATUS_DA_LISTA).default("active"),
  // ⚠️ SEM `moeda` de propósito: a moeda da lista é a que a ORGANIZAÇÃO
  // declarou (`moedaDaOrganizacao`, o mesmo caminho do catálogo) — o corpo da
  // requisição nunca decide unidade (CLAUDE.md multi-tenancy). O CHECK
  // `^[A-Z]{3}$` vive no banco; criar lista em outra moeda é feature futura
  // explícita, não default deste contrato.
});
export type ListaCreate = z.infer<typeof listaCreateSchema>;

/** PATCH muda o que veio, não encosta no resto. */
export const listaPatchSchema = listaCreateSchema.partial();
export type ListaPatch = z.infer<typeof listaPatchSchema>;

/**
 * Upsert de item: um preço por (lista, produto). `preco_cents` chega como
 * INTEIRO de centavos — a conversão de "5.499,00" para centavos é trabalho do
 * cliente (`precoParaCentavos`, falha fechada), o servidor não adivinha moeda.
 */
export const itemUpsertSchema = z.object({
  product_id: z.string().uuid(),
  preco_cents: z.number().int().min(0),
});
export type ItemUpsert = z.infer<typeof itemUpsertSchema>;

/** Colunas do SELECT canônico das listas. */
export const COLUNAS_DA_LISTA =
  "id, organization_id, nome, moeda, status, created_by, created_at, updated_at";

/** Colunas do SELECT canônico dos itens (com o produto para a tela). */
export const COLUNAS_DO_ITEM =
  "id, organization_id, price_list_id, product_id, preco_cents, created_at, updated_at, catalog_products(codigo, nome, ativo)";

/** A lista como a tela e a API a leem (COLUNAS_DA_LISTA). */
export interface ListaDePreco {
  id: string;
  organization_id: string;
  nome: string;
  moeda: string;
  status: StatusDaLista;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
