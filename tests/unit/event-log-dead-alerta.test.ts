import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EVENTO MORRE AVISANDO — Fase 1 (docs/our-product/07 §2): `status='dead'`
 * era um terminal MUDO no event_log (o job_queue abre item crítico há muito;
 * o barramento genérico não). O guard trava o comportamento nas duas direções:
 * dead ABRE item na Central (um por organização), falha intermediária e
 * sucesso NÃO abrem; e falha de write do aviso não derruba o drain.
 */

const { dispatchEvent } = vi.hoisted(() => ({ dispatchEvent: vi.fn() }));

vi.mock("@/lib/event-log/dispatcher", () => ({
  getRegisteredHandlers: () => [{ events: ["teste.evt"], consumer_key: "teste.v1" }],
  dispatchEvent: (...args: unknown[]) => dispatchEvent(...args),
}));

const { drainEventLog } = await import("@/lib/event-log/drain");

type Row = {
  id: string;
  organization_id: string;
  event_type: string;
  consumed_by: string[];
  attempts: number;
};

/**
 * Falso supabase baseado em FILA: cada `await` de uma chain de event_log
 * consome a próxima resposta da fila (na ordem exata do drain: reaper →
 * select de pendentes → [claim, update de status] por linha). Inserts em
 * agent_inbox_items são capturados, nunca consumidos da fila.
 */
function falsoAdmin(rows: Row[], insertErr: { message: string } | null = null) {
  const inserts: Record<string, unknown>[] = [];
  const porRodada = rows.length;
  const fila: { data: unknown }[] = [
    { data: [] }, // reaper: nada órfão
    { data: rows }, // select de pendentes
  ];
  for (let i = 0; i < porRodada; i++) {
    fila.push({ data: [{ id: rows[i]!.id }] }); // claim vencido
    fila.push({ data: [] }); // update de status final
  }

  const chain = () => {
    const c: Record<string, unknown> = {
      update: () => c,
      select: () => c,
      eq: () => c,
      lt: () => c,
      or: () => c,
      in: () => c,
      order: () => c,
      limit: () => c,
      insert(linha: Record<string, unknown>) {
        inserts.push(linha);
        return {
          then: (res: (r: { error: { message: string } | null }) => void) => res({ error: insertErr }),
        };
      },
      then: (res: (r: { data: unknown }) => void, rej: (e: unknown) => void) => {
        const proxima = fila.shift();
        if (!proxima) return rej(new Error("fila de respostas esgotou — fluxo do drain mudou"));
        res(proxima);
      },
    };
    return c;
  };

  return {
    admin: {
      from: (tabela: string) => {
        if (tabela === "agent_inbox_items") return chain();
        return chain();
      },
    },
    inserts,
  } as unknown as { admin: Parameters<typeof drainEventLog>[0]; inserts: Record<string, unknown>[] };
}

const linha = (over: Partial<Row> = {}): Row => ({
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-0000000000aa",
  event_type: "teste.evt",
  consumed_by: [],
  attempts: 0,
  ...over,
});

describe("drain — dead-letter abre aviso na Central (Fase 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evento que atinge MAX_ATTEMPTS abre item `event_dead` crítico na org", async () => {
    dispatchEvent.mockResolvedValue([{ consumer_key: "teste.v1", status: "error", detail: "boom" }]);
    const { admin, inserts } = falsoAdmin([linha({ attempts: 4 })]);

    const resumo = await drainEventLog(admin);

    expect(resumo.dead).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      organization_id: "00000000-0000-4000-8000-0000000000aa",
      kind: "event_dead",
      severity: "critical",
      ref_kind: "event_log",
      ref_id: "00000000-0000-4000-8000-000000000001",
    });
    expect(String(inserts[0]!.body)).toContain("teste.evt");
    expect(String(inserts[0]!.body)).toContain("NÃO serão reprocessados");
  });

  it("um item POR organização por rodada, com títulos por contagem", async () => {
    dispatchEvent.mockResolvedValue([{ consumer_key: "teste.v1", status: "error", detail: "x" }]);
    const orgA = "00000000-0000-4000-8000-0000000000aa";
    const orgB = "00000000-0000-4000-8000-0000000000bb";
    const { admin, inserts } = falsoAdmin([
      linha({ id: "00000000-0000-4000-8000-000000000001", organization_id: orgA, attempts: 4 }),
      linha({ id: "00000000-0000-4000-8000-000000000002", organization_id: orgA, attempts: 4 }),
      linha({ id: "00000000-0000-4000-8000-000000000003", organization_id: orgB, attempts: 4 }),
    ]);

    await drainEventLog(admin);

    expect(inserts).toHaveLength(2);
    const porOrg = new Map(inserts.map((i) => [i.organization_id, i]));
    expect(porOrg.size).toBe(2);
    expect(String(porOrg.get(orgA)!.title)).toContain("2 eventos");
    expect(String(porOrg.get(orgB)!.title)).toContain("Um evento");
  });

  it("falha INTERMEDIÁRIA (ainda com tentativas) NÃO abre aviso", async () => {
    dispatchEvent.mockResolvedValue([{ consumer_key: "teste.v1", status: "error", detail: "x" }]);
    const { admin, inserts } = falsoAdmin([linha({ attempts: 0 })]);

    const resumo = await drainEventLog(admin);

    expect(resumo.failed).toBe(1);
    expect(resumo.dead).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("sucesso NÃO abre aviso (quem não fez nada não alerta)", async () => {
    dispatchEvent.mockResolvedValue([{ consumer_key: "teste.v1", status: "ok" }]);
    const { admin, inserts } = falsoAdmin([linha()]);

    const resumo = await drainEventLog(admin);

    expect(resumo.done).toBe(1);
    expect(inserts).toHaveLength(0);
  });

  it("falha de write do aviso é engolida com log — o drain não quebra", async () => {
    dispatchEvent.mockResolvedValue([{ consumer_key: "teste.v1", status: "error", detail: "x" }]);
    const { admin, inserts } = falsoAdmin([linha({ attempts: 4 })], {
      message: "simulated storage down",
    });

    const resumo = await drainEventLog(admin);

    expect(resumo.dead).toBe(1);
    expect(inserts).toHaveLength(1);
  });
});
