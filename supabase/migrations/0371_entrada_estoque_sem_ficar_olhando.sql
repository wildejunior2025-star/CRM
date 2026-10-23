-- Aviso de entrada deixa de ser vigia e passa a ser campainha (23/10/2026)
--
-- POR QUE MUDOU
-- O Wilde: "essas entradas acontecem uma vez perdida, aí vai ficar um negocio o
-- tempo todo olhando sem necessidade". Ele tem razao, e os numeros confirmam:
-- sao 219 entradas em TODA a historia do sistema, e o cron de 2 em 2 min dava
-- 720 chamadas por dia pra achar nada em 719 delas. O banco nao sentia (a
-- consulta custa 0,08 ms), mas e invocacao de edge function jogada fora.
--
-- COMO FICOU
-- Gatilho no banco: a entrada e que chama. Quem lanca toca a campainha uma vez,
-- e a edge function espera ~60s antes de ler — e nessa espera que o lote do
-- fornecedor se junta numa mensagem so. Resultado: ~1 chamada por lote, em vez
-- de 720 por dia.
--
-- POR QUE NO BANCO, E NAO NO CLIQUE DA TELA
-- No clique so funcionaria naquele botao. Entrada pela ficha tecnica, por
-- importacao ou por qualquer tela futura passaria batido — e ninguem iria
-- lembrar de pendurar o aviso na tela nova. No banco, toda entrada passa por
-- aqui, venha de onde vier.
--
-- A REDE DE SEGURANCA
-- O cron continua, mas de 30 em 30 min (48/dia em vez de 720). Ele existe pro
-- dia em que o pg_net falhar ou a funcao cair no meio: sem ele, a entrada
-- ficaria pendente pra sempre e ninguem saberia. 93% menos chamada, e ainda
-- com garantia de entrega.

-- ── a campainha ─────────────────────────────────────────────────────────────
create or replace function public.estoque_entrada_dispara()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ja_esperando boolean;
begin
  if new.tipo <> 'entrada' or new.avisado_em is not null then
    return new;
  end if;

  -- Toca só quem for a PRIMEIRA pendente da loja; as outras vão junto na mesma
  -- mensagem, porque o chamado que a primeira abriu ainda está na espera.
  --
  -- O "primeira" é por (created_at, id), e NÃO por "existe outra pendente".
  -- Essa segunda versão parecia certa e estava errada: num INSERT de várias
  -- linhas (importação), os gatilhos AFTER de todas só disparam depois que
  -- todas já existem, então cada uma via as outras, achava que alguém já tinha
  -- tocado, e NINGUÉM tocava — 5 itens lançados, 0 chamadas. O ensaio pegou.
  -- O id entra como desempate porque, na mesma transação, todas têm o mesmo now().
  --
  -- A janela de 2 min é de propósito: se uma rodada falhar e deixar linha
  -- pendente velha, a próxima entrada volta a tocar em vez de ficar presa
  -- esperando um chamado que já morreu.
  select exists (
    select 1 from estoque_movimentos x
     where x.empresa_id = new.empresa_id and x.tipo = 'entrada'
       and x.avisado_em is null
       and (x.created_at, x.id) < (new.created_at, new.id)
       and x.created_at > now() - interval '2 minutes'
  ) or exists (
    select 1 from materia_prima_movimentos x
     where x.empresa_id = new.empresa_id and x.tipo = 'entrada'
       and x.avisado_em is null
       and (x.created_at, x.id) < (new.created_at, new.id)
       and x.created_at > now() - interval '2 minutes'
  ) into ja_esperando;

  if ja_esperando then
    return new;
  end if;

  -- `esperar` manda a função dormir antes de ler, pra juntar o lote.
  -- Dentro de begin/exception: avisar NUNCA pode impedir alguém de dar entrada
  -- no estoque. Se o pg_net estiver fora do ar, a rede de segurança pega.
  begin
    perform net.http_post(
      url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/estoque-entrada-aviso',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := '{"esperar": 60}'::jsonb
    );
  exception when others then
    raise warning '[estoque-entrada] nao consegui tocar a campainha: %', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.estoque_entrada_dispara() from public, anon, authenticated;

drop trigger if exists estoque_mov_avisa_entrada on public.estoque_movimentos;
create trigger estoque_mov_avisa_entrada
  after insert on public.estoque_movimentos
  for each row execute function public.estoque_entrada_dispara();

drop trigger if exists mp_mov_avisa_entrada on public.materia_prima_movimentos;
create trigger mp_mov_avisa_entrada
  after insert on public.materia_prima_movimentos
  for each row execute function public.estoque_entrada_dispara();

-- ── a rede de seguranca, bem mais rala ──────────────────────────────────────
select cron.unschedule('estoque-entrada-aviso')
 where exists (select 1 from cron.job where jobname = 'estoque-entrada-aviso');

select cron.schedule(
  'estoque-entrada-aviso',
  '*/30 * * * *',
  $cron$
  select net.http_post(
    url     := 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/estoque-entrada-aviso',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb
  )
  $cron$
);
