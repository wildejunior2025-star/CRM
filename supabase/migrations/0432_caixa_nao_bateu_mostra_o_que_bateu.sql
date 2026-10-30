-- A MENSAGEM "CAIXA NÃO BATEU" TAMBÉM DIZ O QUE BATEU (30/10/2026)
--
-- Pedido do dono: além do que não bateu (com a diferença), a mensagem lista o que
-- bateu. A tentativa passa a guardar as TRÊS formas (`todas`); `formas` continua
-- só com as que erraram (é com ela que o aviso repetido em 10 min é barrado).

-- ── 1. A mensagem, num lugar só ─────────────────────────────────────────────
create or replace function public.caixa_aviso_nao_bateu(
  c caixas, p_instancia text, p_fones text[], p_loja text
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_quem   text;
  v_erra   text;
  v_bateu  text;
  v_texto  text;
begin
  if c.ultima_tentativa is null then return null; end if;
  v_quem := estoque_quem_lancou(nullif(c.ultima_tentativa ->> 'por', '')::uuid);

  -- Forma sem nenhum movimento (esperado 0 e contado 0) não entra: a loja que
  -- não tem maquineta não precisa ler "cartão bateu: R$ 0,00".
  with f as (
    select k.key as forma,
           (k.value ->> 'contado')::numeric as contado,
           (k.value ->> 'esperado')::numeric as esperado,
           case k.key when 'dinheiro' then 1 when 'pix' then 2 else 3 end as ord,
           case k.key when 'dinheiro' then U&'\+01F4B5' || ' *Dinheiro*'
                      when 'pix'      then U&'\+01F4F1' || ' *PIX*'
                      else                 U&'\+01F4B3' || ' *Cartão (conta da maquineta)*' end as rotulo,
           (c.ultima_tentativa -> 'formas') ? k.key as errou
      from jsonb_each(coalesce(c.ultima_tentativa -> 'todas', c.ultima_tentativa -> 'formas')) k
  )
  select
    string_agg(
      rotulo || chr(10) ||
      '   contou ' || reais_br(contado) || ' · esperado ' || reais_br(esperado) || chr(10) ||
      '   ' || case when contado > esperado
                    then U&'\26A0\FE0F' || ' *sobrou ' || reais_br(contado - esperado) || '*'
                    else U&'\+01F6A8' || ' *faltou ' || reais_br(esperado - contado) || '*' end,
      chr(10) || chr(10) order by ord) filter (where errou),
    string_agg(
      U&'\2705' || ' ' || rotulo || ' — ' || reais_br(contado),
      chr(10) order by ord) filter (where not errou and (contado <> 0 or esperado <> 0))
    into v_erra, v_bateu
    from f;

  v_texto :=
    U&'\+01F7E0' || ' *Caixa não bateu* — ' || coalesce(p_loja, '') || chr(10) || chr(10) ||
    'Quem tentou fechar: *' || v_quem || '*' || chr(10) ||
    'Quando: ' || to_char((c.ultima_tentativa ->> 'em')::timestamptz at time zone 'America/Fortaleza', 'DD/MM às HH24:MI') ||
    chr(10) || chr(10) ||
    U&'\274C' || ' *NÃO BATEU*' || chr(10) || coalesce(v_erra, '—') ||
    case when v_bateu is not null
         then chr(10) || chr(10) || U&'\2705' || ' *BATEU*' || chr(10) || v_bateu else '' end ||
    chr(10) || chr(10) ||
    'O caixa *não foi fechado*. Feche pelo seu login (você pode fechar mesmo sem bater — ' ||
    'a diferença vai na mensagem de fechamento) ou toque em *Liberar fechamento* na tela do Caixa.';

  return jsonb_build_object('instancia', p_instancia, 'telefone', p_fones[1], 'telefones', to_jsonb(p_fones), 'texto', v_texto);
end;
$$;

-- ── 2. caixa_aviso passa a delegar o bloco 'nao_bateu' pra função de cima ───
do $$
declare
  v_def text := pg_get_functiondef('public.caixa_aviso(uuid, text)'::regprocedure);
  v_ini int;
  v_fim int;
begin
  v_ini := position('  if p_momento = ''nao_bateu'' then' in v_def);
  v_fim := position('  if p_momento = ''abertura'' then' in v_def);
  if v_ini = 0 or v_fim = 0 or v_fim < v_ini then
    raise exception 'blocos do caixa_aviso não encontrados';
  end if;
  v_def := substr(v_def, 1, v_ini - 1)
        || E'  if p_momento = ''nao_bateu'' then\n'
        || E'    return caixa_aviso_nao_bateu(c, wc.instancia, v_fones, v_loja);\n'
        || E'  end if;\n\n'
        || substr(v_def, v_fim);
  execute v_def;
end $$;

-- ── 3. A tentativa guarda as três formas ────────────────────────────────────
create or replace function public.registrar_nao_bateu(
  p_caixa_id uuid,
  p_dinheiro numeric,
  p_pix numeric,
  p_cartao numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c caixas%rowtype;
  e record;
  f jsonb := '{}'::jsonb;
  t jsonb;
begin
  if current_perfil() not in ('admin', 'vendedor') then
    raise exception 'Sem permissão';
  end if;

  select * into c from caixas
  where id = p_caixa_id and empresa_id = current_empresa_id()
    and status = 'aberto' and aberto_por = auth.uid();
  if c.id is null then return; end if;

  if not coalesce((select caixa_cego from empresas where id = c.empresa_id), false) then
    return;
  end if;

  select * into e from caixa_esperado(p_caixa_id);
  t := jsonb_build_object(
    'dinheiro', jsonb_build_object('contado', coalesce(p_dinheiro, 0), 'esperado', coalesce(e.dinheiro, 0)),
    'pix',      jsonb_build_object('contado', coalesce(p_pix, 0),      'esperado', coalesce(e.pix, 0)),
    'cartao',   jsonb_build_object('contado', coalesce(p_cartao, 0),   'esperado', coalesce(e.cartao, 0))
  );
  if abs(coalesce(p_dinheiro, 0) - coalesce(e.dinheiro, 0)) > 0.011 then f := f || jsonb_build_object('dinheiro', t -> 'dinheiro'); end if;
  if abs(coalesce(p_pix, 0) - coalesce(e.pix, 0)) > 0.011 then f := f || jsonb_build_object('pix', t -> 'pix'); end if;
  if abs(coalesce(p_cartao, 0) - coalesce(e.cartao, 0)) > 0.101 then f := f || jsonb_build_object('cartao', t -> 'cartao'); end if;
  if f = '{}'::jsonb then return; end if;

  if c.ultima_tentativa is not null
     and (c.ultima_tentativa -> 'formas') = f
     and (c.ultima_tentativa ->> 'em')::timestamptz > now() - interval '10 minutes' then
    return;
  end if;

  update caixas
  set ultima_tentativa = jsonb_build_object('em', now(), 'por', auth.uid(), 'formas', f, 'todas', t),
      liberacao_pedida_em = now(),
      liberacao_pedida_por = auth.uid()
  where id = c.id;

  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/caixa-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object('caixa_id', c.id, 'momento', 'nao_bateu'),
      timeout_milliseconds := 20000
    );
  exception when others then
    raise warning '[caixa-aviso] nao consegui avisar: %', sqlerrm;
  end;
end;
$$;
