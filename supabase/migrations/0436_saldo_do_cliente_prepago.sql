-- SALDO DO CLIENTE (CONTA PRE-PAGA) — 04/11/2026
--
-- Pedido da Agv: tem cliente que paga a semana adiantada e vai consumindo. O
-- cashback/indicacao (creditos_movimentos) NAO serve: nasce so de indicacao,
-- nunca cobre o pedido inteiro e o que e gasto vira DESPESA da loja. Aqui o
-- dinheiro ENTROU antes, entao:
--   * o deposito entra em `pagamentos` (forma de verdade) -> o caixa do dia
--     enxerga o dinheiro/pix recebido, sem mexer na conta do caixa;
--   * gastar o saldo num pedido e forma 'saldo': cai em "outros" no caixa
--     (nao soma dinheiro novo) e baixa o extrato;
--   * sobra passa pra proxima semana (e so saldo, nao expira);
--   * cancelar o pedido / trocar a forma devolve o saldo sozinho.
-- Chave por loja (empresas.saldo_cliente_ativo), nasce desligada.

alter table public.empresas
  add column if not exists saldo_cliente_ativo boolean not null default false;
comment on column public.empresas.saldo_cliente_ativo is
  'Loja usa conta pre-paga do cliente (deposito adiantado + forma de pagamento "saldo").';

create table if not exists public.cliente_saldo_movimentos (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  cliente_id  uuid not null references public.clientes(id) on delete cascade,
  tipo        text not null check (tipo in ('deposito','uso','estorno','ajuste')),
  valor       numeric not null check (valor <> 0),   -- com sinal: deposito/estorno +, uso -
  forma       text,                                  -- forma do deposito
  pedido_id   uuid,
  observacao  text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists cliente_saldo_mov_cliente_idx on public.cliente_saldo_movimentos (cliente_id, created_at desc);
create index if not exists cliente_saldo_mov_pedido_idx  on public.cliente_saldo_movimentos (pedido_id) where pedido_id is not null;

alter table public.cliente_saldo_movimentos enable row level security;

drop policy if exists "Loja le saldo do cliente" on public.cliente_saldo_movimentos;
create policy "Loja le saldo do cliente" on public.cliente_saldo_movimentos
  for select to authenticated
  using (empresa_id = (select current_empresa_id()) or (select current_perfil()) = 'super_admin');
-- Sem policy de escrita: tudo entra pelas funcoes abaixo (SECURITY DEFINER).

-- Saldo atual do cliente (da loja de quem chama).
create or replace function public.cliente_saldo(p_cliente_id uuid)
 returns numeric
 language sql stable security definer
 set search_path to 'public'
as $$
  select coalesce(sum(valor), 0)
    from cliente_saldo_movimentos
   where cliente_id = p_cliente_id
     and empresa_id = current_empresa_id();
$$;
grant execute on function public.cliente_saldo(uuid) to authenticated;

-- Recebe o adiantamento: dinheiro entra no caixa de hoje e o saldo sobe.
create or replace function public.saldo_depositar(
  p_cliente_id uuid, p_valor numeric, p_forma text, p_obs text default null)
 returns numeric
 language plpgsql security definer
 set search_path to 'public'
as $$
declare
  v_emp uuid := current_empresa_id();
  v_ok  boolean;
begin
  if current_perfil() not in ('admin','vendedor','super_admin') then
    raise exception 'Sem permissão pra receber adiantamento.';
  end if;
  select saldo_cliente_ativo into v_ok from empresas where id = v_emp;
  if not coalesce(v_ok, false) then
    raise exception 'Esta loja não usa saldo de cliente.';
  end if;
  if not exists (select 1 from clientes where id = p_cliente_id and empresa_id = v_emp) then
    raise exception 'Cliente não encontrado.';
  end if;
  if p_valor is null or p_valor <= 0 then
    raise exception 'Informe um valor maior que zero.';
  end if;
  if p_forma not in ('dinheiro','pix','credito','debito','transferencia') then
    raise exception 'Forma de pagamento inválida.';
  end if;

  -- O prefixo "Presencial ·" tira a linha da conta de fiado que o cliente ve
  -- no portal (cliente_conta ignora essas linhas).
  insert into pagamentos (empresa_id, cliente_id, valor, forma_pagamento, observacao)
  values (v_emp, p_cliente_id, round(p_valor, 2), p_forma,
          'Presencial · Depósito de saldo' || coalesce(' · ' || nullif(btrim(p_obs), ''), ''));

  insert into cliente_saldo_movimentos (empresa_id, cliente_id, tipo, valor, forma, observacao)
  values (v_emp, p_cliente_id, 'deposito', round(p_valor, 2), p_forma, nullif(btrim(p_obs), ''));

  return cliente_saldo(p_cliente_id);
end;
$$;
grant execute on function public.saldo_depositar(uuid, numeric, text, text) to authenticated;

-- Acerta o extrato com o pedido como ele esta agora (mesma ideia do estoque:
-- exigido - ja lancado). Forma 'saldo' = total; dividido = partes 'saldo'.
create or replace function public.sincronizar_saldo_pedido_delivery(p_pedido pedidos_delivery)
 returns void
 language plpgsql security definer
 set search_path to 'public'
as $$
declare
  v_exigido numeric := 0;
  v_usado   numeric;
  v_delta   numeric;
  v_saldo   numeric;
  v_ok      boolean;
begin
  if p_pedido.status not in ('cancelado','aguardando_pagamento') then
    if p_pedido.forma_pagamento = 'saldo' then
      v_exigido := coalesce(p_pedido.total, 0);
    elsif p_pedido.forma_pagamento = 'dividido' and jsonb_typeof(p_pedido.pagamentos) = 'array' then
      select coalesce(sum((x->>'valor')::numeric), 0) into v_exigido
        from jsonb_array_elements(p_pedido.pagamentos) x
       where x->>'forma' = 'saldo';
    end if;
  end if;

  select coalesce(-sum(valor), 0) into v_usado
    from cliente_saldo_movimentos where pedido_id = p_pedido.id;

  v_delta := round(v_exigido - v_usado, 2);
  if v_delta = 0 then return; end if;

  if v_delta > 0 then
    select saldo_cliente_ativo into v_ok from empresas where id = p_pedido.empresa_id;
    if not coalesce(v_ok, false) then
      raise exception 'Esta loja não usa saldo de cliente.';
    end if;
    if p_pedido.cliente_id is null then
      raise exception 'Pagar com saldo precisa de cliente cadastrado no pedido.';
    end if;
    select coalesce(sum(valor), 0) into v_saldo
      from cliente_saldo_movimentos
     where cliente_id = p_pedido.cliente_id and empresa_id = p_pedido.empresa_id;
    if v_delta > v_saldo then
      raise exception 'Saldo insuficiente: o cliente tem R$ % e o pedido pede R$ %.',
        to_char(v_saldo, 'FM999999990.00'), to_char(v_delta, 'FM999999990.00');
    end if;
    insert into cliente_saldo_movimentos (empresa_id, cliente_id, tipo, valor, pedido_id, observacao)
    values (p_pedido.empresa_id, p_pedido.cliente_id, 'uso', -v_delta, p_pedido.id,
            'Delivery' || coalesce(' #' || p_pedido.numero_pedido::text, ''));
  else
    -- devolve pro mesmo cliente que gastou (o pedido pode ter trocado de cliente)
    insert into cliente_saldo_movimentos (empresa_id, cliente_id, tipo, valor, pedido_id, observacao)
    select p_pedido.empresa_id, m.cliente_id, 'estorno', -v_delta, p_pedido.id,
           'Estorno delivery' || coalesce(' #' || p_pedido.numero_pedido::text, '')
      from cliente_saldo_movimentos m
     where m.pedido_id = p_pedido.id
     order by m.created_at desc limit 1;
  end if;
end;
$$;
revoke all on function public.sincronizar_saldo_pedido_delivery(pedidos_delivery) from public, anon, authenticated;

create or replace function public.trg_pedido_delivery_saldo()
 returns trigger
 language plpgsql security definer
 set search_path to 'public'
as $$
begin
  perform sincronizar_saldo_pedido_delivery(NEW);
  return null;
end;
$$;

drop trigger if exists trg_pedido_delivery_saldo on public.pedidos_delivery;
create trigger trg_pedido_delivery_saldo
  after insert or update of forma_pagamento, pagamentos, total, status, cliente_id
  on public.pedidos_delivery
  for each row execute function public.trg_pedido_delivery_saldo();

-- Forma 'saldo' aceita no pedido e nas partes do pagamento dividido.
alter table public.pedidos_delivery drop constraint if exists pedidos_delivery_forma_pagamento_check;
alter table public.pedidos_delivery add constraint pedidos_delivery_forma_pagamento_check
  check (forma_pagamento = any (array['pix','pix_entrega','dinheiro','credito','debito','cartao','online','vale','outro','dividido','fiado','pluxee','alelo','vr','ticket','saldo']::text[]));

create or replace function public.validar_pagamentos_pedido()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
DECLARE
  v_partes  jsonb;
  v_soma    numeric;
  v_dif     numeric;
  v_idx     integer;
  v_novo    numeric;
  v_n       integer;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.forma_pagamento = 'dividido'
     AND NEW.forma_pagamento IS DISTINCT FROM 'dividido'
     AND NEW.pagamentos IS NOT DISTINCT FROM OLD.pagamentos THEN
    NEW.pagamentos := NULL;
    RETURN NEW;
  END IF;

  IF NEW.pagamentos IS NULL OR NEW.pagamentos = 'null'::jsonb THEN
    NEW.pagamentos := NULL;
    IF NEW.forma_pagamento = 'dividido' THEN
      RAISE EXCEPTION 'Pagamento dividido sem as partes.';
    END IF;
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.pagamentos) <> 'array' THEN
    RAISE EXCEPTION 'Partes do pagamento em formato inválido.';
  END IF;

  SELECT jsonb_agg(
           jsonb_strip_nulls(jsonb_build_object(
             'forma', x->>'forma',
             'valor', round(COALESCE(NULLIF(x->>'valor', '')::numeric, 0), 2),
             'troco_para', CASE WHEN x->>'forma' = 'dinheiro' AND NULLIF(x->>'troco_para', '') IS NOT NULL
                                THEN round((x->>'troco_para')::numeric, 2) END
           )) ORDER BY ord)
    INTO v_partes
    FROM jsonb_array_elements(NEW.pagamentos) WITH ORDINALITY AS t(x, ord);

  v_n := jsonb_array_length(v_partes);
  IF v_n < 2 THEN
    RAISE EXCEPTION 'Pagamento dividido precisa de pelo menos duas formas.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_partes) x
     WHERE NOT (x->>'forma' = ANY (ARRAY['pix','pix_entrega','dinheiro','credito','debito','cartao','vale','pluxee','alelo','vr','ticket','outro','saldo']))
  ) THEN
    RAISE EXCEPTION 'Forma de pagamento inválida numa das partes.';
  END IF;

  IF (SELECT count(*) FROM jsonb_array_elements(v_partes) x WHERE x->>'forma' = 'pix') > 1 THEN
    RAISE EXCEPTION 'Só dá pra ter um PIX online no pedido.';
  END IF;

  SELECT COALESCE(sum((x->>'valor')::numeric), 0) INTO v_soma FROM jsonb_array_elements(v_partes) x;
  v_dif := round(COALESCE(NEW.total, 0) - v_soma, 2);

  IF abs(v_dif) > 0.009 THEN
    -- a diferenca sai da parte em dinheiro; sem dinheiro, da ultima (nunca do saldo)
    SELECT ord - 1 INTO v_idx
      FROM jsonb_array_elements(v_partes) WITH ORDINALITY AS t(x, ord)
     WHERE x->>'forma' NOT IN ('pix', 'saldo')
     ORDER BY (x->>'forma' = 'dinheiro') DESC, ord DESC
     LIMIT 1;
    IF v_idx IS NULL THEN
      RAISE EXCEPTION 'A soma das formas (R$ %) não bate com o total (R$ %).', v_soma, NEW.total;
    END IF;
    v_novo := round((v_partes->v_idx->>'valor')::numeric + v_dif, 2);
    IF v_novo <= 0 THEN
      RAISE EXCEPTION 'A soma das formas (R$ %) não bate com o total (R$ %).', v_soma, NEW.total;
    END IF;
    v_partes := jsonb_set(v_partes, ARRAY[v_idx::text, 'valor'], to_jsonb(v_novo));
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_partes) x WHERE (x->>'valor')::numeric <= 0) THEN
    RAISE EXCEPTION 'Toda parte do pagamento precisa ter valor.';
  END IF;

  NEW.pagamentos := v_partes;
  NEW.forma_pagamento := 'dividido';
  NEW.troco_para := (SELECT (x->>'troco_para')::numeric FROM jsonb_array_elements(v_partes) x
                      WHERE x->>'forma' = 'dinheiro' LIMIT 1);
  RETURN NEW;
END;
$function$;

-- Agv pediu.
update public.empresas set saldo_cliente_ativo = true
 where id = 'febc3db3-1b04-4cdc-a22f-119db381fbeb';
