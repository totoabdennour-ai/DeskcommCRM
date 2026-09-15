import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * HANDLER COM SERVICE ROLE DECLARA ORGANIZAÇÃO — OU JUSTIFICA NA ALLOWLIST.
 *
 * ─── O risco (Fase 0, docs/our-product/08 R1 / 09 §3) ───────────────────────
 *
 * 149 arquivos de rota importam `createAdminClient` (service role, BYPASSA
 * RLS). A regra da doutrina — filtre `organization_id` de fonte confiável — é
 * aplicada por revisão humana: nenhum gate impedia um handler NOVO de nascer
 * sem filtro com todos os checks verdes. É o pior modo de falha do produto
 * (vazamento cross-tenant) e o buraco mais barato de fechar.
 *
 * ─── O que o gate mede (e o que NÃO mede) ───────────────────────────────────
 *
 * Mede: todo arquivo não-teste sob `app/` que importa `@/lib/supabase/admin`
 * precisa MANIPULAR identidade de organização no código — identificador ou
 * literal seguindo a convenção do repo (`organizationId`, `orgId`,
 * `organization_id`, `p_org*`, literal de coluna em `.eq("organization_id")`,
 * chave de RPC) — OU estar na allowlist abaixo COM justificativa escrita.
 * Ancorado no AST: comentário citando organization_id NÃO conta (a disciplina
 * não pode morar em prosa).
 *
 * Não mede: que o filtro esteja CORRETO ou resolvido de fonte confiável —
 * isso continua sendo prova dos invariantes comportamentais em `test:db`
 * (`mcp-nao-alcanca-outro-tenant` etc.). O gate é a cerca da entrada; os
 * invariantes são a prova de fundo. Allowlist SÓ ENCOLHE — mesma regra da
 * allowlist de branding.
 */

const RAIZ = join(__dirname, "..", "..");

/**
 * Handlers que operam FORA do escopo de uma organização de propósito.
 * Cada entrada é um caso consciente; entrada sem razão escrita reprova.
 * Primeira rodada do gate (Fase 1): 182 arquivos importam admin; 15 são
 * cross-org por natureza — os demais referenciam org pelo código.
 */
const ALLOWLIST: Record<string, string> = {
  // ── Server Actions de auth do PRÓPRIO usuário (auth.* do GoTrue; nenhuma
  //    tabela tenant-aware no alvo):
  "app/actions/auth/confirmMfaEnroll.ts":
    "Fatores MFA do próprio usuário em auth.* (GoTrue); nenhuma tabela tenant-aware.",
  "app/actions/auth/useRecoveryCode.ts":
    "Códigos de recuperação do próprio usuário em auth.*; nenhuma tabela tenant-aware.",
  "app/actions/settings/regenerateRecoveryCodes.ts":
    "Códigos de recuperação do próprio usuário em auth.*; nenhuma tabela tenant-aware.",
  // ── Estado da INSTALAÇÃO (não do tenant), gated por plataforma:
  "app/actions/settings/updateBranding.ts":
    "Marca da instalação (platform_branding) — não pertence a tenant; requirePlatformAdmin.",
  "app/actions/settings/updateGoogleOAuth.ts":
    "Credencial Google da instalação (platform_google_oauth) — não é de tenant; requirePlatformAdmin.",
  "app/admin/(protected)/google/page.tsx":
    "Configuração Google da PLATAFORMA; requirePlatformAdmin.",
  "app/admin/(protected)/tenants/[id]/layout.tsx":
    "Superfície de plataforma: lê UM tenant escolhido por id — cross-tenant é o propósito; requirePlatformAdmin.",
  "app/api/v1/admin/platform-admins/route.ts":
    "Gestão de super-admins (cross-tenant por natureza); requirePlatformAdmin.",
  // ── Crons de fundo que varrem TODAS as organizações por natureza
  //    (Bearer INTERNAL_CRON_SECRET fail-closed + rate limit de borda);
  //    cada linha processada carrega a organization_id própria:
  "app/api/v1/cron/attendant-heartbeat/route.ts":
    "Cron cross-org por natureza (presença de todos os atendentes); Bearer fail-closed.",
  "app/api/v1/cron/event-log-drain/route.ts":
    "Cron cross-org por natureza (drain genérico de todas as orgs); Bearer fail-closed.",
  "app/api/v1/cron/sync-model-catalog/route.ts":
    "Catálogo global de modelos da instalação (sem tenant); Bearer fail-closed.",
  "app/api/v1/cron/webhook-log-retention/route.ts":
    "Poda de retenção cross-org por natureza; Bearer fail-closed.",
  // ── Estado da instalação exposto ao agente de update da VPS:
  "app/api/v1/system/agent/route.ts":
    "Endpoint do agente do host (update da VPS); Bearer timing-safe; estado da instalação, não de tenant.",
  "app/api/v1/system/update/route.ts":
    "Atualização da instalação (system_update_runs); requireSupportWrite; sem tenant no alvo.",
  "app/api/v1/system/version/route.ts":
    "Versão da instalação para a tela; leitura de estado de instalação.",
};

function arquivosFonte(dir: string): string[] {
  const saida: string[] = [];
  const varrer = (atual: string): void => {
    for (const e of readdirSync(atual, { withFileTypes: true })) {
      const caminho = join(atual, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        varrer(caminho);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
        saida.push(caminho);
      }
    }
  };
  varrer(dir);
  return saida;
}

export function importaAdminSemReferenciaDeOrg(
  fonte: string,
  nomeDoArquivo: string,
): boolean {
  const arquivo = ts.createSourceFile(nomeDoArquivo, fonte, ts.ScriptTarget.Latest, true);
  let importaAdmin = false;
  let referenciaOrg = false;

    // Convenção do repo: organizationId | orgId | organization_id | p_org*.
    const EH_DE_ORG = /^(organizationid|organization_id|orgids?|orgid|p_org\w*)$/i;
    const visitar = (no: ts.Node): void => {
      if (ts.isImportDeclaration(no) && ts.isStringLiteral(no.moduleSpecifier)) {
        if (no.moduleSpecifier.text.includes("lib/supabase/admin")) importaAdmin = true;
      }
      if (ts.isIdentifier(no) && (EH_DE_ORG.test(no.text) || /organization/i.test(no.text))) {
        referenciaOrg = true;
      }
      if (ts.isStringLiteral(no) && /organization/i.test(no.text)) referenciaOrg = true;
      if (ts.isPropertyAssignment(no) && /^p?_?org/i.test(no.name.getText())) referenciaOrg = true;
      ts.forEachChild(no, visitar);
    };
  visitar(arquivo);

  return importaAdmin && !referenciaOrg;
}

describe("service role declara organização (Fase 1)", () => {
  it("todo arquivo que importa createAdminClient referencia org ou está na allowlist", () => {
    const appRaiz = join(RAIZ, "app");
    const infratoras = arquivosFonte(appRaiz)
      .filter((c) => importaAdminSemReferenciaDeOrg(readFileSync(c, "utf8"), c))
      .map((c) => c.replace(RAIZ, "").replace(/\\/g, "/"))
      .filter((c) => !(c.replace(/^\//, "") in ALLOWLIST));

    expect(infratoras).toEqual([]);
  });

  it("allowlist não tem entrada sem justificativa (a lista só encolhe)", () => {
    for (const [arquivo, razao] of Object.entries(ALLOWLIST)) {
      expect(arquivo, `entrada sem razão: ${arquivo}`).toMatch(/^app\//);
      expect(typeof razao, `razão vazia: ${arquivo}`).toBe("string");
      expect(razao.length, `razão vazia: ${arquivo}`).toBeGreaterThan(10);
    }
  });

  it("o guard reconhece os padrões (controle interno)", () => {
    const bom = `import { createAdminClient } from "@/lib/supabase/admin";
export async function h() {
  const admin = createAdminClient();
  return admin.from("t").select("*").eq("organization_id", org);
}`;
    const mau = `import { createAdminClient } from "@/lib/supabase/admin";
export async function h() {
  const admin = createAdminClient();
  return admin.from("t").select("*"); // sem org em lugar nenhum
}`;
    const comentarioNaoConta = `import { createAdminClient } from "@/lib/supabase/admin";
// filtra organization_id (mentira em prosa não é filtro)
export async function h() { return createAdminClient(); }`;
    const semAdmin = `import { createClient } from "@/lib/supabase/server";
export async function h() { return createClient(); }`;

    expect(importaAdminSemReferenciaDeOrg(bom, "a.ts")).toBe(false);
    expect(importaAdminSemReferenciaDeOrg(mau, "b.ts")).toBe(true);
    expect(importaAdminSemReferenciaDeOrg(comentarioNaoConta, "c.ts")).toBe(true);
    expect(importaAdminSemReferenciaDeOrg(semAdmin, "d.ts")).toBe(false);
  });
});
