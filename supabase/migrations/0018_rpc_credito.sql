-- =========================================================
-- CRM Depósito de Bebidas - Migration 0018
-- RPC atômica para descontar crédito WhatsApp
-- Usa UPDATE com condição + FOUND para evitar corrida
-- =========================================================

create or replace function descontar_credito_whatsapp(p_empresa_id uuid)
returns void language plpgsql security definer as $$
begin
  update empresas
  set whatsapp_creditos = whatsapp_creditos - 1
  where id = p_empresa_id and whatsapp_creditos > 0;

  if not found then
    raise exception 'Créditos insuficientes';
  end if;

  insert into whatsapp_creditos_log (empresa_id, tipo, quantidade, descricao)
  values (p_empresa_id, 'debito', 1, 'Mensagem WhatsApp enviada');
end;
$$;
