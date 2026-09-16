import { z } from "zod";

/**
 * O CONTRATO DE CONTAS B2B — um só, lido pela tela E pela rota (mesma doutrina
 * de `produtos.ts`: um schema por lado é como nasce controle decorativo).
 *
 * Conta = a EMPRESA-CLIENTE do tenant (RevenueOS Fase 2, docs/our-product/21
 * §8). É a camada ACIMA de `contacts`: pessoa física continua em contacts,
 * o vínculo é OPCIONAL (`contacts.account_id`) e B2C segue intacto.
 *
 * ⚠️ Fase 2 é FUNDAÇÃO: nada de pricing, MOQ, crédito ou regras de pedido
 * aqui — `settings jsonb` é a PORTA para elas (Fase 3-4), e nasce `{}` sem
 * schema fixo de propósito (DIRC: não especular campos). Este arquivo valida
 * a forma estrutural, não o conteúdo de negócio.
 */

/** Vocabulário do ciclo de vida — tem CHECK no banco (0239). Não renomear. */
export const CONTAS_STATUS = ["active", "inactive", "archived"] as const;
export type StatusDaConta = (typeof CONTAS_STATUS)[number];

const settingsSchema = z
  .record(z.string(), z.unknown())
  .refine((s) => JSON.stringify(s ?? {}).length <= 16_000, {
    message: "settings excede 16kB",
  });

export const contaCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  external_id: z.string().trim().min(1).max(100).nullish(),
  status: z.enum(CONTAS_STATUS).default("active"),
  owner_user_id: z.string().uuid().nullish(),
  settings: settingsSchema.optional(),
});
export type ContaCreate = z.infer<typeof contaCreateSchema>;

/** PATCH muda o que veio, não encosta no resto (mesma regra de products). */
export const contaPatchSchema = contaCreateSchema.partial();
export type ContaPatch = z.infer<typeof contaPatchSchema>;

/** Colunas do SELECT canônico — a tela e a rota leem exatamente isto. */
export const COLUNAS_DA_CONTA =
  "id, organization_id, name, external_id, status, settings, owner_user_id, created_by, created_at, updated_at";

/**
 * A linha como a tela e a API a leem (COLUNAS_DA_CONTA). Explícita de
 * propósito: `lib/database.types.ts` é gerado e o repo não regenera a cada
 * migration (catalog_products e team_invites nasceram fora dele); a tipagem
 * de domínio mora no schema, como no catálogo.
 */
export interface Conta {
  id: string;
  organization_id: string;
  name: string;
  external_id: string | null;
  status: StatusDaConta;
  settings: Record<string, unknown>;
  owner_user_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
