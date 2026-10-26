-- ─────────────────────────────────────────────────────────────────────────────
-- 0398 — O aviso de caixa também sai no FECHAMENTO DO DIA, e pode ir pra mais
--        de um dono
--
-- Agv, 26/10/2026 às 15:48: a loja fechou o dia (R$ 2.692,45 de faturamento) e
-- o dono não recebeu nada, com o `notif_caixa` LIGADO.
--
-- O motivo: existem DOIS fechamentos no sistema e o aviso só conhecia um.
--   • `caixas`    — o caixa que abre e fecha (gaveta), com os gatilhos da 0375.
--   • `caixa_dia` — a conferência do DIA, o botão "Conferir o dia" da tela de
--                   Caixa, que é por onde a Agv trabalha. Sem gatilho nenhum.
-- O caixa da Agv estava aberto desde 11:07 e continua aberto; o que eles fazem
-- é conferir o dia. Então o aviso nunca ia sair.
--
-- Aqui: o mesmo aviso, com a mesma cara, no fechamento do dia. A conta é mais
-- simples que a do caixa porque a `caixa_dia` já guarda contado E esperado de
-- cada forma — não há o que recalcular, e recalcular seria arriscar discordar
-- da tela.
--
-- E a segunda parte: VÁRIOS DONOS. Loja com dois sócios tinha que escolher um.
-- `whatsapp_config.admin_phones` é a lista extra; o `admin_phone` continua
-- valendo e vem sempre primeiro. Sem repetir número: a comparação é pelos 8
-- últimos dígitos, que é como o resto do sistema casa telefone (o 9 do celular
-- entra e sai dependendo de quem digitou).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.whatsapp_config
  add column if not exists admin_phones text[];

comment on column public.whatsapp_config.admin_phones is
  'Donos EXTRAS que recebem os avisos (caixa, estoque). O admin_phone continua sendo o principal.';

-- Quem recebe aviso nesta loja, sem repetido e sem vazio.
create or replace function public.donos_do_aviso(p_empresa_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(tel order by ord), '{}'::text[])
  from (
    select distinct on (right(regexp_replace(tel, '[^0-9]', '', 'g'), 8))
           regexp_replace(tel, '[^0-9]', '', 'g') as tel, ord
    from (
      select trim(wc.admin_phone) as tel, 0 as ord
        from whatsapp_config wc where wc.empresa_id = p_empresa_id
      union all
      select trim(x.tel), 1
        from whatsapp_config wc, unnest(coalesce(wc.admin_phones, '{}'::text[])) as x(tel)
       where wc.empresa_id = p_empresa_id
    ) t
    where coalesce(trim(t.tel), '') <> ''
      and length(regexp_replace(t.tel, '[^0-9]', '', 'g')) >= 10
    order by right(regexp_replace(tel, '[^0-9]', '', 'g'), 8), ord
  ) u;
$$;

-- ── O aviso do fechamento do DIA ────────────────────────────────────────────
create or replace function public.caixa_dia_aviso(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  d        caixa_dia%rowtype;
  wc       record;
  v_loja   text;
  v_quem   text;
  v_texto  text;
  v_vales  text;
  dif_din  numeric;
  dif_pix  numeric;
  v_fones  text[];
begin
  select * into d from caixa_dia where id = p_id;
  if d.id is null or d.fechado_em is null then return null; end if;

  select coalesce(nullif(trim(wc2.instance_name), ''),
                  (select valor from config_global where chave = 'admin_sender_instance'),
                  'crmadmin') as instancia,
         wc2.notif_caixa
    into wc
    from whatsapp_config wc2 where wc2.empresa_id = d.empresa_id;

  v_fones := donos_do_aviso(d.empresa_id);
  if not coalesce(wc.notif_caixa, false) or coalesce(array_length(v_fones, 1), 0) = 0 then
    return null;
  end if;

  select nome into v_loja from empresas where id = d.empresa_id;
  v_quem := estoque_quem_lancou(d.fechado_por);

  dif_din := coalesce(d.contado_dinheiro, 0) - coalesce(d.esperado_dinheiro, 0);
  dif_pix := coalesce(d.contado_pix, 0)      - coalesce(d.esperado_pix, 0);

  -- Vales (Pluxee, Alelo, VR, Ticket), do mesmo jeito do fechamento do caixa.
  select coalesce(string_agg(
           chr(10) || chr(10) || U&'\+01F37D\FE0F' || ' *' || t.nome || '*' || chr(10) ||
           '   contou ' || reais_br(t.contado) || ' · esperado ' || reais_br(t.esperado) || chr(10) ||
           '   ' || case
                      when abs(t.contado - t.esperado) < 0.01 then U&'\2705' || ' bateu certinho'
                      when t.contado > t.esperado then U&'\26A0\FE0F' || ' sobrou ' || reais_br(t.contado - t.esperado)
                      else U&'\+01F6A8' || ' faltou ' || reais_br(t.esperado - t.contado)
                    end,
           '' order by t.ord), '')
    into v_vales
    from (
      select case k.key when 'pluxee' then 'Pluxee' when 'alelo' then 'Alelo'
                        when 'vr' then 'VR' when 'ticket' then 'Ticket' else k.key end as nome,
             (k.value ->> 'contado')::numeric as contado,
             coalesce((k.value ->> 'esperado')::numeric, 0) as esperado,
             case k.key when 'pluxee' then 1 when 'alelo' then 2 when 'vr' then 3 else 4 end as ord
        from jsonb_each(coalesce(d.conferido_vales, '{}'::jsonb)) k
       where (k.value ->> 'contado') is not null
    ) t;

  v_texto :=
    U&'\+01F534' || ' *Dia conferido e fechado* — ' || coalesce(v_loja, '') || chr(10) || chr(10) ||
    'Quem fechou: *' || v_quem || '*' || chr(10) ||
    'Dia: ' || to_char(d.data, 'DD/MM') ||
    ' · às ' || to_char(d.fechado_em at time zone 'America/Fortaleza', 'HH24:MI') || chr(10) || chr(10) ||
    U&'\+01F4B5' || ' *Dinheiro*' || chr(10) ||
    '   contou ' || reais_br(d.contado_dinheiro) || ' · esperado ' || reais_br(d.esperado_dinheiro) || chr(10) ||
    '   ' || case
              when abs(dif_din) < 0.01 then U&'\2705' || ' bateu certinho'
              when dif_din > 0 then U&'\26A0\FE0F' || ' *sobrou ' || reais_br(dif_din) || '*'
              else U&'\+01F6A8' || ' *faltou ' || reais_br(abs(dif_din)) || '*'
            end ||
    case when d.contado_pix is not null or coalesce(d.esperado_pix, 0) > 0 then
      chr(10) || chr(10) || U&'\+01F4F1' || ' *PIX*' || chr(10) ||
      '   contou ' || reais_br(d.contado_pix) || ' · esperado ' || reais_br(d.esperado_pix) || chr(10) ||
      '   ' || case
                 when abs(dif_pix) < 0.01 then U&'\2705' || ' bateu certinho'
                 when dif_pix > 0 then U&'\26A0\FE0F' || ' sobrou ' || reais_br(dif_pix)
                 else U&'\+01F6A8' || ' faltou ' || reais_br(abs(dif_pix))
               end
    else '' end ||
    -- Cartão vai sem esperado, de propósito: a conta depende da taxa de cada
    -- maquininha e duas contas do mesmo número sempre acabam discordando.
    case when coalesce(d.contado_cartao, 0) > 0 then
      chr(10) || chr(10) || U&'\+01F4B3' || ' Cartão contado: ' || reais_br(d.contado_cartao)
    else '' end ||
    v_vales ||
    case when coalesce(trim(d.observacoes), '') <> ''
         then chr(10) || chr(10) || U&'\+01F4DD' || ' ' || d.observacoes else '' end;

  return jsonb_build_object(
    'instancia', wc.instancia,
    'telefone',  v_fones[1],     -- compatibilidade com quem lê um só
    'telefones', to_jsonb(v_fones),
    'texto',     v_texto
  );
end;
$function$;

-- O caixa_aviso passa a devolver a lista de donos também.
create or replace function public.caixa_aviso_telefones(p_empresa_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$ select to_jsonb(donos_do_aviso(p_empresa_id)) $$;

-- ── Gatilho do fechamento do dia ────────────────────────────────────────────
create or replace function public.caixa_dia_dispara_aviso()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.fechado_em is null or (tg_op = 'UPDATE' and old.fechado_em is not null) then
    return new;
  end if;
  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/caixa-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object('caixa_dia_id', new.id),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning '[caixa-aviso] dia: nao consegui avisar: %', sqlerrm;
  end;
  return new;
end;
$function$;

drop trigger if exists caixa_dia_avisa_fechamento on public.caixa_dia;
create trigger caixa_dia_avisa_fechamento
  after insert or update of fechado_em on public.caixa_dia
  for each row execute function public.caixa_dia_dispara_aviso();

-- ── O aviso de estoque segue a mesma lista de donos ─────────────────────────
-- Era a mesma história: um número só. E o guard virou a lista, senão loja que
-- preenchesse apenas os donos extras ficava sem aviso nenhum.
create or replace function public.estoque_avisos_monta()
returns jsonb
language sql
stable
security definer
set search_path = public
as $function$
  with pendentes as (
    select m.id, m.empresa_id, m.created_by, m.created_at, m.tipo,
           p.nome as item, m.quantidade, ''::text as unidade,
           coalesce(m.motivo, '') as motivo,
           -- A observacao da baixa e gravada como "<produto> — <motivo>".
           -- Repetir o nome do produto aqui enterrava o motivo no meio da
           -- linha e o dono nao enxergava (reclamacao de 23/10). Tira o
           -- prefixo; o rotulo "Motivo:" entra na montagem.
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
     where estoque_mov_avisavel(m.tipo, null, m.observacao) and m.avisado_em is null
       and m.created_at > now() - interval '2 days'
  ),
  validas as (
    select pe.*, donos_do_aviso(pe.empresa_id) as fones, e.nome as loja,
           coalesce(nullif(trim(wc.instance_name), ''),
                    (select valor from config_global where chave = 'admin_sender_instance'),
                    'crmadmin') as instance_name
      from pendentes pe
      join whatsapp_config wc on wc.empresa_id = pe.empresa_id
      join empresas e on e.id = pe.empresa_id
     where wc.notif_entrada_estoque
       and coalesce(array_length(donos_do_aviso(pe.empresa_id), 1), 0) > 0
  ),
  agrupado as (
    select v.empresa_id, v.created_by, v.fones, v.instance_name, v.loja,
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
     group by v.empresa_id, v.created_by, v.fones, v.instance_name, v.loja
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'loja', g.loja, 'empresa_id', g.empresa_id,
           'instancia', g.instance_name,
           'telefone', g.fones[1],              -- compatibilidade
           'telefones', to_jsonb(g.fones),
           'texto',
             case when g.tem_baixa then U&'\26A0\FE0F' || ' *Mexeram no estoque*'
                                   else U&'\+01F4E6' || ' *Entrada no estoque*' end
             || chr(10) || chr(10) ||
             'Quem lançou: *' || estoque_quem_lancou(g.created_by) || '*' || chr(10) ||
             'Quando: ' || to_char(g.quando at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
             chr(10) || chr(10) || g.lista
         )), '[]'::jsonb)
    from agrupado g
$function$;

create or replace function public.estoque_entrada_avisos()
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_saida jsonb;
begin
  v_saida := estoque_avisos_monta();

  update estoque_movimentos m set avisado_em = now()
   where estoque_mov_avisavel(m.tipo, m.motivo) and m.avisado_em is null
     and m.created_at > now() - interval '2 days'
     and exists (select 1 from whatsapp_config wc
                  where wc.empresa_id = m.empresa_id and wc.notif_entrada_estoque
                    and coalesce(array_length(donos_do_aviso(m.empresa_id), 1), 0) > 0);

  update materia_prima_movimentos m set avisado_em = now()
   where estoque_mov_avisavel(m.tipo, null, m.observacao) and m.avisado_em is null
     and m.created_at > now() - interval '2 days'
     and exists (select 1 from whatsapp_config wc
                  where wc.empresa_id = m.empresa_id and wc.notif_entrada_estoque
                    and coalesce(array_length(donos_do_aviso(m.empresa_id), 1), 0) > 0);

  return v_saida;
end;
$function$;
