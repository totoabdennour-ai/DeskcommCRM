/**
 * CPF normalization + hashing helpers.
 *
 * ─── MODELO DE DADO DO CPF (decisão da Fase 1 — docs/our-product/DECISIONS.md (D17)) ────────
 *
 * O CPF é tratado como DADO PSEUDÔNIMO, não como segredo reversível:
 *
 *  - `cpf_hash` = sha256 hex dos 11 dígitos normalizados. Serve para busca
 *    exata e dedup sem expor o plaintext. SEM salt, de propósito: o hash tem
 *    de ser estável entre escritas e buscas (um salt por linha quebraria a
 *    consulta por igualdade).
 *  - NÃO há criptografia reversível. O RPC `encrypt_cpf` NUNCA existiu no
 *    schema (o código anterior o chamava e degradava com console.warn), a
 *    `CPF_ENCRYPTION_KEY` foi removida do contrato de env, e a coluna
 *    `contacts.cpf_encrypted` permanece RESERVADA E VAZIA (não há migration
 *    para removê-la — apagar coluna de PII em cascade LGPD é risco sem ganho
 *    de segurança).
 *
 * Limitação assumida e documentada: sha256 sem salt sobre um espaço de ~10^11
 * valores (com dígito verificador reduzindo ainda mais) É brute-forceável —
 * o hash é pseudônimo, não anônimo, e não deve ser apresentado como proteção
 * de confidencialidade. O que protege o CPF em repouso é a superfície como um
 * todo: RLS por organização, sem SELECT aberto, anonimização LGPD que ZERA o
 * hash nas cascatas, e audit append-only. Reversibilidade (se um dia exigida
 * legalmente) é decisão de produto nova — e viria com migration, chave e
 * invariante próprios, não com este arquivo.
 */
import { createHash } from "node:crypto";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Stable sha256 hex of normalized CPF for fuzzy/exact search via `cpf_hash`.
 */
export function hashCpf(raw: string): string {
  return createHash("sha256").update(normalizeCpf(raw)).digest("hex");
}
