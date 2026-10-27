-- 0411 — entrega à cozinha e sobra NÃO disparam o aviso de WhatsApp de estoque
--
-- 27/10/2026: estoque_mov_avisavel() avisa o dono em toda entrada e em toda saída que não seja venda. As
-- movimentações da Cozinha (mig 0409) são ações do próprio dono, então o aviso seria barulho (e a sobra
-- apareceria como "entrada"). Marcar avisado_em no INSERT faz estoque_entrada_dispara() ignorar a linha.

create or replace function trg_mp_mov_cozinha_sem_aviso() returns trigger
language plpgsql as $$
begin
  if new.avisado_em is null and (new.observacao like 'Cozinha — %' or new.observacao like 'Sobra da cozinha — %') then
    new.avisado_em := now();
  end if;
  return new;
end $$;

drop trigger if exists mp_mov_cozinha_sem_aviso on materia_prima_movimentos;
create trigger mp_mov_cozinha_sem_aviso before insert on materia_prima_movimentos
  for each row execute function trg_mp_mov_cozinha_sem_aviso();
