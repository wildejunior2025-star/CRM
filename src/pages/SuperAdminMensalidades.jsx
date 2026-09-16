import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { hojeBR } from '../lib/feriados'
import { faseDaMensalidade, dataCurtaBR, somaDiasYmd, valorPorSemana } from '../lib/mensalidade'
import '../components/Page.css'

// Super ADM: cobrança de cada loja (migs 0263/0264). Configura valor e dia,
// mostra quem deve e em que fase está, dá prazo, marca como paga à mão e
// guarda a prova de tudo que o lojista viu ou recebeu.

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const FASE = {
  sem_cobranca: { txt: 'Sem cobrança', cor: 'var(--text-muted)' },
  em_dia:       { txt: 'Em dia', cor: '#16a34a' },
  vence_hoje:   { txt: 'Vence hoje', cor: '#d97706' },
  carencia:     { txt: 'Atrasada (carência)', cor: '#dc2626' },
  prazo:        { txt: 'Prazo combinado', cor: '#7c3aed' },
  liberado:     { txt: '"Já paguei" (1h)', cor: '#7c3aed' },
  bloqueio:     { txt: 'BLOQUEADA', cor: '#fff', fundo: '#dc2626' },
}
const AVISO = {
  faixa_vence_hoje: 'Viu o aviso de vencimento', faixa_carencia: 'Viu o aviso de atraso', popup: 'Viu o pop-up de bloqueio',
  bloqueio_funcionario: 'Funcionário bloqueado', whatsapp_atraso: 'WhatsApp: atraso', whatsapp_bloqueio: 'WhatsApp: bloqueio',
  termo_aceito: 'Aceitou o termo', ja_paguei: 'Clicou "já paguei"', pix_gerado: 'Gerou PIX', pagou: 'Pagou',
  cartao_cadastrado: 'Cadastrou cartão', prazo: 'Prazo dado',
}

export default function SuperAdminMensalidades() {
  const [dados, setDados] = useState(null)
  const [aberta, setAberta] = useState(null)
  const hoje = hojeBR()

  const carregar = useCallback(async () => {
    await supabase.rpc('mensalidade_atualizar_todas')
    const [emp, cfg, cob, av, exc] = await Promise.all([
      supabase.from('empresas').select('id, nome, status, telefone_contato, horarios_funcionamento, feriados_fecha').order('nome'),
      supabase.from('mensalidade_config').select('*'),
      supabase.from('mensalidade_cobrancas').select('id, empresa_id, vencimento, referencia, valor, status, pago_em, forma, observacao')
        .gte('vencimento', somaDiasYmd(hoje, -120)).order('vencimento'),
      supabase.from('mensalidade_avisos').select('id, empresa_id, tipo, quem, detalhe, created_at')
        .order('created_at', { ascending: false }).limit(600),
      supabase.from('dias_excecao').select('empresa_id, data, aberto, periodos, motivo')
        .gte('data', somaDiasYmd(hoje, -60)).lte('data', somaDiasYmd(hoje, 45)),
    ])
    setDados({
      empresas: emp.data ?? [], config: Object.fromEntries((cfg.data ?? []).map(c => [c.empresa_id, c])),
      cobrancas: cob.data ?? [], avisos: av.data ?? [], excecoes: exc.data ?? [],
    })
  }, [hoje])

  useEffect(() => { carregar() }, [carregar])

  const linhas = useMemo(() => {
    if (!dados) return []
    return dados.empresas.map(e => {
      const cfg = dados.config[e.id]
      const abertas = dados.cobrancas.filter(c => c.empresa_id === e.id && c.status === 'aberta')
      const vencidas = abertas.filter(c => c.vencimento <= hoje)
      const excecoes = Object.fromEntries(dados.excecoes.filter(x => x.empresa_id === e.id).map(x => [x.data, x]))
      const situacao = cfg?.ativa ? {
        ativa: true, hoje, mais_antiga_vencida: vencidas[0]?.vencimento ?? null,
        carencia_dias: cfg.carencia_dias, prazo_ate: cfg.prazo_ate,
        liberado_ate: cfg.liberado_ate && new Date(cfg.liberado_ate) > new Date() ? cfg.liberado_ate : null,
      } : null
      const estado = faseDaMensalidade(situacao, { grade: e.horarios_funcionamento, excecoes, fechaFeriado: !!e.feriados_fecha })
      const avisos = dados.avisos.filter(a => a.empresa_id === e.id)
      const ultimoVisto = avisos.find(a => ['faixa_vence_hoje', 'faixa_carencia', 'popup'].includes(a.tipo))
      return { e, cfg, abertas, vencidas, total: vencidas.reduce((s, c) => s + Number(c.valor), 0), estado, avisos, ultimoVisto,
        pagas: dados.cobrancas.filter(c => c.empresa_id === e.id && c.status === 'paga') }
    }).sort((a, b) => (b.total - a.total) || String(a.e.nome).localeCompare(String(b.e.nome)))
  }, [dados, hoje])

  if (!dados) return <div className="empty-state">Carregando...</div>

  const totalAberto = linhas.reduce((s, l) => s + l.total, 0)
  const bloqueadas = linhas.filter(l => l.estado.fase === 'bloqueio').length

  return (
    <div>
      <div className="page-header"><h1>Mensalidades</h1></div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Resumo titulo="Em aberto (vencido)" valor={fmt(totalAberto)} cor="#dc2626" />
        <Resumo titulo="Lojas bloqueadas agora" valor={bloqueadas} cor={bloqueadas ? '#dc2626' : 'var(--text)'} />
        <Resumo titulo="Lojas com cobrança ligada" valor={linhas.filter(l => l.cfg?.ativa).length} />
        <Resumo titulo="Receita por semana (ligadas)" valor={fmt(linhas.filter(l => l.cfg?.ativa).reduce((s, l) =>
          s + valorPorSemana(l.cfg), 0))} />
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 760 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: 12 }}>
              <th style={th}>Loja</th><th style={th}>Plano</th><th style={th}>Em aberto</th><th style={th}>Situação</th><th style={th}>Último aviso visto</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {linhas.map(l => (
              <FragmentoLoja key={l.e.id} l={l} hoje={hoje} aberta={aberta === l.e.id}
                alternar={() => setAberta(aberta === l.e.id ? null : l.e.id)} recarregar={carregar} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function FragmentoLoja({ l, hoje, aberta, alternar, recarregar }) {
  const { e, cfg, estado } = l
  const fase = FASE[estado.fase] ?? FASE.sem_cobranca
  const diaSemana = cfg?.inicio ? DIAS[new Date(`${cfg.inicio}T12:00:00`).getDay()] : null
  return (
    <>
      <tr style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }} onClick={alternar}>
        <td style={td}><strong>{e.nome}</strong><div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{e.status}</div></td>
        <td style={td}>
          {cfg?.ativa
            ? <>{fmt(cfg.valor)} / {cfg.periodicidade === 'semanal' ? `semana (${diaSemana})` : cfg.periodicidade === 'quinzenal' ? 'quinzena (dia 1 e 15)' : 'mês'}{cfg.mp_assinatura_id ? ' · 💳' : ''}</>
            : <span style={{ color: 'var(--text-muted)' }}>{cfg ? 'Desligada' : 'Não configurada'}</span>}
        </td>
        <td style={td}>{l.vencidas.length ? <strong style={{ color: '#dc2626' }}>{fmt(l.total)} <span style={{ fontWeight: 500 }}>({l.vencidas.length})</span></strong> : '—'}</td>
        <td style={td}>
          <span style={{ fontWeight: 800, color: fase.cor, background: fase.fundo, padding: fase.fundo ? '2px 8px' : 0, borderRadius: 6 }}>{fase.txt}</span>
          {estado.diaBloqueio && estado.fase !== 'bloqueio' && estado.fase !== 'em_dia' && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>trava na abertura de {dataCurtaBR(estado.diaBloqueio)}</div>
          )}
        </td>
        <td style={td}>
          {l.ultimoVisto
            ? <span style={{ fontSize: 12.5 }}>{new Date(l.ultimoVisto.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {l.ultimoVisto.quem}</span>
            : <span style={{ color: 'var(--text-muted)' }}>—</span>}
        </td>
        <td style={{ ...td, textAlign: 'right', color: 'var(--primary)', fontWeight: 700 }}>{aberta ? '▲' : '▼'}</td>
      </tr>
      {aberta && (
        <tr><td colSpan={6} style={{ padding: '4px 12px 16px', background: 'var(--surface-hover, rgba(255,255,255,.02))' }}>
          <Detalhe l={l} hoje={hoje} recarregar={recarregar} />
        </td></tr>
      )}
    </>
  )
}

function Detalhe({ l, hoje, recarregar }) {
  const { e, cfg } = l
  const [f, setF] = useState(() => ({
    ativa: cfg?.ativa ?? false, valor: cfg?.valor ?? '', periodicidade: cfg?.periodicidade ?? 'semanal',
    inicio: cfg?.inicio ?? '', carencia_dias: cfg?.carencia_dias ?? 2, desconto_antecipado: cfg?.desconto_antecipado ?? 0,
    observacao: cfg?.observacao ?? '',
  }))
  const [prazo, setPrazo] = useState(cfg?.prazo_ate ?? '')
  const [motivo, setMotivo] = useState(cfg?.prazo_motivo ?? '')
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg] = useState(null)
  const set = k => ev => setF(v => ({ ...v, [k]: ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value }))

  async function salvar() {
    setSalvando(true); setMsg(null)
    const { error } = await supabase.from('mensalidade_config').upsert({
      empresa_id: e.id, ativa: f.ativa, valor: Number(f.valor) || 0, periodicidade: f.periodicidade,
      inicio: f.inicio || null, carencia_dias: Number(f.carencia_dias) || 0, desconto_antecipado: Number(f.desconto_antecipado) || 0,
      observacao: f.observacao || null, atualizado_em: new Date().toISOString(),
    })
    if (error) { setSalvando(false); setMsg(error.message); return }
    // Mudou o plano (periodicidade, 1º vencimento ou valor): as cobranças FUTURAS
    // do plano antigo saem, e o sistema gera as do novo. Senão a loja ficava
    // com a semanal de 21/09 e a quinzenal do dia 15 ao mesmo tempo. O que já
    // venceu fica: é dívida de verdade.
    const mudouPlano = cfg && (cfg.periodicidade !== f.periodicidade || (cfg.inicio ?? '') !== (f.inicio || '')
      || Number(cfg.valor) !== (Number(f.valor) || 0))
    if (mudouPlano) {
      await supabase.from('mensalidade_cobrancas')
        .update({ status: 'cancelada', observacao: `Plano mudou para ${f.periodicidade} em ${dataCurtaBR(hoje)}` })
        .eq('empresa_id', e.id).eq('status', 'aberta').gt('vencimento', hoje)
    }
    setSalvando(false)
    recarregar()
  }

  async function darPrazo() {
    const { error } = await supabase.from('mensalidade_config')
      .update({ prazo_ate: prazo || null, prazo_motivo: motivo || null, atualizado_em: new Date().toISOString() }).eq('empresa_id', e.id)
    if (error) { setMsg(error.message); return }
    await supabase.from('mensalidade_avisos').insert({ empresa_id: e.id, tipo: 'prazo', quem: 'Super ADM',
      detalhe: prazo ? `Prazo até ${dataCurtaBR(prazo)}${motivo ? ` — ${motivo}` : ''}` : 'Prazo removido' })
    recarregar()
  }

  async function marcarPaga(c) {
    const obs = window.prompt(`Marcar "${c.referencia}" (${fmt(c.valor)}) como paga? Anote como foi pago:`, 'PIX direto')
    if (obs === null) return
    const { error } = await supabase.rpc('mensalidade_marcar_paga', { p_cobranca: c.id, p_obs: obs })
    if (error) { setMsg(error.message); return }
    recarregar()
  }

  // Abate da cobrança o que a FWC consumiu na loja (ou qualquer acerto). O
  // motivo fica escrito na cobrança, com o valor de antes e o de depois.
  async function abater(c) {
    const txt = window.prompt(`Quanto abater de "${c.referencia}" (${fmt(c.valor)})?`, '')
    if (txt === null) return
    const desconto = Math.round((parseFloat(String(txt).replace(/[^0-9,.-]/g, '').replace(',', '.')) || 0) * 100) / 100
    if (desconto <= 0) { setMsg('Valor inválido.'); return }
    const atual = Number(c.valor)
    if (desconto > atual) { setMsg(`O abatimento (${fmt(desconto)}) é maior que a cobrança (${fmt(atual)}).`); return }
    const motivo = window.prompt('Motivo do abatimento:', 'Compra na loja')
    if (motivo === null) return
    const novo = Math.round((atual - desconto) * 100) / 100
    const nota = `${dataCurtaBR(hoje)}: abatido ${fmt(desconto)} — ${motivo || 'sem motivo'} (${fmt(atual)} → ${fmt(novo)})`
    const { error } = await supabase.from('mensalidade_cobrancas')
      .update({ valor: novo, observacao: c.observacao ? `${c.observacao} · ${nota}` : nota })
      .eq('id', c.id).eq('status', 'aberta')
    if (error) { setMsg(error.message); return }
    // Abateu tudo: a cobrança está quitada.
    if (novo === 0) await supabase.rpc('mensalidade_marcar_paga', { p_cobranca: c.id, p_obs: `Abatimento: ${motivo}` })
    recarregar()
  }

  const tel =String(e.telefone_contato ?? '').replace(/\D/g, '')
  const textoZap = encodeURIComponent(
    `Olá, ${e.nome}! Aqui é a FWC Inter. A mensalidade do sistema está em aberto: ` +
    l.vencidas.map(c => `${c.referencia} (${fmt(c.valor)})`).join(', ') +
    `. Total ${fmt(l.total)}. Dá pra pagar direto no sistema, em Minha mensalidade, no PIX ou no cartão. Qualquer dúvida é só chamar!`)

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14, paddingTop: 10 }}>
      <div>
        <div style={subtitulo}>Cobrança</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, marginBottom: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={f.ativa} onChange={set('ativa')} style={{ width: 18, height: 18 }} /> Cobrança ligada
        </label>
        <div style={duas}>
          <label style={rotulo}>Valor (R$)<input style={campo} type="number" step="0.01" value={f.valor} onChange={set('valor')} /></label>
          <label style={rotulo}>Periodicidade
            <select style={campo} value={f.periodicidade} onChange={set('periodicidade')}>
              <option value="semanal">Semanal</option><option value="quinzenal">Quinzenal (dia 1 e 15)</option><option value="mensal">Mensal</option>
            </select>
          </label>
        </div>
        <div style={duas}>
          <label style={rotulo}>1º vencimento<input style={campo} type="date" value={f.inicio} onChange={set('inicio')} /></label>
          <label style={rotulo}>Carência (dias abertos)<input style={campo} type="number" min="0" max="30" value={f.carencia_dias} onChange={set('carencia_dias')} /></label>
        </div>
        {f.inicio && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          {f.periodicidade === 'semanal' ? `Vence toda ${DIAS[new Date(`${f.inicio}T12:00:00`).getDay()]}`
            : f.periodicidade === 'quinzenal' ? 'Vence todo dia 1 e dia 15 (o 1º vencimento vai pro próximo dia 1 ou 15)'
            : `Vence todo dia ${f.inicio.slice(8)}`}
        </div>}
        <label style={rotulo}>Desconto se pagar antes (R$)<input style={campo} type="number" step="0.01" value={f.desconto_antecipado} onChange={set('desconto_antecipado')} /></label>
        <label style={rotulo}>Observação<input style={campo} value={f.observacao} placeholder="ex.: inclui computador e impressora" onChange={set('observacao')} /></label>
        <button type="button" disabled={salvando} onClick={salvar} style={botao}>{salvando ? 'Salvando…' : 'Salvar'}</button>
        {msg && <div style={{ color: '#dc2626', fontSize: 12.5, marginTop: 6 }}>{msg}</div>}
        {cfg?.termo_aceito_em && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>✓ Termo aceito em {new Date(cfg.termo_aceito_em).toLocaleString('pt-BR')}</div>}
      </div>

      <div>
        <div style={subtitulo}>Em aberto</div>
        {!l.abertas.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nada em aberto.</div>}
        {l.abertas.map(c => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed var(--border)', fontSize: 13 }}>
            <span>{c.referencia}<br /><span style={{ color: c.vencimento <= hoje ? '#dc2626' : 'var(--text-muted)', fontSize: 12 }}>vence {dataCurtaBR(c.vencimento)} · {fmt(c.valor)}</span>
              {/abatido/.test(c.observacao ?? '') && (
                <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: 11.5 }}>
                  {c.observacao.split(' · ').filter(s => s.includes('abatido')).join(' · ')}
                </span>
              )}
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" onClick={() => abater(c)} style={botaoPequeno}>Abater</button>
              <button type="button" onClick={() => marcarPaga(c)} style={botaoPequeno}>Marcar paga</button>
            </span>
          </div>
        ))}
        {l.vencidas.length > 0 && tel && (
          <a href={`https://wa.me/${tel.startsWith('55') ? tel : `55${tel}`}?text=${textoZap}`} target="_blank" rel="noreferrer"
            style={{ ...botao, display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 10, background: '#16a34a' }}>
            Cobrar no WhatsApp
          </a>
        )}
        <div style={{ ...subtitulo, marginTop: 14 }}>Dar prazo</div>
        <div style={duas}>
          <input style={campo} type="date" value={prazo} onChange={ev => setPrazo(ev.target.value)} />
          <input style={campo} placeholder="motivo" value={motivo} onChange={ev => setMotivo(ev.target.value)} />
        </div>
        <button type="button" onClick={darPrazo} style={{ ...botao, background: '#7c3aed' }}>{prazo ? 'Salvar prazo' : 'Tirar prazo'}</button>
        {l.pagas.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          Últimas pagas: {l.pagas.slice(-4).reverse().map(c => `${dataCurtaBR(c.vencimento)} (${c.forma})`).join(' · ')}
        </div>}
      </div>

      <div>
        <div style={subtitulo}>Prova dos avisos</div>
        {!l.avisos.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum aviso ainda.</div>}
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {l.avisos.slice(0, 40).map(a => (
            <div key={a.id} style={{ fontSize: 12.5, padding: '5px 0', borderBottom: '1px dashed var(--border)' }}>
              <strong>{AVISO[a.tipo] ?? a.tipo}</strong> · {new Date(a.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              <div style={{ color: 'var(--text-muted)' }}>{a.quem}{a.detalhe ? ` — ${a.detalhe}` : ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Resumo({ titulo, valor, cor }) {
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{titulo}</div>
      <div style={{ fontSize: 22, fontWeight: 900, marginTop: 4, color: cor ?? 'var(--text)' }}>{valor}</div>
    </div>
  )
}

const th = { padding: '10px 12px', fontWeight: 700 }
const td = { padding: '10px 12px', verticalAlign: 'top' }
const subtitulo = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)', marginBottom: 8 }
const rotulo = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, marginBottom: 8 }
const duas = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }
const campo = { width: '100%', padding: '8px 10px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13.5, minWidth: 0 }
const botao = { width: '100%', padding: '9px 0', borderRadius: 9, border: 'none', cursor: 'pointer', background: 'var(--primary)', color: '#fff', fontWeight: 800, fontSize: 13.5 }
const botaoPequeno = { padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }
