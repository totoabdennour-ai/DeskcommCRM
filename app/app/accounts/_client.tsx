"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { CONTAS_STATUS, type Conta, type StatusDaConta } from "@/lib/schemas/contas";

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface Rascunho {
  id: string | null;
  name: string;
  external_id: string;
  status: StatusDaConta;
}

function rotuloDoStatus(s: StatusDaConta, t: (x: string) => string): string {
  if (s === "active") return t("Ativa");
  if (s === "inactive") return t("Inativa");
  return t("Arquivada");
}

const CLASSE_DO_STATUS: Record<StatusDaConta, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  inactive: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  archived: "bg-muted text-muted-foreground",
};

export function ContasClient({
  inicial,
  podeEditar,
  textos,
}: {
  inicial: Conta[];
  podeEditar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [busca, setBusca] = React.useState("");
  const [rascunho, setRascunho] = React.useState<Rascunho | null>(null);
  const [salvando, setSalvando] = React.useState(false);

  const filtradas = React.useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (q === "") return inicial;
    return inicial.filter((c) =>
      [c.name, c.external_id ?? ""].join(" ").toLowerCase().includes(q),
    );
  }, [inicial, busca]);

  function abrirNova() {
    setRascunho({ id: null, name: "", external_id: "", status: "active" });
  }

  function abrirEdicao(c: Conta) {
    setRascunho({ id: c.id, name: c.name, external_id: c.external_id ?? "", status: c.status });
  }

  async function salvar() {
    if (!rascunho) return;
    if (rascunho.name.trim() === "") {
      toast.error(t("O nome da conta é obrigatório."));
      return;
    }
    setSalvando(true);
    try {
      const corpo = {
        name: rascunho.name.trim(),
        external_id: rascunho.external_id.trim() === "" ? null : rascunho.external_id.trim(),
        status: rascunho.status,
      };
      if (rascunho.id === null) {
        await apiClient.post("/api/v1/accounts", corpo);
        toast.success(t("Conta cadastrada"));
      } else {
        await apiClient.patch(`/api/v1/accounts/${rascunho.id}`, corpo);
        toast.success(t("Conta atualizada"));
      }
      setRascunho(null);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarStatus(c: Conta, status: StatusDaConta) {
    try {
      await apiClient.patch(`/api/v1/accounts/${c.id}`, { status });
      toast.success(t(rotuloDoStatus(status, t)));
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-contas">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      <div className="mb-4 flex items-center gap-3">
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar por nome ou referência externa")}
          className="h-9 w-full max-w-sm rounded-md border px-3 text-sm"
          data-testid="busca-conta"
        />
        {podeEditar ? (
          <Button onClick={() => (rascunho && rascunho.id === null ? setRascunho(null) : abrirNova())} data-testid="nova-conta">
            {t(rascunho && rascunho.id === null ? "Cancelar" : "Nova conta")}
          </Button>
        ) : null}
      </div>

      {rascunho && podeEditar ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-conta">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              {t("Nome da empresa")}
              <input
                value={rascunho.name}
                onChange={(e) => setRascunho({ ...rascunho, name: e.target.value })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="conta-nome"
              />
            </label>
            <label className="text-sm">
              {t("Referência externa")} <span className="text-muted-foreground">{t("(opcional)")}</span>
              <input
                value={rascunho.external_id}
                onChange={(e) => setRascunho({ ...rascunho, external_id: e.target.value })}
                placeholder="ERP-42"
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="conta-external-id"
              />
              <span className="mt-1 block text-xs text-muted-foreground">
                {t("O identificador que o ERP ou a planilha usa para esta conta. Não pode repetir.")}
              </span>
            </label>
            <label className="text-sm">
              {t("Situação")}
              <select
                value={rascunho.status}
                onChange={(e) => setRascunho({ ...rascunho, status: e.target.value as StatusDaConta })}
                className="mt-1 h-9 w-full rounded-md border px-3"
                data-testid="conta-status"
              >
                {CONTAS_STATUS.map((s) => (
                  <option key={s} value={s}>
                    {rotuloDoStatus(s, t)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-4">
            <Button onClick={salvar} disabled={salvando} data-testid="salvar-conta">
              {t(salvando ? "Salvando…" : rascunho.id === null ? "Salvar conta" : "Salvar alterações")}
            </Button>
          </div>
        </div>
      ) : null}

      {filtradas.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="contas-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-contas">
          {filtradas.map((c) => (
            <li key={c.id} className="flex items-center gap-4 p-3" data-testid={`conta-${c.id}`}>
              <div className="min-w-0 flex-1">
                <p className={`truncate font-medium ${c.status === "archived" ? "text-muted-foreground" : ""}`}>
                  {c.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {c.external_id ? `${c.external_id} · ` : ""}
                  {rotuloDoStatus(c.status, t)}
                </p>
              </div>
              {podeEditar ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => abrirEdicao(c)}
                    data-testid={`editar-${c.id}`}
                  >
                    {t("Editar")}
                  </Button>
                  {c.status !== "archived" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void alternarStatus(c, "archived")}
                      data-testid={`arquivar-${c.id}`}
                    >
                      {t("Arquivar")}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void alternarStatus(c, "active")}
                      data-testid={`reativar-${c.id}`}
                    >
                      {t("Reativar")}
                    </Button>
                  )}
                </>
              ) : null}
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${CLASSE_DO_STATUS[c.status]}`}>
                {rotuloDoStatus(c.status, t)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
