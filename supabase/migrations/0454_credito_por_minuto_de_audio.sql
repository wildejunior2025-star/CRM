-- ─────────────────────────────────────────────────────────────────────────────
-- 0454 — Entender áudio passa a custar crédito: 1 por minuto começado
--
-- Transcrever é a ÚNICA coisa do robô SEM IA que sai do nosso bolso. O Whisper
-- cobra por minuto de áudio, e até hoje isso era por nossa conta: a tela dizia
-- "por enquanto é por nossa conta, sem custo pra loja".
--
-- Em 14 dias foram 772 áudios nas oito lojas — CDBom 291, DayCakes 189, CL
-- Pescados 160. Deixou de ser detalhe.
--
-- POR QUE POR MINUTO E NÃO POR ÁUDIO: o crédito custa R$ 0,07 pra loja e o
-- Whisper custa ~R$ 0,032 por minuto. Cobrando 1 por áudio, o recado de 25
-- segundos dá 5x de margem — mas o desabafo de 4 minutos empata, e o de 10
-- minutos a gente paga pra ouvir. Por minuto começado, nunca sai do nosso
-- bolso e o áudio normal (20 a 30 s) continua custando 1 crédito.
--
-- Sem saldo não transcreve: a loja cai na fala que já existe ("ainda não
-- consigo ouvir áudio, me escreve"). Nada de transcrever fiado.
--
-- A duração sai do próprio Whisper (response_format=verbose_json), no mesmo
-- pedido e sem pagar nada a mais.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.descontar_creditos_bot(
  p_empresa_id uuid, p_quantidade integer, p_origem text default null
) returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_qtd integer := greatest(1, coalesce(p_quantidade, 1));
  v_saldo integer;
  v_tirar integer;
begin
  -- FOR UPDATE: dois áudios do mesmo cliente chegam em chamadas diferentes e
  -- leriam o mesmo saldo. Sem a trava, um dos descontos se perdia.
  select whatsapp_creditos into v_saldo from empresas where id = p_empresa_id for update;
  if v_saldo is null or v_saldo <= 0 then return 0; end if;

  -- Nunca negativo: quem tem 2 e mandou um áudio de 4 minutos paga 2 e zera.
  v_tirar := least(v_qtd, v_saldo);

  update empresas set whatsapp_creditos = whatsapp_creditos - v_tirar
  where id = p_empresa_id;

  insert into whatsapp_credito_historico (empresa_id, tipo, creditos, descricao)
  values (p_empresa_id, 'consumo', -v_tirar,
          coalesce(nullif(btrim(p_origem), ''), 'Consumo do bot'));

  return v_tirar;
end;
$$;

revoke all on function public.descontar_creditos_bot(uuid, integer, text) from public;
revoke execute on function public.descontar_creditos_bot(uuid, integer, text) from anon, authenticated;
grant execute on function public.descontar_creditos_bot(uuid, integer, text) to service_role;

comment on function public.descontar_creditos_bot(uuid, integer, text) is
  'Desconta N creditos de uma vez (audio cobra 1 por minuto comecado). Devolve quantos saiu de verdade.';
