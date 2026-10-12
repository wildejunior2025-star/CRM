-- GORJETA AO FECHAR A CONTA (11/10/2026)
--
-- Conta de R$ 98,67 paga com R$ 50 no PIX + R$ 50 no crédito: entraram R$ 100
-- e o cliente mandou ficar com o troco. Não dava pra fechar — a tela travava o
-- botão em "Passou R$ 1,33" e o banco ainda derrubava com "a conta mudou depois
-- que foi fechada". O atendente só conseguia lançar R$ 98,67, e aí a maquininha
-- e o extrato do PIX mostravam R$ 100 contra R$ 98,67 no caixa: o dia não fecha.
--
-- A gorjeta entra como TAXA DE SERVIÇO lançada na mão. É o balde certo: já é
-- dinheiro que entra no total e no caixa sem ser venda de produto, e é de onde
-- sai o bolo dos garçons (rateio_taxa_pct) — loja que repassa a taxa passa a
-- gorjeta junto, sem precisar de mais nada. Vale mesmo com a taxa percentual
-- desligada, que é o caso de quem não cobra os 10%.
--
-- CUIDADO AO MEXER: `p_gorjeta` entrou com DEFAULT 0 nas duas funções, e as
-- versões antigas (4 args na pública, 5 na interna) foram DERRUBADAS. Sem
-- derrubar, o Postgres cria uma irmã em vez de substituir e a chamada antiga
-- vira "function is not unique". `confirmar_pix_comanda` chama a interna com
-- 5 argumentos e continua valendo pelo default.
--
-- O que NÃO mudou: sem gorjeta, pagar a mais continua sendo erro. A trava só
-- abre quando alguém da loja diz, na tela, que a sobra foi gorjeta.

create or replace function public.fechar_conta_presencial(
  p_comanda_id   uuid,
  p_pagamentos   jsonb,
  p_aplicar_taxa boolean default true,
  p_cliente_id   uuid default null,
  p_gorjeta      numeric default 0
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  return fechar_conta_presencial_interno(
    p_comanda_id, p_pagamentos, p_aplicar_taxa, p_cliente_id, current_empresa_id(), p_gorjeta);
end;
$$;

grant execute on function public.fechar_conta_presencial(uuid, jsonb, boolean, uuid, numeric) to authenticated;

-- A interna foi reescrita a partir dela mesma (pg_get_functiondef), trocando
-- só a assinatura e a linha da taxa, pra não arriscar erro de transcrição nas
-- ~200 linhas dela. O efeito foi este:
--
--   v_taxa := (CASE WHEN p_aplicar_taxa THEN ROUND(v_base * v_taxa_pct/100.0, 2) ELSE 0 END)
--             + GREATEST(COALESCE(ROUND(p_gorjeta, 2), 0), 0);
--
-- O resto segue igual: v_total = v_subtotal + v_taxa, e é esse total que a
-- conferência dos pagamentos usa.
