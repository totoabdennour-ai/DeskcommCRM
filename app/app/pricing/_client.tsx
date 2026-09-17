"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api/client";
import { formatCents } from "@/lib/money";
import { precoParaCentavos } from "@/lib/schemas/produtos";
import type { ListaDePreco } from "@/lib/schemas/precos";

interface Textos {
  titulo: string;
  subtitulo: string;
  vazio: string;
  vazioDica: string;
}

interface ItemDaLista {
  id: string;
  product_id: string;
  preco_cents: number;
  catalog_products: { codigo: string; nome: string; ativo: boolean } | null;
}

interface ResultadoDaBusca {
  id: string;
  codigo: string;
  nome: string;
  preco_cents: number;
  moeda: string;
  ativo: boolean;
}

export function PrecosClient({
  inicial,
  podeEditar,
  textos,
}: {
  inicial: ListaDePreco[];
  podeEditar: boolean;
  textos: Textos;
}) {
  const t = useT();
  const router = useRouter();
  const [selecionada, setSelecionada] = React.useState<ListaDePreco | null>(null);
  const [itens, setItens] = React.useState<ItemDaLista[]>([]);
  const [criandoLista, setCriandoLista] = React.useState(false);
  const [nomeDaLista, setNomeDaLista] = React.useState("");
  const [buscaProduto, setBuscaProduto] = React.useState("");
  const [achados, setAchados] = React.useState<ResultadoDaBusca[]>([]);
  const [precosRascunho, setPrecosRascunho] = React.useState<Record<string, string>>({});
  const [salvando, setSalvando] = React.useState(false);

  // Os itens da lista selecionada entram quando ela muda — nunca no corpo
  // síncrono do effect (mesma regra do diálogo de contato).
  React.useEffect(() => {
    if (!selecionada) {
      setItens([]);
      return;
    }
    let ativo = true;
    const carregar = async () => {
      try {
        const lista = await apiClient.get<ItemDaLista[]>(
          `/api/v1/price-lists/${selecionada.id}/items`,
        );
        if (ativo) setItens(lista ?? []);
      } catch {
        if (ativo) setItens([]);
      }
    };
    void carregar();
    return () => {
      ativo = false;
    };
  }, [selecionada]);

  async function criarLista() {
    if (nomeDaLista.trim() === "") {
      toast.error(t("O nome da lista é obrigatório."));
      return;
    }
    setSalvando(true);
    try {
      const criada = await apiClient.post<ListaDePreco>("/api/v1/price-lists", {
        nome: nomeDaLista.trim(),
      });
      toast.success(t("Lista criada"));
      setCriandoLista(false);
      setNomeDaLista("");
      setSelecionada(criada);
      router.refresh();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  async function alternarStatus(l: ListaDePreco) {
    try {
      await apiClient.patch(`/api/v1/price-lists/${l.id}`, {
        status: l.status === "active" ? "inactive" : "active",
      });
      toast.success(t(l.status === "active" ? "Lista desativada" : "Lista ativada"));
      setSelecionada(null);
      router.refresh();
    } catch (e) {
      showApiError(e);
    }
  }

  // A busca de produto REUSA a rota do catálogo (nenhum modelo paralelo): o
  // que a tela de produtos lista é o mesmo universo que a lista de preço
  // sobrepõe. Debounce curto para não disparar a cada tecla.
  React.useEffect(() => {
    if (!selecionada || buscaProduto.trim().length < 2) {
      setAchados([]);
      return;
    }
    let ativo = true;
    const timer = setTimeout(async () => {
      try {
        const resultados = await apiClient.get<ResultadoDaBusca[]>(
          `/api/v1/products?busca=${encodeURIComponent(buscaProduto.trim())}`,
        );
        if (ativo) setAchados((resultados ?? []).slice(0, 8));
      } catch {
        if (ativo) setAchados([]);
      }
    }, 250);
    return () => {
      ativo = false;
      clearTimeout(timer);
    };
  }, [buscaProduto, selecionada]);

  async function definirPreco(p: ResultadoDaBusca) {
    if (!selecionada) return;
    const bruto = precosRascunho[p.id] ?? "";
    const preco_cents = precoParaCentavos(bruto);
    if (preco_cents === null) {
      toast.error(t("Preço inválido. Escreva assim: 5.499,00"));
      return;
    }
    setSalvando(true);
    try {
      await apiClient.put(`/api/v1/price-lists/${selecionada.id}/items`, {
        product_id: p.id,
        preco_cents,
      });
      toast.success(t("Preço gravado na lista"));
      setPrecosRascunho((r) => ({ ...r, [p.id]: "" }));
      setBuscaProduto("");
      setAchados([]);
      const lista = await apiClient.get<ItemDaLista[]>(
        `/api/v1/price-lists/${selecionada.id}/items`,
      );
      setItens(lista ?? []);
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  async function removerPreco(i: ItemDaLista) {
    if (!selecionada) return;
    try {
      await apiClient.delete(`/api/v1/price-lists/${selecionada.id}/items/${i.product_id}`);
      toast.success(t("Produto voltou ao preço do catálogo"));
      setItens((atuais) => atuais.filter((x) => x.id !== i.id));
    } catch (e) {
      showApiError(e);
    }
  }

  const rotuloDoStatus = (s: ListaDePreco["status"]) =>
    s === "active" ? t("Ativa") : t("Inativa");

  return (
    <div className="mx-auto w-full max-w-5xl p-6" data-testid="tela-precos">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{textos.titulo}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{textos.subtitulo}</p>
      </header>

      <div className="mb-4 flex items-center gap-3">
        {podeEditar ? (
          <Button
            onClick={() => {
              setCriandoLista((v) => !v);
              setSelecionada(null);
            }}
            data-testid="nova-lista"
          >
            {t(criandoLista ? "Cancelar" : "Nova lista de preço")}
          </Button>
        ) : null}
      </div>

      {criandoLista && podeEditar ? (
        <div className="mb-6 rounded-lg border p-4" data-testid="form-lista">
          <label className="text-sm">
            {t("Nome da lista")}
            <input
              value={nomeDaLista}
              onChange={(e) => setNomeDaLista(e.target.value)}
              placeholder={t("Ex.: Conta Distribuidora Central — 2026")}
              className="mt-1 h-9 w-full max-w-sm rounded-md border px-3"
              data-testid="lista-nome"
            />
          </label>
          <div className="mt-3">
            <Button onClick={criarLista} disabled={salvando} data-testid="salvar-lista">
              {t(salvando ? "Salvando…" : "Criar lista")}
            </Button>
          </div>
        </div>
      ) : null}

      {inicial.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center" data-testid="precos-vazio">
          <p className="font-medium">{textos.vazio}</p>
          <p className="mt-1 text-sm text-muted-foreground">{textos.vazioDica}</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border" data-testid="lista-de-listas">
          {inicial.map((l) => (
            <li key={l.id} className="flex items-center gap-4 p-3" data-testid={`lista-${l.id}`}>
              <div className="min-w-0 flex-1">
                <button
                  className="truncate font-medium underline-offset-2 hover:underline"
                  onClick={() => setSelecionada(l)}
                >
                  {l.nome}
                </button>
                <p className="text-xs text-muted-foreground">
                  {l.moeda} · {rotuloDoStatus(l.status)}
                </p>
              </div>
              {podeEditar ? (
                <Button variant="ghost" size="sm" onClick={() => void alternarStatus(l)}>
                  {t(l.status === "active" ? "Desativar" : "Ativar")}
                </Button>
              ) : null}
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                  l.status === "active"
                    ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {rotuloDoStatus(l.status)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {selecionada ? (
        <div className="mt-8 rounded-lg border p-4" data-testid="painel-itens">
          <h2 className="text-lg font-semibold">
            {selecionada.nome} <span className="text-sm text-muted-foreground">({selecionada.moeda})</span>
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Preço na lista vence o preço do catálogo. Produto fora da lista usa o catálogo.")}
          </p>

          {itens.length > 0 ? (
            <ul className="mt-4 divide-y rounded-md border" data-testid="itens-da-lista">
              {itens.map((i) => (
                <li key={i.id} className="flex items-center gap-4 p-3">
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm font-medium ${i.catalog_products?.ativo === false ? "text-muted-foreground" : ""}`}>
                      {i.catalog_products?.nome ?? t("(produto removido)")}
                    </p>
                    <p className="text-xs text-muted-foreground">{i.catalog_products?.codigo}</p>
                  </div>
                  <span className="shrink-0 tabular-nums text-sm font-medium">
                    {formatCents(i.preco_cents, selecionada.moeda)}
                  </span>
                  {podeEditar ? (
                    <Button variant="ghost" size="sm" onClick={() => void removerPreco(i)}>
                      {t("Remover da lista")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              {t("Nenhum preço especial nesta lista — tudo vale o catálogo.")}
            </p>
          )}

          {podeEditar ? (
            <div className="mt-6 border-t pt-4">
              <label className="text-sm font-medium">
                {t("Definir preço de um produto")}
                <input
                  value={buscaProduto}
                  onChange={(e) => setBuscaProduto(e.target.value)}
                  placeholder={t("Buscar produto por nome ou código")}
                  className="mt-1 h-9 w-full max-w-sm rounded-md border px-3 text-sm"
                  data-testid="busca-produto-lista"
                />
              </label>
              {achados.length > 0 ? (
                <ul className="mt-3 divide-y rounded-md border">
                  {achados.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 p-3" data-testid={`achado-${p.codigo}`}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{p.nome}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.codigo} · {t("catálogo")}: {formatCents(p.preco_cents, p.moeda)}
                        </p>
                      </div>
                      <input
                        value={precosRascunho[p.id] ?? ""}
                        onChange={(e) => setPrecosRascunho((r) => ({ ...r, [p.id]: e.target.value }))}
                        placeholder="5.499,00"
                        className="h-9 w-40 rounded-md border px-3 text-sm"
                        data-testid={`preco-${p.codigo}`}
                      />
                      <Button size="sm" disabled={salvando} onClick={() => void definirPreco(p)}>
                        {t(salvando ? "Salvando…" : "Gravar preço")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
