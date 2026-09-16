-- Comprovante do pagamento da mensalidade (quem pagou direto, fora do sistema).
-- Bucket privado, só o Super ADM mexe; a tela abre por link assinado.
alter table public.mensalidade_cobrancas add column if not exists comprovante_path text;

insert into storage.buckets (id, name, public, file_size_limit)
values ('mensalidade-comprovantes', 'mensalidade-comprovantes', false, 10485760)
on conflict (id) do nothing;

drop policy if exists "mensalidade-comprovantes super admin" on storage.objects;
create policy "mensalidade-comprovantes super admin" on storage.objects
  for all
  using (bucket_id = 'mensalidade-comprovantes' and current_perfil() = 'super_admin')
  with check (bucket_id = 'mensalidade-comprovantes' and current_perfil() = 'super_admin');

-- Marcar paga não apaga mais a observação da cobrança: ela guarda o histórico
-- de abatimentos ("16/09: abatido R$ 43,98 ..."), e sobrescrever com "PIX
-- direto" fazia o valor original sumir.
CREATE OR REPLACE FUNCTION public.mensalidade_marcar_paga(p_cobranca uuid, p_obs text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c mensalidade_cobrancas%ROWTYPE;
BEGIN
  IF current_perfil() <> 'super_admin' THEN RAISE EXCEPTION 'Só o Super ADM'; END IF;
  UPDATE mensalidade_cobrancas
     SET status = 'paga', pago_em = now(), forma = 'manual', valor_pago = valor,
         observacao = concat_ws(' · ', nullif(observacao, ''), 'Pago: ' || nullif(p_obs, ''))
   WHERE id = p_cobranca AND status = 'aberta'
  RETURNING * INTO v_c;
  IF v_c.id IS NULL THEN RETURN; END IF;
  INSERT INTO mensalidade_avisos (empresa_id, cobranca_id, tipo, profile_id, quem, detalhe)
  VALUES (v_c.empresa_id, v_c.id, 'pagou', auth.uid(), 'Super ADM', 'Marcada como paga à mão' || coalesce(': ' || p_obs, ''))
  ON CONFLICT DO NOTHING;
END;
$function$;
