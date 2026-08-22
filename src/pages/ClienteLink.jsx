import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import ModalComplementos, { btnQtd as btnQ } from '../components/ModalComplementos'
import SenhaCliente from '../components/SenhaCliente'
import { carregarCardapio, itensParaPedido } from '../lib/cardapioPublico'
import { comoFicaNoDia } from '../lib/feriados'

// LINK DO CLIENTE (mig 0147) — a página que o freguês abre pelo link só dele.
// Sem login: quem identifica é o token na URL. Três abas:
//   Cardápio     → monta o pedido; ao enviar vira uma comanda no nome dele
//   Meu pedido   → o que está na cozinha agora, ao vivo
//   Minha conta  → o que ele deve e o que já pagou (o fiado, sem precisar perguntar)
//
// Mesmo cardápio e mesmo modal de montagem do QR da mesa (lib/cardapioPublico e
// components/ModalComplementos) — se mudar o cardápio, muda nos dois.

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
const dataBR = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
// Quantidade vem numérica do banco ("2.00") — mostra 2, e 0,5 quando for meio.
const qtdBR = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })
// No histórico a hora importa: é assim que ele acha a compra na fatura do cartão.
const dataHoraBR = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
const FORMAS = { debito: 'débito', credito: 'crédito', dinheiro: 'dinheiro', pix: 'PIX', a_vista: 'à vista', fiado: 'fiado', voucher: 'voucher' }
const formaBR = (f) => FORMAS[f] ?? String(f ?? '').replace(/_/g, ' ')
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

export default function ClienteLink() {
  const { token } = useParams()
  const [info, setInfo] = useState(null)
  const [produtos, setProdutos] = useState([])
  const [catOrdem, setCatOrdem] = useState({})
  const [compMap, setCompMap] = useState({})
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const [aba, setAba] = useState('cardapio')      // cardapio | pedido | conta
  const [busca, setBusca] = useState('')
  const [cat, setCat] = useState('Todos')
  const [carrinho, setCarrinho] = useState({})
  const [montando, setMontando] = useState(null)
  const [drawer, setDrawer] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [sucesso, setSucesso] = useState(false)
  const [conta, setConta] = useState(null)        // cliente_conta(): comanda + fiado
  const [histAberto, setHistAberto] = useState(null)  // qual compra do histórico está aberta
  const [notif, setNotif] = useState(null)
  const prevPronto = useRef(new Set())

  // Senha de 6 números (mig 0175). `senhaModo` null = popup fechado.
  const [senhaModo, setSenhaModo] = useState(null)   // null | 'criar' | 'digitar'
  const [senhaErro, setSenhaErro] = useState(null)

  // PIX do fiado (mig 0149): ele escolhe o valor, o sistema gera o QR e fica
  // esperando o Mercado Pago confirmar. A baixa é automática, no webhook.
  const [showPix, setShowPix] = useState(false)
  const [pixValor, setPixValor] = useState('')
  const [pixGerando, setPixGerando] = useState(false)
  const [pixErro, setPixErro] = useState(null)
  const [pix, setPix] = useState(null)            // { cobranca_id, valor, qr_code, qr_code_base64 }
  const [pixPago, setPixPago] = useState(false)
  const [copiado, setCopiado] = useState(false)

  function avisar() {
    try { navigator.vibrate?.([200, 100, 200]) } catch { /* sem vibração */ }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination); o.type = 'sine'; o.frequency.value = 880
      g.gain.setValueAtTime(0.001, ctx.currentTime)
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4)
      o.start(); o.stop(ctx.currentTime + 0.4)
    } catch { /* áudio bloqueado */ }
  }

  async function fetchConta() {
    const { data } = await supabase.rpc('cliente_conta', { p_token: token })
    setConta(data || null)
    const prontos = new Set((data?.comanda?.itens ?? []).filter(i => i.status === 'pronto').map(i => i.id))
    let novo = false
    prontos.forEach(id => { if (!prevPronto.current.has(id)) novo = true })
    prevPronto.current = prontos
    if (novo) { setNotif('🔔 Seu pedido ficou pronto!'); avisar() }
  }

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('cliente_info', { p_token: token })
      if (error || !data) { setErro('Link não encontrado. Peça um novo pra loja.'); setLoading(false); return }
      if (!data.link_ativo) { setErro('A loja não está usando pedido por link agora.'); setLoading(false); return }
      setInfo(data)
      const { produtos: ps, catOrdem: om, compMap: cm } = await carregarCardapio(supabase, data.empresa_id)
      setProdutos(ps); setCatOrdem(om); setCompMap(cm)
      setLoading(false)
    })()
  }, [token])

  // Acompanha a comanda ao vivo (e avisa quando a cozinha dá o pronto)
  useEffect(() => {
    if (!info) return
    fetchConta()
    const t = setInterval(fetchConta, 8000)
    return () => clearInterval(t)
  }, [info])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notif) return
    const t = setTimeout(() => setNotif(null), 8000)
    return () => clearTimeout(t)
  }, [notif])

  // Loja aberta? Quem manda é o banco (a RPC recusa fora do horário); aqui é só
  // pra avisar antes, e pra tratar o feriado, que é calculado no app.
  const situacao = useMemo(() => {
    if (!info) return { aberto: false }
    const hoje = new Date()
    const ymd = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`
    const noApp = comoFicaNoDia(ymd, { grade: info.grade, excecoes: {}, fechaFeriado: info.fecha_feriado })
    return { aberto: !!info.aberta_agora && noApp.aberto !== false, motivo: noApp.motivo }
  }, [info])

  const ordemCat = (nome) => catOrdem[nome] ?? 999
  const categorias = useMemo(() => {
    const nomes = [...new Set(produtos.map(p => p.categoria).filter(Boolean))]
      .sort((a, b) => (ordemCat(a) - ordemCat(b)) || a.localeCompare(b))
    return ['Todos', ...nomes]
  }, [produtos, catOrdem]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtrados = produtos
    .filter(p => {
      const okCat = cat === 'Todos' || p.categoria === cat
      const t = busca.trim().toLowerCase()
      return okCat && (!t || p.nome?.toLowerCase().includes(t))
    })
    .sort((a, b) => {
      const oa = ordemCat(a.categoria), ob = ordemCat(b.categoria)
      if (oa !== ob) return oa - ob
      const porCategoria = (a.categoria ?? '').localeCompare(b.categoria ?? '')
      return porCategoria !== 0 ? porCategoria : (a.nome ?? '').localeCompare(b.nome ?? '')
    })

  const itens = Object.entries(carrinho).map(([id, v]) => ({ id, ...v }))
  const totalItens = itens.reduce((s, i) => s + i.qtd, 0)
  const totalValor = itens.reduce((s, i) => s + i.qtd * i.preco, 0)

  function add(p) {
    if (compMap[p.produto_id]?.length) { setMontando(p); return }
    setCarrinho(c => ({ ...c, [p.produto_id]: {
      produto_id: p.produto_id, nome: p.nome, preco: Number(p.preco_venda),
      qtd: (c[p.produto_id]?.qtd ?? 0) + 1, complementos: [],
    } }))
  }
  function addComplemento(produto, complementos, precoUnit) {
    const key = `${produto.produto_id}::${complementos.map(c => c.nome).join(',')}`
    setCarrinho(c => ({ ...c, [key]: {
      produto_id: produto.produto_id, nome: produto.nome, preco: precoUnit,
      qtd: (c[key]?.qtd ?? 0) + 1, complementos,
    } }))
    setMontando(null)
  }
  function mudar(id, d) {
    setCarrinho(c => {
      const q = (c[id]?.qtd ?? 0) + d
      if (q <= 0) { const n = { ...c }; delete n[id]; return n }
      return { ...c, [id]: { ...c[id], qtd: q } }
    })
  }

  // ── Envio do pedido, com a senha de 6 números (mig 0175) ─────────────────
  //
  // A senha é pedida AQUI, no fim, e não na abertura da página: com o carrinho
  // montado quase ninguém desiste por seis números, então na prática todo mundo
  // acaba criando uma. Pedir na entrada derrubaria o pedido por link.
  //
  // O servidor é quem manda: devolve SENHA_AUSENTE (nunca criou) ou SENHA_ERRADA
  // (errou), e a tela só decide qual popup abrir. Assim a regra mora num lugar
  // só e não dá pra pular a senha mexendo no navegador.
  async function enviar(senha) {
    setEnviando(true); setSenhaErro(null)
    const { data, error } = await supabase.rpc('cliente_pedir', {
      p_token: token, p_itens: itensParaPedido(itens), p_senha: senha ?? null,
    })
    setEnviando(false)

    if (error) {
      const m = error.message || ''
      if (m.includes('SENHA_AUSENTE')) { setSenhaModo('criar');   return }
      if (m.includes('SENHA_ERRADA')) {
        setSenhaModo('digitar')
        // Primeira batida vai sem senha só pra descobrir se ele tem uma: aí não
        // é erro dele, é a tela perguntando. Só acusa se ele tiver digitado.
        if (senha) setSenhaErro('Senha errada. Tente de novo.')
        return
      }
      // A trava por tentativa vem com a mensagem pronta do banco.
      if (m.includes('tentativas erradas')) { setSenhaModo('digitar'); setSenhaErro(m); return }
      if (senhaModo) { setSenhaErro(m) } else { window.alert('Não deu pra enviar: ' + m) }
      return
    }
    if (!data?.ok) { window.alert('Não deu pra enviar. Tente de novo.'); return }

    setSenhaModo(null); setSenhaErro(null)
    setCarrinho({}); setDrawer(false); setSucesso(true)
    fetchConta()
  }

  // Criou a senha: já manda o pedido na sequência, sem obrigar a digitar de
  // novo o que ele acabou de escolher duas vezes.
  async function criarSenha(senha) {
    setEnviando(true); setSenhaErro(null)
    const { error } = await supabase.rpc('cliente_criar_senha', { p_token: token, p_senha: senha })
    setEnviando(false)
    if (error) { setSenhaErro(error.message); return }
    enviar(senha)
  }

  // ── PIX do fiado ────────────────────────────────────────────────────────
  function abrirPix(totalDevendo) {
    setPix(null); setPixPago(false); setPixErro(null); setCopiado(false)
    setPixValor(String(Number(totalDevendo || 0).toFixed(2)).replace('.', ','))
    setShowPix(true)
  }
  async function gerarPix() {
    const v = Number(String(pixValor).replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(v) || v < 1) { setPixErro('O valor mínimo é R$ 1,00.'); return }
    setPixGerando(true); setPixErro(null)
    const { data, error } = await supabase.functions.invoke('cliente-pix', { body: { token, valor: v } })
    setPixGerando(false)
    if (error || data?.error) { setPixErro(data?.error || 'Não deu pra gerar o PIX agora.'); return }
    setPix(data)
  }
  async function copiarPix() {
    try {
      await navigator.clipboard.writeText(pix.qr_code)
      setCopiado(true); setTimeout(() => setCopiado(false), 2500)
    } catch { window.prompt('Copie o código do PIX:', pix.qr_code) }
  }
  // Enquanto o QR está na tela, pergunta ao banco se o Mercado Pago já confirmou.
  useEffect(() => {
    if (!pix?.cobranca_id || pixPago) return
    const t = setInterval(async () => {
      const { data } = await supabase.rpc('cliente_pix_status', { p_token: token, p_cobranca: pix.cobranca_id })
      if (data?.status === 'pago') { setPixPago(true); avisar(); fetchConta() }
      if (data?.status === 'expirado') { setPixErro('Esse código venceu. Gere outro.'); setPix(null) }
    }, 4000)
    return () => clearInterval(t)
  }, [pix, pixPago]) // eslint-disable-line react-hooks/exhaustive-deps

  const C = {
    page: { minHeight: '100dvh', background: '#0f0a1e', color: '#fff', paddingBottom: 90, fontFamily: 'system-ui, sans-serif' },
    header: { padding: '18px 16px', background: 'linear-gradient(135deg,#5b21b6,#7c3aed)', position: 'sticky', top: 0, zIndex: 5 },
    card: { background: '#1b1430', border: '1px solid #2c2350', borderRadius: 12, padding: 12, display: 'flex', alignItems: 'center', gap: 12 },
    bloco: { background: '#1b1430', border: '1px solid #2c2350', borderRadius: 12, padding: 14, marginBottom: 12 },
  }

  if (loading) return <div style={{ ...C.page, display: 'grid', placeItems: 'center' }}>Carregando…</div>
  if (erro) return (
    <div style={{ ...C.page, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div><div style={{ fontSize: 40 }}>🔗</div><p style={{ marginTop: 10 }}>{erro}</p></div>
    </div>
  )

  const comanda = conta?.comanda
  const devendo = Number(conta?.saldo_fiado ?? 0)
  const sLabel = s => s === 'pronto' ? '🔔 Pronto!' : s === 'entregue' ? '🍽️ Entregue' : '⏳ Preparando'
  const sCor = s => s === 'pronto' ? '#22c55e' : s === 'entregue' ? '#a78bfa' : '#f59e0b'

  return (
    <div style={C.page}>
      <header style={C.header}>
        <div style={{ fontSize: 13, opacity: .85 }}>{info.empresa_nome}</div>
        <div style={{ fontSize: 22, fontWeight: 800, textTransform: 'capitalize' }}>Olá, {info.cliente_nome} 👋</div>
        <div style={{ fontSize: 12, opacity: .85, marginTop: 2 }}>
          {situacao.aberto ? 'Faça seu pedido — vai direto pra cozinha 👨‍🍳' : 'A loja está fechada agora'}
        </div>
      </header>

      {notif && (
        <div onClick={() => { setNotif(null); setAba('pedido') }}
          style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 30, background: '#22c55e', color: '#fff', padding: '14px 16px', textAlign: 'center', fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 16px rgba(0,0,0,.4)' }}>
          {notif} <span style={{ fontWeight: 600, opacity: .9 }}>· toque para ver</span>
        </div>
      )}

      {/* Abas */}
      <div style={{ display: 'flex', gap: 8, padding: '12px 14px 0' }}>
        {[
          ['cardapio', '🍽️ Cardápio'],
          ['pedido', `📋 Meu pedido${comanda?.itens?.length ? ` (${comanda.itens.length})` : ''}`],
          ['conta', devendo > 0 ? `🧾 Devo ${fmt(devendo)}` : '🧾 Minha conta'],
        ].map(([id, lb]) => (
          <button key={id} onClick={() => setAba(id)}
            style={{ flex: 1, padding: '9px 6px', borderRadius: 10, cursor: 'pointer', fontSize: 12.5, fontWeight: 800,
              border: '1px solid ' + (aba === id ? '#7c3aed' : '#2c2350'),
              background: aba === id ? '#7c3aed' : 'transparent', color: '#fff' }}>
            {lb}
          </button>
        ))}
      </div>

      {/* ── CARDÁPIO ── */}
      {aba === 'cardapio' && (
        <div style={{ padding: 14 }}>
          {!situacao.aberto && (
            <div style={{ ...C.bloco, borderColor: '#f59e0b', background: 'rgba(245,158,11,.12)' }}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>🌙 A loja está fechada agora</div>
              <div style={{ fontSize: 13, opacity: .85 }}>
                {situacao.motivo ? `${situacao.motivo}. ` : ''}
                Dá pra olhar o cardápio, mas o pedido só pode ser enviado no horário de funcionamento.
                {Array.isArray(info.grade) && (
                  <div style={{ marginTop: 8, fontSize: 12.5 }}>
                    {info.grade.map((d, i) => d?.aberto && (d.periodos ?? []).length > 0 && (
                      <div key={i} style={{ opacity: .9 }}>
                        {DIAS[i]}: {d.periodos.map(p => `${p.i} às ${p.f}`).join(', ')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar item…"
            style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid #2c2350', background: '#1b1430', color: '#fff', marginBottom: 12, boxSizing: 'border-box' }} />

          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, marginBottom: 8 }}>
            {categorias.map(c => (
              <button key={c} onClick={() => setCat(c)}
                style={{ whiteSpace: 'nowrap', padding: '7px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                  border: '1px solid ' + (cat === c ? '#7c3aed' : '#2c2350'),
                  background: cat === c ? '#7c3aed' : 'transparent', color: '#fff' }}>
                {c}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {filtrados.map(p => {
              const qtd = carrinho[p.produto_id]?.qtd ?? 0
              return (
                <div key={p.produto_id} style={C.card}>
                  {p.foto_url
                    ? <img src={p.foto_url} alt="" style={{ width: 54, height: 54, borderRadius: 10, objectFit: 'cover' }} />
                    : <div style={{ width: 54, height: 54, borderRadius: 10, background: '#2c2350', display: 'grid', placeItems: 'center', fontSize: 22 }}>🍴</div>}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{p.nome}</div>
                    <div style={{ color: '#a78bfa', fontWeight: 800, fontSize: 14 }}>
                      {fmt(p.preco_venda)}
                      {compMap[p.produto_id]?.length ? <span style={{ color: '#f0abfc', fontWeight: 700 }}> · monte</span> : null}
                    </div>
                  </div>
                  {compMap[p.produto_id]?.length ? (
                    <button onClick={() => setMontando(p)} style={{ ...btnQ, width: 'auto', padding: '0 16px', background: '#7c3aed', borderColor: '#7c3aed' }}>Escolher</button>
                  ) : qtd > 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <button onClick={() => mudar(p.produto_id, -1)} style={btnQ}>−</button>
                      <span style={{ fontWeight: 800, minWidth: 18, textAlign: 'center' }}>{qtd}</span>
                      <button onClick={() => mudar(p.produto_id, +1)} style={btnQ}>+</button>
                    </div>
                  ) : (
                    <button onClick={() => add(p)} style={{ ...btnQ, width: 'auto', padding: '0 16px', background: '#7c3aed', borderColor: '#7c3aed' }}>Adicionar</button>
                  )}
                </div>
              )
            })}
            {filtrados.length === 0 && <p style={{ opacity: .7, textAlign: 'center', marginTop: 20 }}>Nenhum item encontrado.</p>}
          </div>
        </div>
      )}

      {/* ── MEU PEDIDO (o que está na cozinha agora) ── */}
      {aba === 'pedido' && (
        <div style={{ padding: 14 }}>
          {!comanda || (comanda.itens ?? []).length === 0 ? (
            <div style={{ ...C.bloco, textAlign: 'center', opacity: .8 }}>
              <div style={{ fontSize: 34 }}>🍽️</div>
              <p style={{ marginTop: 8 }}>Você não tem nenhum pedido em andamento.</p>
              <button onClick={() => setAba('cardapio')}
                style={{ marginTop: 8, padding: '10px 18px', borderRadius: 10, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
                Ver o cardápio
              </button>
            </div>
          ) : (
            <div style={C.bloco}>
              <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 2 }}>Comanda {String(comanda.numero ?? '').padStart(2, '0')}</div>
              <div style={{ fontSize: 12, opacity: .7, marginBottom: 10 }}>
                {comanda.status === 'aguardando_conferencia' ? 'Conta fechada — aguardando a loja liberar' : 'Em andamento'}
              </div>
              {(comanda.itens ?? []).map(it => (
                <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', borderBottom: '1px solid #2c2350' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>{it.quantidade}× {it.nome}</div>
                    {it.observacao && <div style={{ fontSize: 12, opacity: .7 }}>📝 {it.observacao}</div>}
                    <div style={{ fontSize: 12.5, fontWeight: 800, color: sCor(it.status), marginTop: 2 }}>{sLabel(it.status)}</div>
                  </div>
                  <span style={{ fontWeight: 700 }}>{fmt(it.preco * it.quantidade)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 18, fontWeight: 800 }}>
                <span>Total</span><span style={{ color: '#a78bfa' }}>{fmt(comanda.subtotal)}</span>
              </div>
              <p style={{ fontSize: 12, opacity: .7, marginTop: 10 }}>💳 O pagamento é feito com a equipe da loja.</p>
            </div>
          )}
        </div>
      )}

      {/* ── MINHA CONTA (fiado) ── */}
      {aba === 'conta' && (
        <div style={{ padding: 14 }}>
          <div style={{ ...C.bloco, textAlign: 'center', borderColor: devendo > 0 ? '#d97706' : '#22c55e',
            background: devendo > 0 ? 'rgba(217,119,6,.12)' : 'rgba(34,197,94,.10)' }}>
            <div style={{ fontSize: 13, opacity: .85 }}>{devendo > 0 ? 'Você está devendo' : 'Sua conta está'}</div>
            <div style={{ fontSize: 30, fontWeight: 800, marginTop: 2, color: devendo > 0 ? '#fbbf24' : '#22c55e' }}>
              {devendo > 0 ? fmt(devendo) : 'em dia ✓'}
            </div>
            {devendo > 0 && (
              <>
                <button onClick={() => abrirPix(devendo)}
                  style={{ marginTop: 12, width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer',
                    background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: 15.5 }}>
                  📱 Pagar no PIX
                </button>
                <div style={{ fontSize: 12, opacity: .8, marginTop: 6 }}>Ou pague na loja quando puder 🙂</div>
              </>
            )}
          </div>

          <div style={C.bloco}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>🧾 O que ficou fiado</div>
            {(conta?.fiados ?? []).length === 0 ? (
              <p style={{ fontSize: 13, opacity: .7, margin: 0 }}>Nada anotado.</p>
            ) : (conta.fiados).map((f, i) => (
              <div key={i} style={{ padding: '9px 0', borderBottom: '1px solid #2c2350' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5 }}>
                  <span style={{ opacity: .8 }}>
                    {dataBR(f.data)}{f.origem ? ` · ${f.origem}` : ''}
                  </span>
                  <span style={{ fontWeight: 700 }}>{fmt(f.valor)}</span>
                </div>
                {/* O que ele comprou naquele dia — sem isso o fiado era só um valor solto */}
                {(f.itens ?? []).map((it, j) => (
                  <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, opacity: .72, marginTop: 3 }}>
                    <span>{qtdBR(it.quantidade)}× {String(it.nome ?? '').trim()}</span>
                    {/* Item único: o valor dele é o total, já mostrado acima — não repete */}
                    {(f.itens ?? []).length > 1 && <span style={{ whiteSpace: 'nowrap' }}>{fmt(it.valor)}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div style={C.bloco}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>✅ O que você já pagou</div>
            {(conta?.pagamentos ?? []).length === 0 ? (
              <p style={{ fontSize: 13, opacity: .7, margin: 0 }}>Nenhum pagamento registrado ainda.</p>
            ) : (conta.pagamentos).map((p, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid #2c2350', fontSize: 13.5 }}>
                <span style={{ opacity: .8 }}>{dataBR(p.data)} · {p.forma}</span>
                <span style={{ fontWeight: 700, color: '#22c55e' }}>{fmt(p.valor)}</span>
              </div>
            ))}
          </div>

          {/* Tudo que ele já comprou, pagando como for (mig 0171). O fiado acima
              é só o que ficou anotado; aqui entra cartão, dinheiro e PIX também —
              é o que responde o "que cobrança é essa na minha fatura?". */}
          <div style={C.bloco}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>🕘 Suas últimas compras</div>
            {(conta?.historico ?? []).length === 0 ? (
              <p style={{ fontSize: 13, opacity: .7, margin: 0 }}>Você ainda não comprou com a gente.</p>
            ) : (conta.historico).map((h, i) => {
              const aberto = histAberto === i
              return (
                <div key={i} style={{ borderBottom: '1px solid #2c2350', padding: '9px 0' }}>
                  <div onClick={() => setHistAberto(aberto ? null : i)}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13.5, cursor: 'pointer' }}>
                    <span style={{ opacity: .85 }}>
                      {dataHoraBR(h.data)}
                      {h.forma ? ` · ${formaBR(h.forma)}` : ''}
                      {h.origem ? ` · ${h.origem}` : ''}
                    </span>
                    <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fmt(h.valor)} <span style={{ opacity: .5, fontWeight: 600 }}>{aberto ? '▲' : '▼'}</span>
                    </span>
                  </div>
                  {aberto && (h.itens ?? []).map((it, j) => (
                    <div key={j} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12.5, opacity: .72, marginTop: 4 }}>
                      <span>{qtdBR(it.quantidade)}× {String(it.nome ?? '').trim()}</span>
                      <span style={{ whiteSpace: 'nowrap' }}>{fmt(it.valor)}</span>
                    </div>
                  ))}
                </div>
              )
            })}
            {(conta?.historico ?? []).length > 0 && (
              <p style={{ fontSize: 11.5, opacity: .6, margin: '9px 0 0' }}>Toque numa compra pra ver o que veio nela.</p>
            )}
          </div>

          <p style={{ fontSize: 11.5, opacity: .6, textAlign: 'center' }}>
            Alguma coisa errada? Fale com a loja — quem lança é a equipe.
          </p>
        </div>
      )}

      {/* Barra do carrinho */}
      {aba === 'cardapio' && totalItens > 0 && (
        <button onClick={() => setDrawer(true)}
          style={{ position: 'fixed', left: 12, right: 12, bottom: 12, height: 56, borderRadius: 14, border: 'none', cursor: 'pointer',
            background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', zIndex: 6 }}>
          <span>{totalItens} {totalItens === 1 ? 'item' : 'itens'}</span>
          <span>Ver pedido · {fmt(totalValor)}</span>
        </button>
      )}

      {/* Drawer do pedido */}
      {drawer && (
        <div onClick={() => setDrawer(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 10, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#15102a', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 18, maxHeight: '80dvh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 17 }}>Seu pedido</strong>
              <button onClick={() => setDrawer(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 24, cursor: 'pointer' }}>×</button>
            </div>
            {itens.map(i => (
              <div key={i.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #2c2350' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>{i.nome}</div>
                  {(i.complementos ?? []).map((c, j) => (
                    <div key={j} style={{ fontSize: 11.5, color: '#8b7bb8' }}>{Number(c.qtd ?? 1)}× {c.nome}</div>
                  ))}
                  <div style={{ fontSize: 12, color: '#a78bfa' }}>{fmt(i.preco)}</div>
                </div>
                <button onClick={() => mudar(i.id, -1)} style={btnQ}>−</button>
                <span style={{ fontWeight: 800, minWidth: 18, textAlign: 'center' }}>{i.qtd}</span>
                <button onClick={() => mudar(i.id, +1)} style={btnQ}>+</button>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', margin: '14px 0', fontSize: 16, fontWeight: 800 }}>
              <span>Total</span><span style={{ color: '#a78bfa' }}>{fmt(totalValor)}</span>
            </div>
            <p style={{ fontSize: 12, opacity: .7, marginBottom: 12 }}>💳 O pagamento é feito com a equipe da loja.</p>
            <button onClick={() => enviar()} disabled={enviando || !situacao.aberto}
              style={{ width: '100%', height: 52, borderRadius: 14, border: 'none',
                cursor: (enviando || !situacao.aberto) ? 'not-allowed' : 'pointer',
                background: situacao.aberto ? '#22c55e' : '#374151', color: '#fff', fontWeight: 800, fontSize: 16 }}>
              {!situacao.aberto ? '🌙 A loja está fechada' : enviando ? 'Enviando…' : 'Enviar pedido'}
            </button>
          </div>
        </div>
      )}

      {/* ── PIX DO FIADO: escolhe o valor → QR + copia e cola → confirma sozinho ── */}
      {showPix && (
        <div onClick={() => setShowPix(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 25, display: 'flex', alignItems: 'flex-end' }}>
          <div onClick={e => e.stopPropagation()} style={{ width: '100%', background: '#15102a', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, maxHeight: '92dvh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <strong style={{ fontSize: 17 }}>📱 Pagar no PIX</strong>
              <button onClick={() => setShowPix(false)} style={{ background: 'none', border: 'none', color: '#fff', fontSize: 26, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>

            {pixErro && <p style={{ color: '#f87171', fontSize: 13.5, marginTop: 0 }}>{pixErro}</p>}

            {pixPago ? (
              <div style={{ textAlign: 'center', padding: '18px 0' }}>
                <div style={{ fontSize: 48 }}>✅</div>
                <h2 style={{ margin: '10px 0 4px' }}>Pagamento confirmado!</h2>
                <p style={{ opacity: .8, fontSize: 14 }}>
                  Recebemos {fmt(pix?.valor)}. Sua conta já foi atualizada.
                </p>
                <button onClick={() => setShowPix(false)}
                  style={{ marginTop: 18, width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
                  Fechar
                </button>
              </div>
            ) : !pix ? (
              <>
                <label style={{ fontSize: 13, opacity: .85, display: 'block', marginBottom: 6 }}>Quanto você quer pagar?</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#1b1430', border: '1px solid #2c2350', borderRadius: 12, padding: '12px 14px' }}>
                  <span style={{ fontSize: 18, opacity: .7 }}>R$</span>
                  <input inputMode="decimal" value={pixValor} onChange={e => setPixValor(e.target.value)}
                    style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: 24, fontWeight: 800 }} />
                </div>
                <button type="button" onClick={() => setPixValor(String(devendo.toFixed(2)).replace('.', ','))}
                  style={{ marginTop: 10, padding: '8px 14px', borderRadius: 999, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                    border: '1px solid #2c2350', background: 'transparent', color: '#fff' }}>
                  Pagar tudo · {fmt(devendo)}
                </button>
                <p style={{ fontSize: 12.5, opacity: .7, marginTop: 12 }}>
                  Dá pra pagar só uma parte. O que sobrar continua anotado.
                </p>
                <button onClick={gerarPix} disabled={pixGerando}
                  style={{ marginTop: 8, width: '100%', height: 52, borderRadius: 14, border: 'none', cursor: pixGerando ? 'wait' : 'pointer',
                    background: '#22c55e', color: '#fff', fontWeight: 800, fontSize: 16 }}>
                  {pixGerando ? 'Gerando…' : 'Gerar o PIX'}
                </button>
              </>
            ) : (
              <>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 13, opacity: .8 }}>Valor</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: '#22c55e' }}>{fmt(pix.valor)}</div>
                </div>
                {pix.qr_code_base64 && (
                  <img src={`data:image/png;base64,${pix.qr_code_base64}`} alt="QR Code do PIX"
                    style={{ display: 'block', width: 230, maxWidth: '100%', margin: '14px auto', borderRadius: 12, background: '#fff', padding: 8 }} />
                )}
                <p style={{ fontSize: 13, opacity: .8, textAlign: 'center', margin: '0 0 12px' }}>
                  Abra o app do seu banco, escolha PIX → <strong>Ler QR Code</strong>.<br />
                  Ou use o copia e cola:
                </p>
                <button onClick={copiarPix}
                  style={{ width: '100%', height: 48, borderRadius: 12, border: '1px solid #7c3aed', cursor: 'pointer',
                    background: copiado ? '#7c3aed' : 'transparent', color: '#fff', fontWeight: 800, fontSize: 14.5 }}>
                  {copiado ? '✅ Código copiado!' : '📋 Copiar código do PIX'}
                </button>
                <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(124,58,237,.15)', border: '1px solid #7c3aed', fontSize: 12.5, textAlign: 'center' }}>
                  ⏳ Esperando o pagamento cair… <br />
                  <span style={{ opacity: .8 }}>Pode deixar essa tela aberta — ela avisa sozinha. O código vale por 30 minutos.</span>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {montando && compMap[montando.produto_id] && (
        <ModalComplementos
          produto={montando}
          grupos={compMap[montando.produto_id]}
          semObrigatorios={!!info?.sem_obrigatorios}
          onClose={() => setMontando(null)}
          onConfirm={addComplemento}
        />
      )}

      {/* Senha de 6 números — só aparece na hora de enviar o pedido (mig 0175) */}
      {senhaModo && (
        <SenhaCliente
          modo={senhaModo}
          erro={senhaErro}
          ocupado={enviando}
          onCriar={criarSenha}
          onDigitar={enviar}
          onFechar={() => { setSenhaModo(null); setSenhaErro(null) }}
        />
      )}

      {sucesso && (
        <div onClick={() => setSucesso(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 20, display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#15102a', borderRadius: 18, padding: 28, maxWidth: 340, color: '#fff' }}>
            <div style={{ fontSize: 48 }}>🎉</div>
            <h2 style={{ margin: '10px 0 6px' }}>Pedido enviado!</h2>
            <p style={{ opacity: .8, fontSize: 14 }}>Já foi pra cozinha, no seu nome. Acompanhe em "Meu pedido".</p>
            <button onClick={() => { setSucesso(false); setAba('pedido') }}
              style={{ marginTop: 18, width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800 }}>
              Acompanhar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
