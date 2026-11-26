-- Wilde 26/11: impressora/PC parado ha muito tempo = nao estao usando, nao avisar.
--  - sem resposta: so PC visto nas ultimas 2 horas (era 48h, mig 0465)
--  - fila presa: so cupom preso ha no maximo 120 min
do $m$
declare d text; n text;
begin
  d := replace(pg_get_functiondef('public.impressora_saude_avisar()'::regprocedure), chr(13), '');
  n := replace(d, 'interval ''48 hours''', 'interval ''2 hours''');
  if n = d then raise exception 'trecho 48h'; end if; d := n;
  n := regexp_replace(d, '(and coalesce\(\(f->>''idade_min''\)::int, 0\) >= 5)(\n\s+loop)', E'\1\n       and coalesce((f->>''idade_min'')::int, 0) <= 120\2');
  if n = d then raise exception 'trecho fila'; end if; d := n;
  execute d;
end $m$;
