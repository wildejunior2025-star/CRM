-- Baixa de insumo POR VENDA nao pode avisar (23/10/2026)
--
-- O QUE EU TINHA DEIXADO ESCAPAR
-- A tabela `materia_prima_movimentos` NAO tem coluna `motivo`. Como o corte de
-- "nao avisar venda" era feito pelo motivo, toda saida de insumo passava — e a
-- ficha tecnica gera UMA saida por insumo A CADA VENDA. O Braseiro tem 125
-- saidas desse tipo e estava com o aviso ligado: ao abrir a loja, cada
-- hamburguer vendido viraria uma mensagem no zap do dono.
--
-- Nessa tabela a saida da venda se identifica pela observacao, que a ficha
-- tecnica grava como "Venda no salao · <id>". E por ela que o corte passa.
--
-- Hoje sao 125 saidas comecando com "Venda" contra 4 com "Consumo" (baixa de
-- verdade) — ou seja, sem este corte o aviso seria 97% ruido.

drop function if exists public.estoque_mov_avisavel(text, text);

create or replace function public.estoque_mov_avisavel(
  p_tipo text, p_motivo text, p_observacao text default null)
returns boolean
language sql
immutable
as $$
  select p_tipo = 'entrada'
      or (p_tipo = 'saida'
          and coalesce(p_motivo, '') <> 'venda'               -- produto do catalogo
          and coalesce(p_observacao, '') not ilike 'Venda%')  -- insumo da ficha tecnica
$$;

-- O indice parcial acompanha a regra.
drop index if exists public.mp_mov_baixa_a_avisar;
create index mp_mov_baixa_a_avisar
  on public.materia_prima_movimentos (empresa_id, created_at)
  where tipo = 'saida' and avisado_em is null
    and coalesce(observacao, '') not ilike 'Venda%';

-- ── o gatilho ───────────────────────────────────────────────────────────────
-- BUG QUE O ENSAIO PEGOU, e era o pior de todos:
--
--   v_motivo := case when tg_table_name = 'estoque_movimentos'
--                    then new.motivo else null end;
--
-- Isso parece seguro e nao e. O plpgsql resolve `new.motivo` na COMPILACAO,
-- nao no ramo escolhido, entao estourava "record new has no field motivo" em
-- TODO insert na tabela de insumo. E o gatilho roda dentro da transacao de
-- quem inseriu: a baixa automatica da venda pela ficha tecnica passaria a
-- FALHAR. Um aviso teria derrubado a venda.
--
-- `to_jsonb(new) ->> 'motivo'` le o campo quando ele existe e devolve null
-- quando nao existe, sem olhar o formato da tabela.
create or replace function public.estoque_entrada_dispara()
returns trigger
language plpgsql
security definer
set search_path = public
as $dispara$
declare
  ja_esperando boolean;
  v_motivo text;
begin
  v_motivo := to_jsonb(new) ->> 'motivo';

  if not estoque_mov_avisavel(new.tipo, v_motivo, new.observacao)
     or new.avisado_em is not null then
    return new;
  end if;

  -- Toca so quem for a PRIMEIRA pendente da loja; as outras vao junto na mesma
  -- mensagem. Ver mig 0371 pro bug que isso corrige (INSERT de varias linhas).
  select exists (
    select 1 from estoque_movimentos x
     where x.empresa_id = new.empresa_id
       and estoque_mov_avisavel(x.tipo, x.motivo, x.observacao) and x.avisado_em is null
       and (x.created_at, x.id) < (new.created_at, new.id)
       and x.created_at > now() - interval '2 minutes'
  ) or exists (
    select 1 from materia_prima_movimentos x
     where x.empresa_id = new.empresa_id
       and estoque_mov_avisavel(x.tipo, null, x.observacao) and x.avisado_em is null
       and (x.created_at, x.id) < (new.created_at, new.id)
       and x.created_at > now() - interval '2 minutes'
  ) into ja_esperando;

  if ja_esperando then return new; end if;

  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/estoque-entrada-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := '{"esperar": 45}'::jsonb,
      timeout_milliseconds := 90000
    );
  exception when others then
    raise warning '[estoque-entrada] nao consegui tocar a campainha: %', sqlerrm;
  end;

  return new;
end;
$dispara$;

revoke all on function public.estoque_entrada_dispara() from public, anon, authenticated;

-- As duas funcoes que leem a fila passam a mandar a observacao do insumo
-- junto; a chamada do produto continua com 2 argumentos (o 3o tem default).
-- Corpo vigente no banco; ver mig 0373 pra versao completa de
-- `estoque_avisos_monta` e `estoque_entrada_avisos`, que so mudaram a chamada
-- `estoque_mov_avisavel(m.tipo, null)` -> `(m.tipo, null, m.observacao)`.
