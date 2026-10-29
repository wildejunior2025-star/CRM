-- O extrato de crédito tem que dizer QUEM gastou.
--
-- A Agv perguntou onde foram 500 créditos e não deu pra responder: as 401
-- cobranças estavam todas escritas "Resposta do bot", do robô que conversa com
-- cliente à mensagem disparada do painel. Em 25 e 26/10/2026 saíram 155
-- créditos sem UMA mensagem no banco e não há como saber de onde — o log de
-- edge function só guarda 24 horas e o extrato não guarda nada.
--
-- Agora cada cobrança escreve de onde veio. Quem chama diz; quem não disser
-- cai em "Resposta do bot (origem não informada)", que também é uma resposta:
-- aponta o caminho que ficou sem etiqueta.

create or replace function public.descontar_credito_bot(
  p_empresa_id uuid,
  p_origem text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update empresas
  set whatsapp_creditos = greatest(0, whatsapp_creditos - 1)
  where id = p_empresa_id and whatsapp_creditos > 0;

  insert into whatsapp_credito_historico (empresa_id, tipo, creditos, descricao)
  values (
    p_empresa_id, 'consumo', -1,
    coalesce(nullif(btrim(p_origem), ''), 'Resposta do bot (origem não informada)')
  );
end;
$$;

-- A função antiga continua existindo porque pode ter chamador que eu não
-- enxergo daqui (script, painel antigo, função de outra pessoa). Ela passa a
-- ser só uma casca da nova, e a etiqueta dela já denuncia que é chamada velha.
create or replace function public.descontar_credito_whatsapp(p_empresa_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.descontar_credito_bot(p_empresa_id, 'Resposta do bot (chamada antiga)');
end;
$$;

grant execute on function public.descontar_credito_bot(uuid, text) to service_role;
