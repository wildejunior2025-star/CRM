-- ─────────────────────────────────────────────────────────────────────────────
-- 0386 — Chave da loja: imprimir ou não o cupom da venda do balcão
--
-- 24/10/2026: "quando finaliza a compra sai um papel comprovando a forma de
-- pagamento e o pedido" — e loja que não quer esse papel não tinha como
-- desligar. O que existia era por APARELHO (localStorage do gestor) ou por PC
-- (filtro por origem do app FWC), nada por loja.
--
-- O PULO DO GATO É NÃO MEXER NO APP FWC: a chave entra dentro da
-- `reservar_impressao`, que TODO caminho de impressão automática consulta antes
-- de imprimir — o app FWC (v40+) e o navegador do gestor. Respondendo "não é a
-- sua vez", nenhum dos dois imprime, e não precisa publicar app novo nem
-- esperar os PCs da loja atualizarem.
--
-- O botão 🖨️ de reimprimir NÃO passa por aqui, de propósito: é o jeito de tirar
-- uma via quando o cliente pedir, mesmo com a impressão automática desligada.
--
-- Padrão `true` (imprime), que é como todas as lojas trabalham hoje.
-- ─────────────────────────────────────────────────────────────────────────────

alter table empresas
  add column if not exists imprimir_cupom_balcao boolean not null default true;

comment on column empresas.imprimir_cupom_balcao is
  'false = venda do balcão não sai no papel sozinha (vale pra loja toda; o botão de reimprimir continua valendo).';

create or replace function public.reservar_impressao(
  p_pedido uuid,
  p_quem text default ''::text,
  p_papel text default 'tudo'::text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_empresa uuid;
  v_origem  text;
  v_papel   text := coalesce(nullif(trim(p_papel), ''), 'tudo');
begin
  select pd.empresa_id, pd.origem into v_empresa, v_origem
    from pedidos_delivery pd where pd.id = p_pedido;
  if v_empresa is null then return false; end if;

  if v_empresa <> (select current_empresa_id())
     and coalesce((select current_perfil()), '') <> 'super_admin' then
    return false;
  end if;

  -- A loja desligou o cupom do balcão (mig 0386). Vale pra todo aparelho:
  -- quem pergunta "é a minha vez?" ouve que não, e ninguém imprime.
  if v_origem = 'balcao'
     and not coalesce((select e.imprimir_cupom_balcao from empresas e where e.id = v_empresa), true) then
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
$function$;
