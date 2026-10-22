-- 0362 — DOIS ROBÔS NO WHATSAPP, UM GRUPO PARA CADA
--
-- Robô ASSISTENTE (operador): estoque e cadastros. Ativado com "ativar assistente" num grupo
--   (grava em whatsapp_config.estoque_grupo_jid). Desconta dos CRÉDITOS (empresas.whatsapp_creditos).
-- Robô ANALISTA: perguntas, diagnóstico e decisões do dono (preço, taxa). Ativado com
--   "ativar analista" (whatsapp_config.analista_grupo_jid). Desconta do SALDO DA IA em reais.
-- Separados de propósito: o grupo da equipe não pode perguntar "quanto vendi / qual o lucro".

alter table whatsapp_config add column if not exists analista_grupo_jid text;
alter table assistente_conversas add column if not exists creditos_cobrados integer not null default 0;

-- Debita N créditos de uma vez (a descontar_credito_whatsapp só tira 1).
create or replace function descontar_creditos_whatsapp(p_empresa_id uuid, p_qtd integer, p_descricao text)
returns integer language plpgsql security definer as $$
declare v_saldo integer;
begin
  update empresas set whatsapp_creditos = whatsapp_creditos - p_qtd
   where id = p_empresa_id and whatsapp_creditos >= p_qtd
   returning whatsapp_creditos into v_saldo;
  if not found then raise exception 'Créditos insuficientes'; end if;
  insert into whatsapp_creditos_log (empresa_id, tipo, quantidade, descricao)
  values (p_empresa_id, 'debito', p_qtd, p_descricao);
  return v_saldo;
end $$;
revoke all on function descontar_creditos_whatsapp(uuid, integer, text) from public, anon, authenticated;
