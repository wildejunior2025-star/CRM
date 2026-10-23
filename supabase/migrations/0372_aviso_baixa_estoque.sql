-- O aviso passa a cobrir a BAIXA tambem, nao so a entrada (23/10/2026)
--
-- POR QUE
-- O aviso nasceu pra entrada ("se o funcionario bota um a menos..."). Mas a
-- BAIXA e o buraco maior: na entrada, quem desvia precisa que a mercadoria
-- chegue a mais do que o lancado; na baixa, basta dizer "caiu e quebrou" e
-- levar o produto. A propria tela ja mostra "R$ 4,33 de prejuizo" e manda pro
-- Financeiro do dia — ou seja, a loja ASSUME a perda sem ninguem conferir.
--
-- VENDA NAO ENTRA
-- Saida de venda sao 3.502 registros; baixa de verdade sao 16. Avisar venda
-- transformaria o aviso em enxurrada e mataria o unico que importa. O corte e
-- pelo motivo: tudo que NAO for 'venda'.
--
-- UM INTERRUPTOR SO
-- Entrada e baixa sao a mesma pergunta do dono — "mexeram no meu estoque, quem
-- foi?". Dois interruptores so dariam a chance de deixar o mais importante
-- desligado sem perceber.

-- ── a fila agora olha os dois lados ──────────────────────────────────────────
-- Os indices de entrada continuam; estes cobrem a baixa. Parcial de novo, pra
-- nao carregar as 3.502 vendas.
create index if not exists estoque_mov_baixa_a_avisar
  on public.estoque_movimentos (empresa_id, created_at)
  where tipo = 'saida' and motivo is distinct from 'venda' and avisado_em is null;
create index if not exists mp_mov_baixa_a_avisar
  on public.materia_prima_movimentos (empresa_id, created_at)
  where tipo = 'saida' and avisado_em is null;

-- O passado fica como avisado: senao a primeira rodada despejaria 3.500 linhas.
update public.estoque_movimentos       set avisado_em = now() where avisado_em is null;
update public.materia_prima_movimentos set avisado_em = now() where avisado_em is null;

-- ── o que conta como "mexeu no estoque" ─────────────────────────────────────
-- Num lugar so, pra gatilho e mensagem nunca discordarem sobre o que avisar.
create or replace function public.estoque_mov_avisavel(p_tipo text, p_motivo text)
returns boolean
language sql
immutable
as $$
  select p_tipo = 'entrada'
      or (p_tipo = 'saida' and coalesce(p_motivo, '') <> 'venda')
$$;

-- ── a mensagem, num lugar so ────────────────────────────────────────────────
-- `estoque_avisos_monta()` e a unica dona do texto; a funcao que MARCA e a
-- previa chamam ela. Antes o corpo estava copiado nas duas, e duas copias da
-- mesma regra sempre acabam discordando.
--
-- Mudancas que o ensaio pediu:
--   . entrada antes de baixa (antes 'saida' vinha primeiro por ordem alfabetica)
--   . "tem X agora" no lugar de "ficou X": e o saldo ATUAL do item, nao o saldo
--     logo apos aquele movimento. Quando o mesmo produto teve entrada E baixa
--     no mesmo lote, "ficou" aparecia igual nas duas linhas e parecia erro.
--   . na baixa entram o motivo escrito pela pessoa e o prejuizo em reais — e
--     essa a historia que o dono vai querer conferir.
create or replace function public.estoque_avisos_monta()
returns jsonb
language sql
stable
security definer
set search_path = public
as $monta$
  with pendentes as (
    select m.id, m.empresa_id, m.created_by, m.created_at, m.tipo,
           p.nome as item, m.quantidade, ''::text as unidade,
           coalesce(m.motivo, '') as motivo,
           coalesce(m.observacao, '') as observacao,
           m.valor_total,
           (select coalesce(sum(case x.tipo when 'entrada' then x.quantidade
                                            when 'saida'   then -x.quantidade
                                            when 'ajuste'  then x.quantidade
                                            else 0 end), 0)
              from estoque_movimentos x where x.produto_id = m.produto_id) as saldo
      from estoque_movimentos m
      join produtos p on p.id = m.produto_id
     where estoque_mov_avisavel(m.tipo, m.motivo) and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
    union all
    select m.id, m.empresa_id, m.created_by, m.created_at, m.tipo,
           mp.nome, m.quantidade, coalesce(mp.unidade, ''),
           '', coalesce(m.observacao, ''), m.valor_total,
           (select coalesce(sum(case x.tipo when 'entrada' then x.quantidade
                                            when 'saida'   then -x.quantidade
                                            when 'ajuste'  then x.quantidade
                                            else 0 end), 0)
              from materia_prima_movimentos x where x.materia_prima_id = m.materia_prima_id)
      from materia_prima_movimentos m
      join materias_primas mp on mp.id = m.materia_prima_id
     where estoque_mov_avisavel(m.tipo, null) and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
  ),
  validas as (
    select pe.*, wc.admin_phone, e.nome as loja,
           -- Loja sem zap proprio conectado cai no numero da FWC (mig 0371).
           coalesce(nullif(trim(wc.instance_name), ''),
                    (select valor from config_global where chave = 'admin_sender_instance'),
                    'crmadmin') as instance_name
      from pendentes pe
      join whatsapp_config wc on wc.empresa_id = pe.empresa_id
      join empresas e on e.id = pe.empresa_id
     where wc.notif_entrada_estoque
       and coalesce(trim(wc.admin_phone), '') <> ''
  ),
  agrupado as (
    select v.empresa_id, v.created_by, v.admin_phone, v.instance_name, v.loja,
           max(v.created_at) as quando,
           bool_or(v.tipo = 'saida') as tem_baixa,
           string_agg(
             case when v.tipo = 'entrada' then U&'\2795' else U&'\2796' end || ' ' ||
             v.item ||
             case when v.tipo = 'entrada' then ' — entrou ' else ' — baixa de ' end ||
             num_br(v.quantidade) ||
             case when v.unidade <> '' then ' ' || v.unidade else '' end ||
             ', tem ' || num_br(v.saldo) || ' agora' ||
             case when v.tipo = 'saida' then
               coalesce(nullif(chr(10) || '   ' ||
                 nullif(concat_ws(' · ',
                   nullif(v.observacao, ''),
                   case when coalesce(v.valor_total, 0) > 0
                        then 'R$ ' || num_br(round(v.valor_total, 2)) || ' de prejuízo' end
                 ), ''), chr(10) || '   '), '')
             else '' end,
             chr(10) order by v.tipo, v.item   -- entrada antes de saida
           ) as lista
      from validas v
     group by v.empresa_id, v.created_by, v.admin_phone, v.instance_name, v.loja
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'loja', g.loja, 'empresa_id', g.empresa_id,
           'instancia', g.instance_name, 'telefone', g.admin_phone,
           'texto',
             case when g.tem_baixa then U&'\26A0\FE0F' || ' *Mexeram no estoque*'
                                   else U&'\+01F4E6' || ' *Entrada no estoque*' end
             || chr(10) || chr(10) ||
             'Quem lançou: *' || estoque_quem_lancou(g.created_by) || '*' || chr(10) ||
             'Quando: ' || to_char(g.quando at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
             chr(10) || chr(10) || g.lista
         )), '[]'::jsonb)
    from agrupado g
$monta$;

create or replace function public.estoque_entrada_avisos()
returns jsonb
language plpgsql
security definer
set search_path = public
as $avisos$
declare
  v_saida jsonb;
begin
  v_saida := estoque_avisos_monta();

  update estoque_movimentos m set avisado_em = now()
   where estoque_mov_avisavel(m.tipo, m.motivo) and m.avisado_em is null
     and m.created_at > now() - interval '2 days'
     and exists (select 1 from whatsapp_config wc
                  where wc.empresa_id = m.empresa_id and wc.notif_entrada_estoque
                    and coalesce(trim(wc.admin_phone), '') <> '');

  update materia_prima_movimentos m set avisado_em = now()
   where estoque_mov_avisavel(m.tipo, null) and m.avisado_em is null
     and m.created_at > now() - interval '2 days'
     and exists (select 1 from whatsapp_config wc
                  where wc.empresa_id = m.empresa_id and wc.notif_entrada_estoque
                    and coalesce(trim(wc.admin_phone), '') <> '');

  return v_saida;
end;
$avisos$;

create or replace function public.estoque_entrada_avisos_previa()
returns jsonb language sql stable security definer set search_path = public
as $previa$ select estoque_avisos_monta() $previa$;

-- ── o gatilho tambem toca pra baixa ─────────────────────────────────────────
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
  -- A tabela de insumo nao tem `motivo`; so a de produto tem.
  v_motivo := case when tg_table_name = 'estoque_movimentos' then new.motivo else null end;
  if not estoque_mov_avisavel(new.tipo, v_motivo) or new.avisado_em is not null then
    return new;
  end if;

  -- Toca so quem for a PRIMEIRA pendente da loja; as outras vao junto na mesma
  -- mensagem. Ver mig 0371 pro bug que isso corrige (INSERT de varias linhas).
  select exists (
    select 1 from estoque_movimentos x
     where x.empresa_id = new.empresa_id
       and estoque_mov_avisavel(x.tipo, x.motivo) and x.avisado_em is null
       and (x.created_at, x.id) < (new.created_at, new.id)
       and x.created_at > now() - interval '2 minutes'
  ) or exists (
    select 1 from materia_prima_movimentos x
     where x.empresa_id = new.empresa_id
       and estoque_mov_avisavel(x.tipo, null) and x.avisado_em is null
       and (x.created_at, x.id) < (new.created_at, new.id)
       and x.created_at > now() - interval '2 minutes'
  ) into ja_esperando;

  if ja_esperando then return new; end if;

  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/estoque-entrada-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := '{"esperar": 45}'::jsonb,
      -- O padrao do pg_net e 5s e a funcao dorme 45: sem isto toda chamada era
      -- dada como "timeout" e a resposta de verdade nunca ficava registrada.
      timeout_milliseconds := 90000
    );
  exception when others then
    raise warning '[estoque-entrada] nao consegui tocar a campainha: %', sqlerrm;
  end;

  return new;
end;
$dispara$;

revoke all on function public.estoque_avisos_monta()           from public, anon, authenticated;
revoke all on function public.estoque_entrada_avisos()         from public, anon, authenticated;
revoke all on function public.estoque_entrada_avisos_previa()  from public, anon, authenticated;
revoke all on function public.estoque_entrada_dispara()        from public, anon, authenticated;
