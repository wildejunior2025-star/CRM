-- =========================================================
-- Migration 0064 - Tempo de preparo estimado do pedido de delivery
-- =========================================================
-- Ao ACEITAR um pedido, a loja informa em quantos minutos ele fica pronto.
-- O cliente acompanha na própria tela ("fica pronto por volta de HH:MM"),
-- atualizado em tempo real.
--
--   tempo_preparo_min   -> minutos escolhidos pela loja (ex: 30)
--   pronto_previsto_at  -> horário-alvo (now() + minutos) no momento do aceite
-- Ambos opcionais: a loja pode aceitar sem estimativa.
-- =========================================================

alter table pedidos_delivery
  add column if not exists tempo_preparo_min  int,
  add column if not exists pronto_previsto_at timestamptz;
