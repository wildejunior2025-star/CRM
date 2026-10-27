-- 0419 — PRODUTO PAUSADO POR FALTA DE ESTOQUE NÃO SE DESPAUSA NA MÃO
--
-- 27/10/2026, AGV: a pausa automática (trg_pausa_sem_estoque) já tirava do cardápio o que zerava
-- (Batom preto, Brownie, Pingo de leite…), mas o "▶ Ativar" do Catálogo reativava sem dizer nada — e o
-- item voltava a ser vendido com estoque zero. Agora o banco recusa, com o recado do que fazer: dar
-- entrada (Lançar compra / Contar estoque) que ele volta sozinho. Vale pra qualquer tela.
--
-- Escapes que continuam abertos, de propósito:
--   * a própria pausa automática reativa quando o estoque volta (ela zera pausado_por_estoque junto);
--   * desligar o "controla estoque" do produto (ou a loja desligar a pausa sem estoque) libera — aí a
--     marca de "pausado por estoque" some, porque deixou de valer.

create or replace function trg_produto_nao_despausa_sem_estoque() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_pausa boolean;
begin
  if not coalesce(new.pausado_por_estoque, false) then return new; end if;

  -- O controle de estoque foi desligado: a pausa pelo estoque deixa de existir.
  if not coalesce(new.controla_estoque, false) then
    new.pausado_por_estoque := false;
    return new;
  end if;

  if coalesce(new.ativo, false) and not coalesce(old.ativo, false) then
    select pausa_sem_estoque into v_pausa from empresas where id = new.empresa_id;
    if not coalesce(v_pausa, false) then
      new.pausado_por_estoque := false;
      return new;
    end if;
    if estoque_saldo_produto(new.id) <= 0 then
      raise exception 'SEM_ESTOQUE: "%" está pausado porque o estoque zerou. Lance a compra (ou acerte na contagem) que ele volta a vender sozinho.', new.nome
        using errcode = 'P0001';
    end if;
    new.pausado_por_estoque := false;
  end if;
  return new;
end $$;

drop trigger if exists produto_nao_despausa_sem_estoque on produtos;
create trigger produto_nao_despausa_sem_estoque before update of ativo, controla_estoque on produtos
  for each row execute function trg_produto_nao_despausa_sem_estoque();
