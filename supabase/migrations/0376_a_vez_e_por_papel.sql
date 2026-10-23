-- A vez de imprimir é por PAPEL, não só por pedido (23/10/2026)
--
-- A 0375 deu a vez a UM aparelho por pedido. Isso mata o cupom repetido, mas
-- atropelaria a loja que usa DOIS papéis de propósito: um PC na cozinha, que
-- tira a comanda só com os itens, e outro na frente, que tira o cupom inteiro
-- com endereço e valores. São papéis DIFERENTES do mesmo pedido, e os dois
-- têm que sair.
--
-- Hoje nenhuma loja está assim — os 11 PCs reportam setor "tudo", e foi por
-- isso que o estrago não apareceu. Mas a opção existe na tela do app, e o dia
-- em que alguém marcar "só cozinha" num PC a cozinha pararia de receber.
--
-- Então a vez passa a ser de (pedido, papel): dois PCs no mesmo papel ainda
-- disputam e sai um cupom só; papéis diferentes não disputam nada.

alter table public.impressao_dono
  add column if not exists papel text not null default 'tudo';

alter table public.impressao_dono drop constraint if exists impressao_dono_pkey;
alter table public.impressao_dono add primary key (pedido_id, papel);

-- A de dois argumentos TEM que sair: com as duas no banco, a chamada de dois
-- argumentos (que é a do app v40, já publicado) bateria em "function is not
-- unique" e ninguém imprimiria. Some ela, e a v40 cai na nova pelo default.
drop function if exists public.reservar_impressao(uuid, text);

create or replace function public.reservar_impressao(
  p_pedido uuid,
  p_quem   text default '',
  p_papel  text default 'tudo'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_empresa uuid;
  v_papel   text := coalesce(nullif(trim(p_papel), ''), 'tudo');
begin
  select empresa_id into v_empresa from pedidos_delivery where id = p_pedido;
  if v_empresa is null then return false; end if;

  if v_empresa <> (select current_empresa_id())
     and coalesce((select current_perfil()), '') <> 'super_admin' then
    return false;
  end if;

  insert into impressao_dono (pedido_id, papel, empresa_id, quem)
  values (p_pedido, v_papel, v_empresa, left(coalesce(p_quem, ''), 60))
  on conflict (pedido_id, papel) do nothing;

  if random() < 0.02 then
    delete from impressao_dono where criado_em < now() - interval '2 days';
  end if;

  return found;
end;
$$;

revoke all on function public.reservar_impressao(uuid, text, text) from public;
grant execute on function public.reservar_impressao(uuid, text, text) to authenticated;

comment on function public.reservar_impressao(uuid, text, text) is
  'Da a vez de imprimir um pedido a UM aparelho por papel (tudo/cozinha/frente). TRUE = pode imprimir.';
