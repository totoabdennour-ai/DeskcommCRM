/**
 * Capacidades de COMÉRCIO e PRIVACIDADE — o que o cliente comprou, o que existe
 * à venda, e quem pediu para sair.
 *
 * Ver `docs/handoffs/BRIEFING-ia-360.md` §4 para o contrato dos campos.
 */
import { declararTools } from "./tipos";

export const TOOLS_COMERCIO = declararTools([
  {
    name: "crm_list_contact_orders",
    category: "read",
    rotulo: "Ver as compras do cliente",
    explicacao:
      "Mostra o que este cliente já comprou, quanto pagou e como está a entrega, para o assistente não prometer prazo no escuro nem repetir uma oferta já aceita.",
    oQueToca: "Compras do cliente",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_search_products",
    category: "read",
    rotulo: "Procurar produto na loja",
    explicacao:
      "Procura um produto no catálogo da loja e devolve o preço exato e o que está disponível, para o assistente responder com o valor cadastrado em vez de estimar.",
    oQueToca: "Catálogo da loja",
    risco: "seguro",
    pacotes: ["vender", "atender"],
  },
  {
    name: "crm_create_order",
    category: "write",
    rotulo: "Montar rascunho de pedido B2B",
    explicacao:
      "Monta o RASCUNHO de um pedido para a conta do cliente, com o preço resolvido pelo sistema para cada linha (lista de preço da conta vence o catálogo). Rascunho não é pedido fechado: um humano com papel de manager confirma. O assistente não inventa preço — se uma linha não tiver preço, ele explica o motivo.",
    oQueToca: "Pedidos B2B (rascunho)",
    risco: "atencao",
    // Pacote de jornada PRÓPRIO ("pedidos"): tool de dinheiro não entra por
    // default no agente de atendimento — o operador liga o pacote B2B quando
    // quer, e o gate de capacidade (pacote-reserva-vaga) segue honesto: o
    // pacote exige só 2 vagas novas depois do onboarding.
    pacotes: ["pedidos"],
  },
  {
    name: "crm_get_order",
    category: "read",
    rotulo: "Ver um pedido B2B",
    explicacao:
      "Mostra o estado de um pedido (rascunho, confirmado, cancelado), o total e o preço congelado de cada linha, para o assistente conferir o que já existe antes de prometer mudança.",
    oQueToca: "Pedidos B2B (consulta)",
    risco: "seguro",
    pacotes: ["pedidos"],
  },
  {
    name: "crm_get_order_context",
    category: "read",
    rotulo: "Ver a conta e o rascunho do cliente",
    explicacao:
      "Diz a qual empresa o contato pertence, qual a lista de preço dela e se já existe rascunho de pedido aberto — para o assistente continuar um pedido em vez de criar outro.",
    oQueToca: "Pedidos B2B (contexto)",
    risco: "seguro",
    pacotes: ["pedidos"],
  },
  {
    name: "crm_update_order_draft",
    category: "write",
    rotulo: "Atualizar rascunho de pedido B2B",
    explicacao:
      "Muda as linhas de um rascunho de pedido já aberto (só rascunho — confirmado nunca se edita por aqui). O preço de cada linha é resolvido de novo pelo sistema; se uma linha ficar sem preço, ele explica o motivo e escala se for o caso.",
    oQueToca: "Pedidos B2B (rascunho)",
    risco: "atencao",
    pacotes: ["pedidos"],
  },
  {
    name: "crm_list_privacy_requests",
    category: "read",
    rotulo: "Ver pedidos de privacidade",
    explicacao:
      "Mostra quem pediu para exportar ou apagar os próprios dados e qual o prazo, para o assistente parar de insistir com quem pediu para sair.",
    oQueToca: "Privacidade e dados do cliente",
    risco: "seguro",
    pacotes: ["organizar", "atender"],
  },
]);
