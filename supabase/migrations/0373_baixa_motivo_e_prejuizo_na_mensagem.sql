-- O motivo da baixa precisa APARECER na mensagem (23/10/2026)
--
-- O Wilde deu baixa escrevendo "Teste" como motivo e disse que nao viu o
-- motivo na mensagem. Ele estava la — mas enterrado:
--
--   ➖ TAPIOCA COM MANTEIGA — baixa de 7, tem 4 agora
--      TAPIOCA COM MANTEIGA — Teste        <- o motivo, sem rotulo
--
-- A `imprevisto_registrar` grava a observacao como "<produto> — <motivo>".
-- Repetindo o nome do produto, a linha parecia um titulo repetido e o "Teste"
-- sumia no meio. Agora: tira o prefixo e poe "Motivo:" na frente.
--
-- E O PREJUIZO NAO VINHA
-- `estoque_movimentos.valor_total` fica NULL nessas baixas: a RPC guarda o
-- valor em `custos_imprevistos` e so liga pelo `estoque_movimento_id`. Quem
-- lesse so o movimento nunca veria dinheiro nenhum — e e o dinheiro que faz o
-- dono conferir.

-- ── dinheiro sempre com 2 casas ─────────────────────────────────────────────
-- O num_br corta zero a direita, o que e certo pra quantidade ("2,5 kg") e
-- errado pra valor: saia "R$ 56" no lugar de "R$ 56,00".
create or replace function public.reais_br(v numeric)
returns text
language sql
immutable
as $$
  select 'R$ ' || replace(to_char(round(coalesce(v, 0), 2), 'FM999999990.00'), '.', ',')
$$;

-- ── a mensagem ──────────────────────────────────────────────────────────────
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
           -- Tira o "<produto> — " da frente da observacao: o rotulo "Motivo:"
           -- entra na montagem, e repetir o nome do produto enterrava o texto.
           case when coalesce(m.observacao, '') like p.nome || ' — %'
                then btrim(substring(m.observacao from length(p.nome) + 4))
                else coalesce(m.observacao, '') end as observacao,
           -- O prejuizo NAO fica no movimento: `imprevisto_registrar` guarda o
           -- valor em custos_imprevistos e so liga pelo estoque_movimento_id.
           coalesce(m.valor_total,
                    (select ci.valor from custos_imprevistos ci
                      where ci.estoque_movimento_id = m.id limit 1)) as valor_total,
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
                   case when nullif(v.observacao, '') is not null
                        then 'Motivo: ' || v.observacao end,
                   case when coalesce(v.valor_total, 0) > 0
                        then reais_br(v.valor_total) || ' de prejuízo' end
                 ), ''), chr(10) || '   '), '')
             else '' end,
             chr(10) order by v.tipo, v.item
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

revoke all on function public.estoque_avisos_monta() from public, anon, authenticated;
