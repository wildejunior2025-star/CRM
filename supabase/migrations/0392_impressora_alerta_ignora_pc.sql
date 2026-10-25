-- Alerta de impressora ignora os PCs da propria FWC.
-- O PC do Wilde (DESKTOP-69VJLGU) roda o app Impressora FWC logado na loja que
-- ele estiver atendendo, com uma "ELGIN i9(USB)" desconectada na fila do
-- Windows: os cupons ficam presos ali e o alerta saia em nome da loja
-- (Braseiro 24/10 "23 presos ha 2141 min", La em Casa 23/10), com a impressora
-- de verdade da loja imprimindo normal. Lista em config_global
-- 'impressora_alerta_pcs_ignorar', nomes separados por virgula.

insert into config_global (chave, valor)
values ('impressora_alerta_pcs_ignorar', 'DESKTOP-69VJLGU')
on conflict (chave) do update set valor = excluded.valor;

create or replace function public.impressora_saude_avisar()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_msgs     jsonb := '[]'::jsonb;
  v_telefone text;
  r          record;
  v_ignorar  text[];
begin
  select coalesce(array_agg(btrim(p)) filter (where btrim(p) <> ''), '{}')
    into v_ignorar
    from config_global c, unnest(string_to_array(c.valor, ',')) p
   where c.chave = 'impressora_alerta_pcs_ignorar';
  v_ignorar := coalesce(v_ignorar, '{}');

  -- Loja silenciada ou fechada, ou PC da FWC: fecha o que estiver aberto sem
  -- mandar "voltou ao normal".
  update impressora_incidente i
     set fechado_em     = coalesce(i.fechado_em, now()),
         avisado_em     = coalesce(i.avisado_em, now()),
         avisado_fim_em = now()
    from empresas e
   where e.id = i.empresa_id
     and (e.impressora_alerta_off or not loja_aberta_agora(e.id) or i.pc = any(v_ignorar))
     and i.avisado_fim_em is null;

  for r in
    select s.empresa_id, s.pc, e.nome as loja,
           f->>'nome' as impressora,
           coalesce((f->>'presos')::int, 0)    as presos,
           coalesce((f->>'idade_min')::int, 0) as idade_min,
           coalesce(f->>'papel', '')           as papel
      from impressora_saude s
      join empresas e on e.id = s.empresa_id
      cross join lateral jsonb_array_elements(s.filas) f
     where s.visto_em > now() - interval '30 minutes'
       and not e.impressora_alerta_off
       and not (s.pc = any(v_ignorar))
       and loja_aberta_agora(e.id)
       and coalesce((f->>'presos')::int, 0)    >= 2
       and coalesce((f->>'idade_min')::int, 0) >= 5
  loop
    insert into impressora_incidente (empresa_id, pc, impressora, tipo, detalhe)
    values (r.empresa_id, r.pc, r.impressora, 'fila',
            r.presos || ' presos ha ' || r.idade_min || ' min'
            || case when r.papel <> '' then ' (' || r.papel || ')' else '' end)
    on conflict (empresa_id, pc, impressora, tipo) where fechado_em is null
    do update set detalhe = excluded.detalhe;
  end loop;

  update impressora_incidente i
     set fechado_em = now()
   where i.tipo = 'fila'
     and i.fechado_em is null
     and not exists (
       select 1
         from impressora_saude s
         cross join lateral jsonb_array_elements(s.filas) f
        where s.empresa_id = i.empresa_id
          and s.pc = i.pc
          and f->>'nome' = i.impressora
          and s.visto_em > now() - interval '30 minutes'
          and coalesce((f->>'presos')::int, 0)    >= 2
          and coalesce((f->>'idade_min')::int, 0) >= 5
     );

  for r in
    select s.empresa_id, s.pc, e.nome as loja,
           round(extract(epoch from (now() - s.visto_em)) / 60)::int as calado_min
      from impressora_saude s
      join empresas e on e.id = s.empresa_id
     where s.visto_em < now() - interval '25 minutes'
       and not e.impressora_alerta_off
       and not (s.pc = any(v_ignorar))
       and loja_aberta_agora(e.id)
       and (
         exists (select 1 from comanda_itens c
                  where c.empresa_id = s.empresa_id
                    and c.created_at > now() - interval '45 minutes')
         or exists (select 1 from pedidos_delivery p
                     where p.empresa_id = s.empresa_id
                       and p.created_at > now() - interval '45 minutes')
       )
  loop
    insert into impressora_incidente (empresa_id, pc, impressora, tipo, detalhe)
    values (r.empresa_id, r.pc, '', 'mudo', 'sem noticia ha ' || r.calado_min || ' min')
    on conflict (empresa_id, pc, impressora, tipo) where fechado_em is null
    do update set detalhe = excluded.detalhe;
  end loop;

  update impressora_incidente i
     set fechado_em = now()
   where i.tipo = 'mudo'
     and i.fechado_em is null
     and exists (
       select 1 from impressora_saude s
        where s.empresa_id = i.empresa_id
          and s.pc = i.pc
          and s.visto_em > now() - interval '25 minutes'
     );

  with novos as (
    update impressora_incidente i
       set avisado_em = now()
      from empresas e
     where e.id = i.empresa_id
       and i.fechado_em is null
       and i.avisado_em is null
    returning i.tipo, i.pc, i.impressora, i.detalhe, e.nome as loja
  )
  select v_msgs || coalesce(jsonb_agg(
           case when n.tipo = 'fila' then
             '🖨️ *Impressora travada*' || chr(10) || chr(10) ||
             'Loja: ' || n.loja || chr(10) ||
             'Impressora: ' || n.impressora || chr(10) ||
             n.detalhe || chr(10) || chr(10) ||
             'O pedido NAO esta saindo.' || chr(10) ||
             'Na loja: desligar e ligar a impressora no botao.'
           else
             '🔌 *Impressora FWC sem resposta*' || chr(10) || chr(10) ||
             'Loja: ' || n.loja || chr(10) ||
             'PC: ' || n.pc || chr(10) ||
             n.detalhe || ', e a loja esta vendendo.' || chr(10) || chr(10) ||
             'Pode ser o app fechado, o PC desligado ou a internet.'
           end
         ), '[]'::jsonb)
    into v_msgs
    from novos n;

  with fim as (
    update impressora_incidente i
       set avisado_fim_em = now()
      from empresas e
     where e.id = i.empresa_id
       and i.fechado_em is not null
       and i.avisado_em is not null
       and i.avisado_fim_em is null
    returning i.tipo, i.impressora, e.nome as loja,
              round(extract(epoch from (i.fechado_em - i.aberto_em)) / 60)::int as durou
  )
  select v_msgs || coalesce(jsonb_agg(
           '✅ *Voltou ao normal*' || chr(10) || chr(10) ||
           f.loja || case when f.impressora <> '' then ' · ' || f.impressora else '' end ||
           chr(10) || 'Ficou ' || f.durou || ' min com problema.'
         ), '[]'::jsonb)
    into v_msgs
    from fim f;

  select valor into v_telefone from config_global where chave = 'aviso_fwc_destino';
  if v_telefone is null then
    select valor into v_telefone from config_global where chave = 'saude_alerta_phone';
  end if;

  return jsonb_build_object('telefone', v_telefone, 'mensagens', v_msgs);
end;
$function$;
