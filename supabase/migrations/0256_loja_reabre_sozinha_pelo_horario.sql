-- =========================================================
-- Migration 0256 - A loja volta sozinha depois do intervalo do almoço
-- =========================================================
-- O painel FECHA a loja sozinha quando sai do horário da grade (grava
-- delivery_ativo=false), mas nunca ABRE de volta. Numa grade com intervalo
-- (CD Bom: 08:30-12:00 e 14:00-18:00) a loja fechava ao meio-dia e ficava
-- fechada no cardápio online mesmo depois das 14:00, com o lojista jurando que
-- estava aberta — o botão do painel dizia "aberta" porque quem apagou foi outro
-- aparelho. Aconteceu em 10/09/2026, entre 14:00 e 14:55.
--
-- Guardar POR QUE fechou resolve: fechou por horário, a grade manda de novo
-- quando o horário volta. Fechou na mão (acabou o produto, cozinha lotada),
-- ninguém reabre por trás — a decisão é da loja.
-- =========================================================
alter table empresas
  add column if not exists delivery_fechado_por text;

alter table empresas drop constraint if exists empresas_delivery_fechado_por_ck;
alter table empresas add constraint empresas_delivery_fechado_por_ck
  check (delivery_fechado_por is null or delivery_fechado_por in ('horario', 'manual'));

comment on column empresas.delivery_fechado_por is
  'Por que o delivery está desligado: horario = o painel fechou sozinho pela grade (reabre sozinho); manual = a loja fechou na mão (só ela reabre). null = aberta (mig 0256).';

-- Quem está fechado agora e não tem motivo gravado: assume manual, que é o
-- comportamento de hoje. Ninguém é reaberto por surpresa nesta migração.
update empresas
   set delivery_fechado_por = 'manual'
 where delivery_ativo = false and delivery_fechado_por is null;
