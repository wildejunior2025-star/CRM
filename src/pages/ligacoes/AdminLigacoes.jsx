import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, fetchAll } from '../../lib/supabaseClient'
import { dataHora, digitos } from './util'

// Painel do dono (super admin) — mig 0292. Quatro abas:
//   Visitas   → o que foi marcado, pra montar a rota e dar baixa (fechou / não fechou)
//   Leads     → todas as lojas, com filtro e o histórico de cada ligação
//   Atendentes→ criar login, ligar/desligar, ver quanto cada uma fez
//   Importar  → sobe a planilha de lojas (CSV com ; ) sem duplicar nem apagar o andamento

const STATUS = {
  novo: 'Na fila',
  retornar: 'Ligar de novo',
  visita: 'Visita marcada',
  visitado: 'Visitou, não fechou',
  fechou: 'Fechou',
  sem_interesse: 'Sem interesse',
  sem_contato: 'Sem contato (3 tentativas)',
  numero_errado: 'Número errado',
}
const RESULTADO = {
  atendeu: 'Atendeu', nao_atendeu: 'Não atendeu', caixa_postal: 'Caixa postal',
  numero_errado: 'Número errado', dono_ausente: 'Dono ausente',
}
const DESFECHO = { visita: 'Marcou visita', retornar: 'Ligar depois', sem_interesse: 'Sem interesse' }
const TEMP = { quente: '🔥 Quente', morno: '🟡 Morno', frio: '🧊 Frio' }
const simNao = (v) => (v === true ? 'Sim' : v === false ? 'Não' : '—')

function inicioDoDia(d = new Date()) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function lerCsv(texto) {
  const t = texto.replace(/^\uFEFF/, '')
  const delim = (t.split('\n')[0].match(/;/g) || []).length >= (t.split('\n')[0].match(/,/g) || []).length ? ';' : ','
  const linhas = []
  let linha = [], cel = '', aspas = false
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (aspas) {
      if (c === '"') {
        if (t[i + 1] === '"') { cel += '"'; i++ } else aspas = false
      } else cel += c
    } else if (c === '"') aspas = true
    else if (c === delim) { linha.push(cel); cel = '' }
    else if (c === '\n') { linha.push(cel); linhas.push(linha); linha = []; cel = '' }
    else if (c !== '\r') cel += c
  }
  if (cel !== '' || linha.length) { linha.push(cel); linhas.push(linha) }
  if (!linhas.length) return []
  const cab = linhas[0].map((h) => h.trim().toLowerCase())
  return linhas.slice(1).filter((l) => l.some((x) => x.trim())).map((l) => {
    const o = {}
    cab.forEach((h, i) => { o[h] = (l[i] ?? '').trim() })
    return o
  })
}

function normaliza(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function paraLead(r) {
  const loja = r.loja || r.name || r.nome
  if (!loja) return null
  const tel = r.telefone || r.phone || ''
  const lead = {
    chave: normaliza(loja) + '|' + digitos(tel),
    loja,
    telefone: tel || null,
  }
  const opc = {
    tipo: r.tipo, bairro: r.bairro, cidade: r.cidade, endereco: r.endereco, site: r.site,
    link_maps: r.link_maps, cnpj: r.cnpj, razao_social: r.razao_social, nome_dono: r.nome_dono,
  }
  for (const [k, v] of Object.entries(opc)) if (v) lead[k] = v
  const nota = parseFloat(String(r.nota || '').replace(',', '.'))
  if (!Number.isNaN(nota)) lead.nota = nota
  const av = parseInt(r.avaliacoes, 10)
  if (!Number.isNaN(av)) lead.avaliacoes = av
  return lead
}

// ── Abas ──────────────────────────────────────────────────────────────────────
function AbaVisitas({ leads, atendentes, recarregar }) {
  const nomeAt = useMemo(() => Object.fromEntries(atendentes.map((a) => [a.user_id, a.nome])), [atendentes])
  const marcadas = leads.filter((l) => l.status === 'visita').sort((a, b) => new Date(a.visita_em) - new Date(b.visita_em))
  const feitas = leads.filter((l) => l.status === 'visitado' || l.status === 'fechou')
  const hoje = inicioDoDia()

  async function darBaixa(l, status) {
    const { error } = await supabase.from('tm_leads').update({ status, atualizado_em: new Date().toISOString() }).eq('id', l.id)
    if (error) alert(error.message); else recarregar()
  }
  async function cancelar(l) {
    if (!window.confirm('Cancelar essa visita e devolver a loja pra fila?')) return
    const { error } = await supabase.from('tm_leads')
      .update({ status: 'novo', visita_em: null, visita_quem: null, tentativas: 0, proxima_em: null, atualizado_em: new Date().toISOString() })
      .eq('id', l.id)
    if (error) alert(error.message); else recarregar()
  }

  const grupos = []
  for (const l of marcadas) {
    const dia = new Date(l.visita_em).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })
    let g = grupos.find((x) => x.dia === dia)
    if (!g) { g = { dia, itens: [] }; grupos.push(g) }
    g.itens.push(l)
  }

  return (
    <div>
      <div className="lg-chips lg-mb">
        <span className="lg-chip">📅 {marcadas.length} marcadas</span>
        <span className="lg-chip">✅ {feitas.filter((l) => l.status === 'fechou').length} fecharam</span>
        <span className="lg-chip">🚶 {feitas.filter((l) => l.status === 'visitado').length} visitadas sem fechar</span>
      </div>
      {!marcadas.length && <p className="lg-muted">Nenhuma visita marcada ainda.</p>}
      {grupos.map((g) => (
        <section key={g.dia} className="lg-grupo">
          <h3 className="lg-h lg-cap">{g.dia}</h3>
          {g.itens.map((l) => {
            const atrasada = new Date(l.visita_em) < hoje
            return (
              <article key={l.id} className={'lg-card lg-visita' + (atrasada ? ' lg-atrasada' : '')}>
                <div className="lg-linha">
                  <strong>{new Date(l.visita_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} — {l.loja}</strong>
                  {atrasada && <span className="lg-tag lg-tag-warn">dar baixa</span>}
                </div>
                <div className="lg-muted">{[l.bairro, l.cidade].filter(Boolean).join(' · ')} — {l.endereco}</div>
                <div className="lg-muted">
                  📞 {l.telefone}
                  {(l.visita_quem || l.nome_dono) ? ` · 👤 ${l.visita_quem || l.nome_dono}` : ''}
                </div>
                <div className="lg-muted lg-peq">
                  Sistema: {l.usa_sistema === true ? (l.qual_sistema || 'sim') : l.usa_sistema === false ? 'não usa' : '—'}
                  {' · '}iFood: {simNao(l.vende_ifood)}
                  {' · '}Marcou: {nomeAt[l.ultimo_atendente_id] || '—'}
                </div>
                <div className="lg-botoes">
                  {l.link_maps && <a className="btn btn-secondary btn-sm" href={l.link_maps} target="_blank" rel="noreferrer">🗺 Mapa</a>}
                  <button className="btn btn-primary btn-sm" onClick={() => darBaixa(l, 'fechou')}>✅ Fechou</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => darBaixa(l, 'visitado')}>🚶 Visitei, não fechou</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => cancelar(l)}>Cancelar</button>
                </div>
              </article>
            )
          })}
        </section>
      ))}
    </div>
  )
}

function Historico({ leadId, nomeAt }) {
  const [itens, setItens] = useState(null)
  useEffect(() => {
    supabase.from('tm_ligacoes').select('*').eq('lead_id', leadId).order('criado_em', { ascending: false })
      .then(({ data }) => setItens(data || []))
  }, [leadId])
  if (!itens) return <div className="lg-muted lg-peq">Carregando histórico...</div>
  if (!itens.length) return <div className="lg-muted lg-peq">Ainda sem ligações.</div>
  return (
    <ul className="lg-hist">
      {itens.map((h) => (
        <li key={h.id}>
          <b>{dataHora(h.criado_em)}</b> · {nomeAt[h.atendente_id] || '—'} · {RESULTADO[h.resultado]}
          {h.desfecho && ` → ${DESFECHO[h.desfecho]}`}
          {h.resultado === 'atendeu' && (
            <div className="lg-peq lg-muted">
              Sistema: {h.usa_sistema === true ? (h.qual_sistema || 'sim') : simNao(h.usa_sistema)} · iFood: {simNao(h.vende_ifood)}
              {h.quem_atende ? ` · WhatsApp: ${h.quem_atende}${h.quem_atende_nome ? ' (' + h.quem_atende_nome + ')' : ''}` : ''}
              {h.entregador_proprio !== null ? ` · Entregador próprio: ${simNao(h.entregador_proprio)}` : ''}
            </div>
          )}
          {h.motivo_nao && <div className="lg-peq lg-muted">Motivo: {h.motivo_nao}</div>}
          {h.observacao && <div className="lg-peq">📝 {h.observacao}</div>}
        </li>
      ))}
    </ul>
  )
}

function AbaLeads({ leads, atendentes, recarregar }) {
  const nomeAt = useMemo(() => Object.fromEntries(atendentes.map((a) => [a.user_id, a.nome])), [atendentes])
  const [status, setStatus] = useState('')
  const [temp, setTemp] = useState('')
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState(null)
  const [limite, setLimite] = useState(60)

  const lista = useMemo(() => {
    const b = normaliza(busca)
    return leads.filter((l) => (!status || l.status === status)
      && (!temp || l.temperatura === temp)
      && (!b || normaliza(l.loja + ' ' + (l.bairro || '') + ' ' + (l.telefone || '') + ' ' + (l.nome_dono || '')).includes(b)))
  }, [leads, status, temp, busca])

  async function reabrir(l) {
    const { error } = await supabase.from('tm_leads')
      .update({ status: 'novo', tentativas: 0, proxima_em: null, atendente_id: null, pego_em: null, atualizado_em: new Date().toISOString() })
      .eq('id', l.id)
    if (error) alert(error.message); else recarregar()
  }

  return (
    <div>
      <div className="lg-filtros">
        <input className="lg-in" placeholder="Buscar loja, bairro, telefone ou dono" value={busca} onChange={(e) => { setBusca(e.target.value); setLimite(60) }} />
        <select className="lg-in" value={status} onChange={(e) => { setStatus(e.target.value); setLimite(60) }}>
          <option value="">Todos os status</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="lg-in" value={temp} onChange={(e) => { setTemp(e.target.value); setLimite(60) }}>
          <option value="">Qualquer temperatura</option>
          {Object.entries(TEMP).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <p className="lg-muted lg-peq">{lista.length} lojas</p>
      {lista.slice(0, limite).map((l) => (
        <article key={l.id} className="lg-card lg-lead">
          <button className="lg-lead-cab" onClick={() => setAberto(aberto === l.id ? null : l.id)}>
            <span><strong>{l.loja}</strong><br /><span className="lg-muted lg-peq">{[l.bairro, l.cidade].filter(Boolean).join(' · ')} · {l.telefone || 'sem telefone'}</span></span>
            <span className="lg-lead-dir">
              <span className="lg-tag">{STATUS[l.status]}</span>
              {l.temperatura && <span className="lg-peq">{TEMP[l.temperatura]}</span>}
            </span>
          </button>
          {aberto === l.id && (
            <div className="lg-lead-det">
              <div className="lg-peq">
                Sistema: {l.usa_sistema === true ? (l.qual_sistema || 'sim') : simNao(l.usa_sistema)} · iFood: {simNao(l.vende_ifood)}
                {l.nome_dono ? ` · Dono: ${l.nome_dono}` : ''}
                {l.cnpj ? ` · CNPJ: ${l.cnpj}` : ''}
                {l.visita_em ? ` · Visita: ${dataHora(l.visita_em)}` : ''}
                {l.motivo_nao ? ` · Motivo do não: ${l.motivo_nao}` : ''}
              </div>
              <Historico leadId={l.id} nomeAt={nomeAt} />
              <div className="lg-botoes">
                {l.link_maps && <a className="btn btn-secondary btn-sm" href={l.link_maps} target="_blank" rel="noreferrer">🗺 Mapa</a>}
                {!['novo', 'retornar'].includes(l.status) && (
                  <button className="btn btn-secondary btn-sm" onClick={() => reabrir(l)}>Devolver pra fila</button>
                )}
              </div>
            </div>
          )}
        </article>
      ))}
      {lista.length > limite && <button className="btn btn-secondary" onClick={() => setLimite(limite + 60)}>Ver mais</button>}
    </div>
  )
}

function AbaAtendentes({ atendentes, ligacoes, recarregar }) {
  const [nome, setNome] = useState('')
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [msg, setMsg] = useState(null)

  const hoje = inicioDoDia().getTime()
  const semana = hoje - 6 * 86400000
  const conta = (id, desde) => {
    const l = ligacoes.filter((x) => x.atendente_id === id && new Date(x.criado_em).getTime() >= desde)
    return { n: l.length, at: l.filter((x) => x.resultado === 'atendeu').length, v: l.filter((x) => x.desfecho === 'visita').length }
  }

  async function chamar(corpo) {
    const { data, error } = await supabase.functions.invoke('tm-atendente', { body: corpo })
    if (error || !data?.ok) return { ok: false, erro: data?.error || error?.message || 'Erro' }
    return { ok: true }
  }

  async function criar(e) {
    e.preventDefault()
    setEnviando(true); setMsg(null)
    const r = await chamar({ acao: 'criar', nome, email, password: senha })
    setEnviando(false)
    if (!r.ok) { setMsg({ erro: true, t: r.erro }); return }
    setMsg({ t: `Pronto! ${nome} já pode entrar com ${email.trim().toLowerCase()} e a senha que você definiu.` })
    setNome(''); setEmail(''); setSenha('')
    recarregar()
  }

  async function alternar(a) {
    const { error } = await supabase.from('tm_atendentes').update({ ativo: !a.ativo }).eq('user_id', a.user_id)
    if (error) alert(error.message); else recarregar()
  }

  async function novaSenha(a) {
    const s = window.prompt(`Nova senha para ${a.nome} (mínimo 6 caracteres):`)
    if (!s) return
    const r = await chamar({ acao: 'senha', user_id: a.user_id, password: s })
    alert(r.ok ? 'Senha trocada.' : r.erro)
  }

  return (
    <div>
      <form className="lg-card lg-form" onSubmit={criar}>
        <h3 className="lg-h">Nova atendente</h3>
        <label>Nome<input value={nome} onChange={(e) => setNome(e.target.value)} required /></label>
        <label>E-mail (é o login dela)<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Senha (mínimo 6)<input value={senha} onChange={(e) => setSenha(e.target.value)} minLength={6} required /></label>
        {msg && <div className={msg.erro ? 'lg-erro' : 'lg-ok'}>{msg.t}</div>}
        <button className="btn btn-primary" disabled={enviando}>{enviando ? 'Criando...' : 'Criar atendente'}</button>
        <p className="lg-muted lg-peq">Ela entra no mesmo endereço desta página e só vê a loja que está ligando.</p>
      </form>

      {atendentes.map((a) => {
        const h = conta(a.user_id, hoje)
        const s = conta(a.user_id, semana)
        return (
          <article key={a.user_id} className={'lg-card' + (a.ativo ? '' : ' lg-off')}>
            <div className="lg-linha">
              <strong>{a.nome}</strong>
              <span className="lg-tag">{a.ativo ? 'ativa' : 'desligada'}</span>
            </div>
            <div className="lg-muted lg-peq">Hoje: {h.n} ligações · {h.at} atenderam · {h.v} visitas</div>
            <div className="lg-muted lg-peq">7 dias: {s.n} ligações · {s.at} atenderam · {s.v} visitas</div>
            <div className="lg-botoes">
              <button className="btn btn-secondary btn-sm" onClick={() => alternar(a)}>{a.ativo ? 'Desligar' : 'Religar'}</button>
              <button className="btn btn-secondary btn-sm" onClick={() => novaSenha(a)}>Trocar senha</button>
            </div>
          </article>
        )
      })}
      {!atendentes.length && <p className="lg-muted">Nenhuma atendente ainda.</p>}
    </div>
  )
}

function AbaImportar({ recarregar }) {
  const [linhas, setLinhas] = useState(null)
  const [arquivo, setArquivo] = useState('')
  const [fazendo, setFazendo] = useState(false)
  const [msg, setMsg] = useState(null)

  async function aoEscolher(e) {
    const f = e.target.files?.[0]
    if (!f) return
    setArquivo(f.name); setMsg(null)
    const texto = await f.text()
    const leads = lerCsv(texto).map(paraLead).filter(Boolean)
    // mesma loja+telefone repetida no arquivo: fica a última
    setLinhas([...new Map(leads.map((l) => [l.chave, l])).values()])
  }

  async function importar() {
    setFazendo(true); setMsg(null)
    // Linhas com colunas diferentes vão em lotes separados: o upsert em lote
    // preenche com NULL a coluna que faltar, e isso apagaria o nome do dono que
    // uma atendente anotou numa ligação.
    const porForma = new Map()
    for (const l of linhas) {
      const k = Object.keys(l).sort().join(',')
      if (!porForma.has(k)) porForma.set(k, [])
      porForma.get(k).push(l)
    }
    let feitos = 0
    for (const grupo of porForma.values()) {
      for (let i = 0; i < grupo.length; i += 200) {
        const { error } = await supabase.from('tm_leads').upsert(grupo.slice(i, i + 200), { onConflict: 'chave' })
        if (error) { setMsg({ erro: true, t: error.message }); setFazendo(false); return }
        feitos += Math.min(200, grupo.length - i)
      }
    }
    setFazendo(false)
    setMsg({ t: `${feitos} lojas processadas. As que já existiam mantiveram o andamento.` })
    setLinhas(null); setArquivo('')
    recarregar()
  }

  const semTel = linhas ? linhas.filter((l) => !digitos(l.telefone)).length : 0
  return (
    <div className="lg-card lg-form">
      <h3 className="lg-h">Importar lojas</h3>
      <p className="lg-muted lg-peq">
        Arquivo CSV (separado por ponto e vírgula) com as colunas: loja, telefone, tipo, bairro, cidade, endereco, nota,
        avaliacoes, site, link_maps. Pode ter também cnpj, razao_social e nome_dono. Subir de novo a mesma loja não duplica
        nem zera o andamento dela.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={aoEscolher} />
      {linhas && (
        <>
          <p><b>{arquivo}</b>: {linhas.length} lojas ({semTel} sem telefone — essas não entram na fila de ligação).</p>
          <button className="btn btn-primary" disabled={fazendo} onClick={importar}>{fazendo ? 'Importando...' : `Importar ${linhas.length} lojas`}</button>
        </>
      )}
      {msg && <div className={msg.erro ? 'lg-erro' : 'lg-ok'}>{msg.t}</div>}
    </div>
  )
}

// ── Hoje ──────────────────────────────────────────────────────────────────────
// O dia de trabalho num lugar só: quantas ligações, como terminaram e o que as
// atendentes anotaram. Dá pra voltar a qualquer dia.
function AbaHoje({ atendentes }) {
  const nomeAt = useMemo(() => Object.fromEntries(atendentes.map((a) => [a.user_id, a.nome])), [atendentes])
  const [dia, setDia] = useState(() => new Date().toLocaleDateString('sv-SE')) // aaaa-mm-dd, hora do aparelho
  const [linhas, setLinhas] = useState(null)

  useEffect(() => {
    let ativo = true
    const ini = new Date(dia + 'T00:00:00')
    const fim = new Date(ini)
    fim.setDate(fim.getDate() + 1)
    supabase.from('tm_ligacoes')
      .select('*, tm_leads(loja, bairro, telefone, nome_dono)')
      .gte('criado_em', ini.toISOString()).lt('criado_em', fim.toISOString())
      .order('criado_em', { ascending: false }).limit(1000)
      .then(({ data }) => { if (ativo) setLinhas(data || []) })
    return () => { ativo = false }
  }, [dia])

  const hora = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const total = linhas?.length || 0
  const por = (r) => (linhas || []).filter((x) => x.resultado === r).length
  const comObs = (linhas || []).filter((x) => (x.observacao || '').trim())
  const atenderam = (linhas || []).filter((x) => x.resultado === 'atendeu')
  const visitas = (linhas || []).filter((x) => x.desfecho === 'visita').length
  const obsOutras = comObs.filter((x) => x.resultado !== 'atendeu')

  return (
    <div>
      <label className="lg-dia">Dia
        <input type="date" value={dia} onChange={(e) => e.target.value && setDia(e.target.value)} />
      </label>
      {!linhas ? <p className="lg-muted">Carregando...</p> : (
        <>
          <div className="lg-numeros">
            <div className="lg-num"><b>{total}</b><span>ligações</span></div>
            <div className="lg-num"><b>{atenderam.length}</b><span>atenderam</span></div>
            <div className="lg-num"><b>{visitas}</b><span>visitas</span></div>
            <div className="lg-num"><b>{comObs.length}</b><span>com observação</span></div>
          </div>
          <div className="lg-chips lg-mb">
            <span className="lg-chip">📭 {por('caixa_postal')} caixa postal</span>
            <span className="lg-chip">🔕 {por('nao_atendeu')} não atendeu</span>
            <span className="lg-chip">🚪 {por('dono_ausente')} dono ausente</span>
            <span className="lg-chip">❌ {por('numero_errado')} número errado</span>
          </div>
          {!total && <p className="lg-muted">Nenhuma ligação nesse dia.</p>}

          {atenderam.length > 0 && (
            <section className="lg-grupo">
              <h3 className="lg-h">Quem atendeu</h3>
              {atenderam.map((x) => (
                <article key={x.id} className="lg-card lg-visita">
                  <div className="lg-linha">
                    <strong>{hora(x.criado_em)} — {x.tm_leads?.loja}</strong>
                    <span className="lg-tag">{x.desfecho ? DESFECHO[x.desfecho] : 'sem desfecho'}</span>
                  </div>
                  <div className="lg-muted lg-peq">
                    Sistema: {x.usa_sistema === true ? (x.qual_sistema || 'sim') : simNao(x.usa_sistema)} · iFood: {simNao(x.vende_ifood)}
                    {x.quem_atende ? ` · WhatsApp: ${x.quem_atende}` : ''} · {nomeAt[x.atendente_id] || '—'}
                  </div>
                  {x.motivo_nao && <div className="lg-peq lg-muted">Motivo: {x.motivo_nao}</div>}
                  {x.observacao && <div className="lg-peq">📝 {x.observacao}</div>}
                </article>
              ))}
            </section>
          )}

          {obsOutras.length > 0 && (
            <section className="lg-grupo">
              <h3 className="lg-h">Observações das outras ligações</h3>
              {obsOutras.map((x) => (
                <article key={x.id} className="lg-card lg-visita">
                  <div className="lg-linha">
                    <strong>{hora(x.criado_em)} — {x.tm_leads?.loja}</strong>
                    <span className="lg-tag">{RESULTADO[x.resultado]}</span>
                  </div>
                  <div className="lg-peq">📝 {x.observacao}</div>
                  {x.melhor_horario && <div className="lg-peq lg-muted">Melhor horário: {x.melhor_horario}</div>}
                </article>
              ))}
            </section>
          )}

          {total > 0 && (
            <details className="lg-card">
              <summary><b>Todas as ligações do dia ({total})</b></summary>
              <ul className="lg-hist">
                {linhas.map((x) => (
                  <li key={x.id}>
                    <b>{hora(x.criado_em)}</b> · {x.tm_leads?.loja} · {RESULTADO[x.resultado]}
                    {x.desfecho ? ` → ${DESFECHO[x.desfecho]}` : ''} · {nomeAt[x.atendente_id] || '—'}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  )
}

// ── Casca ─────────────────────────────────────────────────────────────────────
export default function AdminLigacoes({ onSair, embutido = false }) {
  const [aba, setAba] = useState('hoje')
  const [leads, setLeads] = useState([])
  const [atendentes, setAtendentes] = useState([])
  const [ligacoes, setLigacoes] = useState([])
  const [carregando, setCarregando] = useState(true)

  const carregar = useCallback(async () => {
    const [l, a, c] = await Promise.all([
      fetchAll(() => supabase.from('tm_leads').select('*').order('criado_em').order('id')),
      supabase.from('tm_atendentes').select('*').order('criado_em'),
      fetchAll(() => supabase.from('tm_ligacoes').select('id,lead_id,atendente_id,criado_em,resultado,desfecho').order('criado_em').order('id')),
    ])
    setLeads(l.data || [])
    setAtendentes(a.data || [])
    setLigacoes(c.data || [])
    setCarregando(false)
  }, [])

  useEffect(() => { carregar() }, [carregar])

  const naFila = leads.filter((l) => ['novo', 'retornar'].includes(l.status) && l.telefone && l.tentativas < 3).length
  const quentes = leads.filter((l) => l.status === 'visita').length

  const abas = [['hoje', 'Hoje'], ['visitas', `Visitas (${quentes})`], ['leads', 'Leads'], ['atendentes', 'Atendentes'], ['importar', 'Importar']]

  return (
    <div className={'lg-tela lg-larga' + (embutido ? ' lg-embutido' : '')}>
      {embutido ? (
        <>
          <h1 className="page-title">Ligações</h1>
          <p className="lg-resumo lg-mb">{leads.length} lojas · {naFila} na fila · {quentes} visitas marcadas</p>
        </>
      ) : (
        <header className="lg-topo">
          <div>
            <strong>Ligações — painel</strong>
            <div className="lg-resumo">{leads.length} lojas · {naFila} na fila · {quentes} visitas marcadas</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={onSair}>Sair</button>
        </header>
      )}
      <nav className="lg-abas">
        {abas.map(([k, t]) => (
          <button key={k} className={'lg-aba' + (aba === k ? ' lg-aba-on' : '')} onClick={() => setAba(k)}>{t}</button>
        ))}
      </nav>
      {carregando ? <p className="lg-muted">Carregando...</p> : (
        <>
          {aba === 'hoje' && <AbaHoje atendentes={atendentes} />}
          {aba === 'visitas' && <AbaVisitas leads={leads} atendentes={atendentes} recarregar={carregar} />}
          {aba === 'leads' && <AbaLeads leads={leads} atendentes={atendentes} recarregar={carregar} />}
          {aba === 'atendentes' && <AbaAtendentes atendentes={atendentes} ligacoes={ligacoes} recarregar={carregar} />}
          {aba === 'importar' && <AbaImportar recarregar={carregar} />}
        </>
      )}
    </div>
  )
}
