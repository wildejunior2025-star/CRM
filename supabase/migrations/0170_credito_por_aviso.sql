-- =========================================================
-- CRM FWC Inter — Migration 0170
-- Cobrar crédito pelos avisos automáticos de pedido
-- (confirmado / saiu para entrega / entregue / cancelado)
--
-- Até aqui só a conversa do robô descontava crédito; os avisos de status
-- saíam de graça — e são o maior volume (10.113 avisos só na Zebu entre
-- 02/07 e 19/08). Quando a loja migra pro cano oficial da Meta, cada um
-- desses vira template de utilidade cobrado, então precisam ser medidos.
--
-- Overload com descrição: a versão de 1 argumento continua valendo pro robô,
-- então nada do que já existe quebra.
-- =========================================================

create or replace function descontar_credito_whatsapp(p_empresa_id uuid, p_descricao text)
returns void language plpgsql security definer as $$
begin
  update empresas
  set whatsapp_creditos = whatsapp_creditos - 1
  where id = p_empresa_id and whatsapp_creditos > 0;

  if not found then
    raise exception 'Créditos insuficientes';
  end if;

  insert into whatsapp_creditos_log (empresa_id, tipo, quantidade, descricao)
  values (p_empresa_id, 'debito', 1, coalesce(nullif(p_descricao, ''), 'Mensagem WhatsApp enviada'));
end;
$$;
