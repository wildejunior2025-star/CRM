import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabaseClient'
import { imprimirCupom, autoImprimirAtivo, qzListarImpressoras } from '../utils/imprimirCupom'
import { CONDICOES_PAGAMENTO } from '../lib/constants'
import './PainelPedidos.css'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? ''


// ── Constantes ─────────────────────────────────────────────
const TIMER_LIMITE_MS = 7 * 60 * 1000 // 7 minutos

// Limite para concluir automaticamente um pedido que saiu para entrega
// e nunca teve o código de confirmação digitado.
const AUTO_CONCLUIR_ENTREGA_MS = 6 * 60 * 60 * 1000 // 6 horas

// Status que encerram o ciclo — pedido sai do painel
const STATUS_FINALIZADOS = new Set(['entregue', 'cancelado'])

// Progressão de status por tipo de entrega
const PROXIMO_STATUS = {
  aguardando:   'confirmado',
  confirmado:   'em_preparo',
  em_preparo:   'saiu_entrega', // para retirada: overridden no botão
  saiu_entrega: 'entregue',
}

const LABEL_STATUS = {
  aguardando:   'Aguardando',
  confirmado:   'Preparando',
  em_preparo:   'Preparando',
  saiu_entrega: 'Saiu p/ entrega',
  entregue:     'Entregue',
  cancelado:    'Cancelado',
}

const BADGE_STATUS_COR = {
  aguardando:   { bg: 'rgba(234,179,8,.18)',  color: '#ca8a04' },
  confirmado:   { bg: 'rgba(59,130,246,.15)', color: '#1d4ed8' },
  em_preparo:   { bg: 'rgba(59,130,246,.15)', color: '#1d4ed8' },
  saiu_entrega: { bg: 'rgba(124,58,237,.15)', color: '#7c3aed' },
  entregue:     { bg: 'rgba(34,197,94,.15)',  color: '#16a34a' },
  cancelado:    { bg: 'rgba(239,68,68,.15)',  color: '#dc2626' },
}

// ── Utilidades ─────────────────────────────────────────────
function getTempoRestante(createdAt, aguardandoDesde) {
  const ref = aguardandoDesde ?? createdAt
  const elapsed = Date.now() - new Date(ref).getTime()
  return Math.max(0, TIMER_LIMITE_MS - elapsed)
}

function formatarTempo(ms) {
  const seg = Math.floor(ms / 1000)
  const m = Math.floor(seg / 60)
  const s = seg % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function enderecoCompleto(pedido) {
  return [
    pedido.endereco_rua,
    pedido.endereco_numero,
    pedido.endereco_complemento,
    pedido.endereco_bairro,
    pedido.endereco_cidade,
  ].filter(Boolean).join(', ')
}

function fmt(valor) {
  return Number(valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

// AudioContext único — criado na primeira interação do usuário e reutilizado
let _audioCtx = null

function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)()
    // Desbloqueia no primeiro gesto (clique, toque, teclado)
    const unlock = () => {
      if (_audioCtx.state === 'suspended') _audioCtx.resume()
    }
    document.addEventListener('click', unlock, { once: false })
    document.addEventListener('keydown', unlock, { once: false })
    document.addEventListener('touchstart', unlock, { once: false })
  }
  return _audioCtx
}

function tocarSom() {
  try {
    const ctx = getAudioCtx()
    if (ctx.state === 'suspended') ctx.resume()

    // 3 bipes curtos em sequência
    const bipes = [0, 0.18, 0.36]
    bipes.forEach(offset => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.setValueAtTime(880, ctx.currentTime + offset)
      gain.gain.setValueAtTime(0.28, ctx.currentTime + offset)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.14)
      osc.start(ctx.currentTime + offset)
      osc.stop(ctx.currentTime + offset + 0.14)
    })
  } catch {
    // Web Audio não disponível — ignora silenciosamente
  }
}

function getUrgencia(ms) {
  if (ms > 3 * 60 * 1000) return 'ok'
  if (ms > 60 * 1000)     return 'atencao'
  return 'critico'
}

// ── Timer regressivo ────────────────────────────────────────
// Componente isolado: só re-renderiza a si mesmo a cada tick,
// evitando re-render do card inteiro.
function TimerRegressivo({ createdAt, aguardandoDesde, onExpirado }) {
  const [restante, setRestante] = useState(() => getTempoRestante(createdAt, aguardandoDesde))
  const expiradoRef = useRef(false)

  useEffect(() => {
    if (restante === 0) {
      if (!expiradoRef.current) {
        expiradoRef.current = true
        onExpirado()
      }
      return
    }
    const id = setTimeout(() => setRestante(getTempoRestante(createdAt, aguardandoDesde)), 500)
    return () => clearTimeout(id)
  }, [restante, createdAt, aguardandoDesde, onExpirado])

  const pct = Math.round((restante / TIMER_LIMITE_MS) * 100)
  const urgencia = getUrgencia(restante)

  return (
    <div className="pp-timer">
      <div className="pp-timer-row">
        <span className={`pp-timer-tempo ${urgencia}`}>
          {formatarTempo(restante)}
        </span>
        <span className="pp-timer-label">para aceitar</span>
      </div>
      <div className="pp-timer-barra-bg">
        <div
          className={`pp-timer-barra ${urgencia}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Modal de recusa ─────────────────────────────────────────
function ModalRecusa({ pedido, onConfirmar, onFechar }) {
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)

  async function handleConfirmar() {
    const m = motivo.trim()
    if (!m) return
    setEnviando(true)
    await onConfirmar(pedido.id, m)
    setEnviando(false)
  }

  // Fecha ao pressionar Escape
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onFechar()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  return (
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal" onClick={e => e.stopPropagation()}>
        <div>
          <p className="pp-modal-titulo">
            Recusar pedido #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}
          </p>
          <p className="pp-modal-sub">
            Informe o motivo — o cliente sera notificado.
          </p>
        </div>
        {pedido.pix_status === 'pago' && (
          <div className="pp-modal-pix-aviso">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>Este pedido foi pago via PIX. O reembolso sera processado automaticamente pelo Mercado Pago.</span>
          </div>
        )}
        <div className="pp-modal-field">
          <label className="pp-modal-label">Motivo do cancelamento</label>
          <textarea
            className="pp-modal-textarea"
            rows={4}
            value={motivo}
            onChange={e => setMotivo(e.target.value)}
            placeholder="Ex: Item fora de estoque, area nao atendida, loja fechando..."
            autoFocus
          />
        </div>
        <div className="pp-modal-actions">
          <button
            type="button"
            className="pp-modal-btn-secondary"
            onClick={onFechar}
          >
            Voltar
          </button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            disabled={!motivo.trim() || enviando}
            onClick={handleConfirmar}
          >
            {enviando ? 'Recusando...' : 'Recusar pedido'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal de mensagem ───────────────────────────────────────
const MSGS_RAPIDAS = [
  'Seu pedido está sendo preparado! 🍽️',
  'Seu pedido saiu para entrega! 🛵',
  'Estamos com um pequeno atraso, mas já estamos a caminho! 😊',
  'Problema com seu pedido? Pode nos falar aqui! 😊',
]

function ModalMensagem({ pedido, onEnviar, onFechar }) {
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState(null)

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  async function handleEnviar() {
    const msg = texto.trim()
    if (!msg) return
    setEnviando(true)
    setErro(null)
    const ok = await onEnviar(pedido, msg)
    setEnviando(false)
    if (ok) onFechar()
    else setErro('Não foi possível enviar. Verifique se o WhatsApp está conectado.')
  }

  return (
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal" onClick={e => e.stopPropagation()}>
        <p className="pp-modal-titulo">
          Enviar mensagem para {pedido.cliente_nome || pedido.cliente_telefone}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {MSGS_RAPIDAS.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setTexto(m)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid var(--border)',
                background: texto === m ? 'var(--primary)' : 'transparent',
                color: texto === m ? '#fff' : 'var(--text)',
                cursor: 'pointer',
              }}
            >{m}</button>
          ))}
        </div>
        <div className="pp-modal-field">
          <label className="pp-modal-label">Ou escreva uma mensagem</label>
          <textarea
            className="pp-modal-textarea"
            rows={3}
            value={texto}
            onChange={e => setTexto(e.target.value)}
            placeholder="Digite sua mensagem..."
            autoFocus
          />
        </div>
        {erro && <p style={{ fontSize: 12, color: 'var(--danger)', margin: '4px 0' }}>{erro}</p>}
        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onFechar}>Cancelar</button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            style={{ background: '#25d366', borderColor: '#25d366' }}
            disabled={!texto.trim() || enviando}
            onClick={handleEnviar}
          >
            {enviando ? 'Enviando...' : 'Enviar pelo WhatsApp'}
          </button>
        </div>
      </div>
    </div>
  )
}

const ORIGEM_CONFIG = {
  whatsapp: { label: 'WhatsApp', bg: '#25d366', color: '#fff', borda: '#25d366' },
  cardapio:  { label: 'Cardápio', bg: '#3b82f6', color: '#fff', borda: '#3b82f6' },
  app:       { label: 'App',      bg: '#f97316', color: '#fff', borda: '#f97316' },
  balcao:    { label: 'Balcão',   bg: '#0891b2', color: '#fff', borda: '#0891b2' },
}

// Campo de quantidade digitável (permite digitar 100 em vez de clicar 100x).
// Mantém um texto local para deixar apagar/retypear sem sumir o item.
function QtdInput({ value, onChange }) {
  const [txt, setTxt] = useState(String(value))
  useEffect(() => { setTxt(String(value)) }, [value])
  return (
    <input
      type="text"
      inputMode="numeric"
      value={txt}
      onChange={e => {
        const v = e.target.value.replace(/\D/g, '')
        setTxt(v)
        if (v !== '') onChange(parseInt(v, 10))
      }}
      onFocus={e => e.target.select()}
      onBlur={() => { if (txt === '') setTxt(String(value)) }}
      style={{
        width: 52, height: 30, textAlign: 'center', fontWeight: 700, fontSize: 14,
        borderRadius: 7, border: '1px solid var(--border, #2a2a3a)',
        background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
      }}
    />
  )
}

// ── Modal de cadastro completo de cliente (mesma ficha do CRM) ──
const DIAS_VISITA = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
const TIPOS_CLIENTE_PADRAO = ['mercadinho', 'bar', 'restaurante', 'distribuidor', 'outro']

function ModalNovoCliente({ empresa, initialNome = '', initialTel = '', onFechar, onSalvo }) {
  const [form, setForm] = useState({
    nome: initialNome, tipo: 'mercadinho', cnpj_cpf: '', telefone: initialTel,
    endereco: '', bairro: '', cidade: '', dia_visita: '',
    condicao_pagamento: 'a_vista', limite_credito: 0,
    desconto_percentual: 0, desconto_minimo_pedido: 0, observacoes: '', ativo: true,
  })
  const [tipos, setTipos]   = useState(TIPOS_CLIENTE_PADRAO)
  const [saving, setSaving] = useState(false)
  const [erro, setErro]     = useState(null)

  useEffect(() => {
    let ativo = true
    ;(async () => {
      const { data } = await supabase.from('tipos_cliente').select('nome').order('nome')
      if (ativo && data && data.length) setTipos(data.map(t => t.nome))
    })()
    return () => { ativo = false }
  }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  function ch(e) {
    const { name, value, type, checked } = e.target
    setForm(p => ({ ...p, [name]: type === 'checkbox' ? checked : value }))
  }

  async function salvar(e) {
    e.preventDefault()
    if (!form.nome.trim()) { setErro('Informe o nome do cliente.'); return }
    setSaving(true); setErro(null)
    const payload = {
      ...form, empresa_id: empresa.id,
      limite_credito: Number(form.limite_credito) || 0,
      desconto_percentual: Number(form.desconto_percentual) || 0,
      desconto_minimo_pedido: Number(form.desconto_minimo_pedido) || 0,
    }
    const { data, error } = await supabase
      .from('clientes')
      .insert(payload)
      .select('id, nome, telefone, endereco, numero, complemento, bairro, cidade')
      .single()
    setSaving(false)
    if (error) { setErro(error.message); return }
    onSalvo(data)
  }

  const inp = {
    width: '100%', padding: '9px 11px', borderRadius: 8,
    border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
    color: 'var(--text)', fontSize: 14,
  }
  const lbl = { fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', margin: '0 0 4px', display: 'block' }
  const col = { flex: 1, minWidth: 0 }

  return (
    <div className="pp-modal-overlay" onClick={onFechar} style={{ zIndex: 200 }}>
      <form className="pp-modal" onClick={e => e.stopPropagation()} onSubmit={salvar}
        style={{ maxWidth: 560, width: '94vw', maxHeight: '90vh', overflowY: 'auto', display: 'block' }}>
        <p className="pp-modal-titulo">Novo cliente</p>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Nome / Razão social *</label>
          <input name="nome" value={form.nome} onChange={ch} style={inp} autoFocus />
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={col}>
            <label style={lbl}>Tipo</label>
            <select name="tipo" value={form.tipo} onChange={ch} style={inp}>
              {tipos.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div style={col}>
            <label style={lbl}>CNPJ / CPF</label>
            <input name="cnpj_cpf" value={form.cnpj_cpf} onChange={ch} style={inp} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={col}>
            <label style={lbl}>Telefone</label>
            <input name="telefone" value={form.telefone} onChange={ch} style={inp} />
          </div>
          <div style={col}>
            <label style={lbl}>Dia de visita</label>
            <select name="dia_visita" value={form.dia_visita} onChange={ch} style={inp}>
              <option value="">-</option>
              {DIAS_VISITA.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Endereço</label>
          <input name="endereco" value={form.endereco} onChange={ch} style={inp} />
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={col}>
            <label style={lbl}>Bairro</label>
            <input name="bairro" value={form.bairro} onChange={ch} style={inp} />
          </div>
          <div style={col}>
            <label style={lbl}>Cidade</label>
            <input name="cidade" value={form.cidade} onChange={ch} style={inp} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={col}>
            <label style={lbl}>Condição de pagamento</label>
            <select name="condicao_pagamento" value={form.condicao_pagamento} onChange={ch} style={inp}>
              {CONDICOES_PAGAMENTO.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div style={col}>
            <label style={lbl}>Limite de crédito (R$)</label>
            <input name="limite_credito" type="number" value={form.limite_credito} onChange={ch} style={inp} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={col}>
            <label style={lbl}>Desconto autorizado (%)</label>
            <input name="desconto_percentual" type="number" value={form.desconto_percentual} onChange={ch} style={inp} />
          </div>
          <div style={col}>
            <label style={lbl}>Pedido mínimo para desconto (R$)</label>
            <input name="desconto_minimo_pedido" type="number" value={form.desconto_minimo_pedido} onChange={ch} style={inp} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={lbl}>Observações</label>
          <textarea name="observacoes" value={form.observacoes} onChange={ch} rows={3} style={{ ...inp, resize: 'vertical' }} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text)', marginBottom: 14, cursor: 'pointer' }}>
          <input name="ativo" type="checkbox" checked={form.ativo} onChange={ch} />
          Ativo
        </label>

        {erro && <p style={{ color: 'var(--danger, #ef4444)', fontSize: 13, margin: '0 0 10px' }}>{erro}</p>}

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onFechar}>Cancelar</button>
          <button type="submit" className="pp-modal-btn-danger" style={{ background: '#7c3aed', borderColor: '#7c3aed' }} disabled={saving}>
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  )
}

// ── Modal de venda no balcão (PDV do gestor) ────────────────
// O vendedor monta o pedido pelo catálogo; ele entra na lista do painel.
function ModalVenda({ empresa, onFechar, onCriado }) {
  const [produtos, setProdutos] = useState([])
  const [loading, setLoading]   = useState(true)
  const [busca, setBusca]       = useState('')
  const [cart, setCart]         = useState({}) // { [id]: { id, nome, preco, qtd } }
  const [nome, setNome]         = useState('')
  const [telefone, setTelefone] = useState('')
  const [tipo, setTipo]         = useState('retirada') // 'retirada' (balcão) | 'entrega'
  const [rua, setRua]           = useState('')
  const [numero, setNumero]     = useState('')
  const [bairro, setBairro]     = useState('')
  const [cidade, setCidade]     = useState('')
  const [taxa, setTaxa]         = useState('')
  const [pagamento, setPagamento] = useState('dinheiro')
  const [troco, setTroco]       = useState('')
  const [obs, setObs]           = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro]         = useState(null)
  // Busca de clientes já cadastrados na loja
  const [sugestoes, setSugestoes]       = useState([])
  const [clienteSelId, setClienteSelId] = useState(null)
  const [msgCli, setMsgCli]             = useState(null)
  const buscaCliTimer = useRef(null)
  // Abre a ficha completa de cadastro de cliente
  const [cadastroAberto, setCadastroAberto] = useState(false)

  useEffect(() => {
    let ativo = true
    ;(async () => {
      const { data } = await supabase
        .from('produtos')
        .select('id, nome, preco_venda, categoria')
        .eq('empresa_id', empresa.id)
        .order('nome', { ascending: true })
      if (ativo) { setProdutos(data || []); setLoading(false) }
    })()
    return () => { ativo = false }
  }, [empresa])

  // Busca clientes da loja pelo nome (debounce) enquanto digita
  function buscarClientes(q) {
    clearTimeout(buscaCliTimer.current)
    if (!q || q.trim().length < 2) { setSugestoes([]); return }
    buscaCliTimer.current = setTimeout(async () => {
      const { data } = await supabase
        .from('clientes')
        .select('id, nome, telefone, endereco, numero, complemento, bairro, cidade, estado, cep')
        .eq('empresa_id', empresa.id)
        .ilike('nome', `%${q.trim()}%`)
        .order('nome', { ascending: true })
        .limit(8)
      setSugestoes(data || [])
    }, 300)
  }

  function selecionarCliente(c) {
    setNome(c.nome || '')
    setTelefone(c.telefone || '')
    if (c.endereco || c.bairro || c.cidade) {
      setRua(c.endereco || ''); setNumero(c.numero || '')
      setBairro(c.bairro || ''); setCidade(c.cidade || '')
    }
    setClienteSelId(c.id)
    setSugestoes([])
    setMsgCli(null)
  }

  // Vincula à venda o cliente recém-cadastrado pela ficha completa
  function aoCadastrarCliente(c) {
    selecionarCliente(c)
    setCadastroAberto(false)
    setMsgCli('Cliente cadastrado ✓')
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onFechar() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onFechar])

  function addItem(p) {
    setCart(prev => {
      const qtd = (prev[p.id]?.qtd ?? 0) + 1
      return { ...prev, [p.id]: { id: p.id, nome: p.nome, preco: Number(p.preco_venda || 0), qtd } }
    })
  }
  function subItem(id) {
    setCart(prev => {
      const cur = prev[id]
      if (!cur) return prev
      const novo = { ...prev }
      if (cur.qtd <= 1) delete novo[id]
      else novo[id] = { ...cur, qtd: cur.qtd - 1 }
      return novo
    })
  }
  function setItemQtd(p, n) {
    const qtd = Math.max(0, Math.floor(Number(n) || 0))
    setCart(prev => {
      const novo = { ...prev }
      if (qtd <= 0) delete novo[p.id]
      else novo[p.id] = { id: p.id, nome: p.nome, preco: Number(p.preco_venda || 0), qtd }
      return novo
    })
  }

  const itens     = Object.values(cart)
  const subtotal  = itens.reduce((s, i) => s + i.preco * i.qtd, 0)
  const taxaNum   = tipo === 'entrega' ? (parseFloat(String(taxa).replace(',', '.')) || 0) : 0
  const total     = subtotal + taxaNum
  const filtrados = produtos.filter(p => !busca.trim() || p.nome?.toLowerCase().includes(busca.trim().toLowerCase()))

  async function concluir() {
    if (itens.length === 0) { setErro('Adicione pelo menos um item.'); return }
    if (tipo === 'entrega' && !rua.trim()) { setErro('Informe o endereço da entrega.'); return }
    setSalvando(true); setErro(null)

    // Vincula o cliente: usa o selecionado ou cadastra/atualiza pelo telefone.
    let clienteId = clienteSelId
    if (!clienteId && telefone.trim()) {
      try {
        const { data: cid } = await supabase.rpc('upsert_cliente_loja', {
          p_empresa_id: empresa.id, p_nome: nome.trim() || 'Cliente', p_telefone: telefone.trim(),
          p_email: '', p_cep: '', p_endereco: rua.trim(), p_numero: numero.trim(),
          p_complemento: '', p_bairro: bairro.trim(), p_cidade: cidade.trim(), p_estado: '',
        })
        clienteId = cid ?? null
      } catch { /* não bloqueia a venda */ }
    }

    const payload = {
      empresa_id: empresa.id,
      cliente_id: clienteId,
      cliente_nome: nome.trim() || 'Balcão',
      cliente_telefone: telefone.trim() || null,
      tipo_entrega: tipo,
      origem: 'balcao',
      status: 'confirmado', // já aceito — o vendedor está criando o pedido
      itens: itens.map(i => ({
        produto_id: i.id, nome: i.nome, quantidade: i.qtd,
        preco_unitario: i.preco, subtotal: i.preco * i.qtd,
      })),
      subtotal,
      taxa_entrega: taxaNum,
      total,
      forma_pagamento: pagamento,
      troco_para: pagamento === 'dinheiro' && troco
        ? Math.round(parseFloat(troco.replace(',', '.')) * 100) / 100
        : null,
      observacoes: obs.trim() || null,
    }
    if (tipo === 'entrega') {
      payload.endereco_rua = rua.trim()
      payload.endereco_numero = numero.trim()
      payload.endereco_bairro = bairro.trim()
      payload.endereco_cidade = cidade.trim()
    }
    const { error } = await supabase.from('pedidos_delivery').insert(payload)
    setSalvando(false)
    if (error) { setErro(error.message); return }
    onCriado()
    onFechar()
  }

  const inputSt = {
    width: '100%', padding: '9px 11px', borderRadius: 8,
    border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
    color: 'var(--text)', fontSize: 14,
  }
  const tipoBtn = (val, lbl) => ({
    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
    border: `1.5px solid ${tipo === val ? '#7c3aed' : 'var(--border, #2a2a3a)'}`,
    background: tipo === val ? 'rgba(124,58,237,.15)' : 'transparent',
    color: tipo === val ? '#a78bfa' : 'var(--text)',
  })
  const pagBtn = (val, lbl) => ({
    flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
    border: `1.5px solid ${pagamento === val ? '#16a34a' : 'var(--border, #2a2a3a)'}`,
    background: pagamento === val ? 'rgba(34,197,94,.12)' : 'transparent',
    color: pagamento === val ? '#16a34a' : 'var(--text)',
  })

  return (
    <>
    <div className="pp-modal-overlay" onClick={onFechar}>
      <div className="pp-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, width: '94vw', maxHeight: '90vh', overflowY: 'auto' }}>
        <p className="pp-modal-titulo">Nova venda (balcão)</p>

        {/* Produtos */}
        <input
          type="search" value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar produto..." style={{ ...inputSt, marginBottom: 8 }}
        />
        <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 6, marginBottom: 14 }}>
          {loading ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16, fontSize: 13 }}>Carregando produtos...</div>
          ) : filtrados.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16, fontSize: 13 }}>Nenhum produto.</div>
          ) : filtrados.map(p => {
            const qtd = cart[p.id]?.qtd ?? 0
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 6px', borderRadius: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.nome}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmt(p.preco_venda)}</div>
                </div>
                {qtd > 0 ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <button type="button" onClick={() => subItem(p.id)} style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid var(--border,#2a2a3a)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 800, fontSize: 16 }}>−</button>
                    <QtdInput value={qtd} onChange={n => setItemQtd(p, n)} />
                    <button type="button" onClick={() => addItem(p)} style={{ width: 30, height: 30, borderRadius: 7, border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontWeight: 800, fontSize: 16 }}>+</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => addItem(p)} style={{ flexShrink: 0, padding: '6px 14px', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Adicionar</button>
                )}
              </div>
            )
          })}
        </div>

        {/* Carrinho */}
        {itens.length > 0 && (
          <div style={{ marginBottom: 14, fontSize: 13 }}>
            {itens.map(i => (
              <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text)', padding: '2px 0' }}>
                <span>{i.qtd}× {i.nome}</span>
                <span>{fmt(i.preco * i.qtd)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Cliente — busca os já cadastrados pelo nome */}
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <input
                value={nome}
                onChange={e => { setNome(e.target.value); setClienteSelId(null); setMsgCli(null); buscarClientes(e.target.value) }}
                placeholder="Nome do cliente (busca os cadastrados)"
                style={inputSt}
                autoComplete="off"
              />
              {sugestoes.length > 0 && (
                <div style={{
                  position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 5,
                  background: 'var(--surface, #16161f)', border: '1px solid var(--border, #2a2a3a)',
                  borderRadius: 8, maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,.3)',
                }}>
                  {sugestoes.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => selecionarCliente(c)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', padding: '8px 11px',
                        background: 'transparent', border: 'none', borderBottom: '1px solid var(--border,#2a2a3a)',
                        cursor: 'pointer', color: 'var(--text)',
                      }}
                    >
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{c.nome}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {c.telefone || 'sem telefone'}{c.bairro ? ` · ${c.bairro}` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input value={telefone} onChange={e => { setTelefone(e.target.value); setClienteSelId(null) }} placeholder="Telefone (opcional)" style={{ ...inputSt, maxWidth: 160 }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <button
              type="button"
              onClick={() => setCadastroAberto(true)}
              style={{
                background: 'none', border: '1px dashed var(--border, #2a2a3a)', borderRadius: 8,
                padding: '5px 10px', cursor: 'pointer',
                color: 'var(--primary, #a78bfa)', fontWeight: 700, fontSize: 12.5,
              }}
            >
              + Cadastrar novo cliente
            </button>
            {clienteSelId && <span style={{ fontSize: 12, color: '#16a34a', fontWeight: 700 }}>● cliente vinculado</span>}
            {msgCli && <span style={{ fontSize: 12, color: msgCli.includes('✓') ? '#16a34a' : 'var(--danger,#ef4444)' }}>{msgCli}</span>}
          </div>
        </div>

        {/* Tipo */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button type="button" style={tipoBtn('retirada')} onClick={() => setTipo('retirada')}>Balcão / Retirada</button>
          <button type="button" style={tipoBtn('entrega')} onClick={() => setTipo('entrega')}>Entrega</button>
        </div>

        {tipo === 'entrega' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={rua} onChange={e => setRua(e.target.value)} placeholder="Rua" style={inputSt} />
              <input value={numero} onChange={e => setNumero(e.target.value)} placeholder="Nº" style={{ ...inputSt, maxWidth: 90 }} />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={bairro} onChange={e => setBairro(e.target.value)} placeholder="Bairro" style={inputSt} />
              <input value={cidade} onChange={e => setCidade(e.target.value)} placeholder="Cidade" style={inputSt} />
            </div>
            <input value={taxa} onChange={e => setTaxa(e.target.value)} placeholder="Taxa de entrega (R$)" inputMode="decimal" style={inputSt} />
          </div>
        )}

        {/* Pagamento */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button type="button" style={pagBtn('dinheiro')} onClick={() => setPagamento('dinheiro')}>Dinheiro</button>
          <button type="button" style={pagBtn('pix')} onClick={() => setPagamento('pix')}>Pix</button>
          <button type="button" style={pagBtn('cartao')} onClick={() => setPagamento('cartao')}>Cartão</button>
        </div>
        {pagamento === 'dinheiro' && (
          <input value={troco} onChange={e => setTroco(e.target.value)} placeholder="Troco para (R$) — opcional" inputMode="decimal" style={{ ...inputSt, marginBottom: 10 }} />
        )}

        <input value={obs} onChange={e => setObs(e.target.value)} placeholder="Observações (opcional)" style={{ ...inputSt, marginBottom: 14 }} />

        {/* Total */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 18, fontWeight: 800, color: 'var(--text)', marginBottom: 14 }}>
          <span>Total</span>
          <span style={{ color: '#7c3aed' }}>{fmt(total)}</span>
        </div>

        {erro && <p style={{ fontSize: 13, color: 'var(--danger, #ef4444)', margin: '0 0 10px' }}>{erro}</p>}

        <div className="pp-modal-actions">
          <button type="button" className="pp-modal-btn-secondary" onClick={onFechar}>Cancelar</button>
          <button
            type="button"
            className="pp-modal-btn-danger"
            style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
            disabled={salvando || itens.length === 0}
            onClick={concluir}
          >
            {salvando ? 'Salvando...' : `Concluir venda · ${fmt(total)}`}
          </button>
        </div>
      </div>
    </div>

    {cadastroAberto && (
      <ModalNovoCliente
        empresa={empresa}
        initialNome={nome}
        initialTel={telefone}
        onFechar={() => setCadastroAberto(false)}
        onSalvo={aoCadastrarCliente}
      />
    )}
    </>
  )
}

// ── Card de pedido ──────────────────────────────────────────
function CardPedido({ pedido, onConfirmar, onRecusar, onExpirado, onAvancar, onEnviarMensagem, onImprimir }) {
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const pagamento = pedido.forma_pagamento || ''
  const endereco = enderecoCompleto(pedido)
  const hora = new Date(pedido.created_at).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const tipoEntrega = pedido.tipo_entrega || 'entrega'
  const isRetirada = tipoEntrega === 'retirada'

  // Estado local para input de código de confirmação (saiu_entrega)
  const [codigoDigitos, setCodigoDigitos] = useState(['', '', '', ''])
  const [erroLocal, setErroLocal] = useState(null)
  const digitRefs = useRef([])
  const [confirmandoEntrega, setConfirmandoEntrega] = useState(false)

  function handleDigitChange(i, v) {
    const digit = v.replace(/\D/g, '').slice(-1)
    const novos = [...codigoDigitos]
    novos[i] = digit
    setCodigoDigitos(novos)
    setErroLocal(null)
    if (digit && i < 3) digitRefs.current[i + 1]?.focus()
  }

  function handleKeyDown(i, e) {
    if (e.key === 'Backspace' && !codigoDigitos[i] && i > 0) {
      const novos = [...codigoDigitos]
      novos[i - 1] = ''
      setCodigoDigitos(novos)
      digitRefs.current[i - 1]?.focus()
    }
  }

  function handleConfirmarComCodigo() {
    const codigo = codigoDigitos.join('')
    if (pedido.codigo_entrega && codigo !== String(pedido.codigo_entrega).trim()) {
      setErroLocal('Código incorreto.')
      setCodigoDigitos(['', '', '', ''])
      digitRefs.current[0]?.focus()
      return
    }
    onAvancar(pedido.id, 'entregue')
  }

  // urgencia afeta a borda esquerda (só faz sentido para aguardando)
  // ATENÇÃO: getUrgencia retorna 'ok' | 'atencao' | 'critico' — o CSS usa as mesmas strings
  const urgenciaAtual = pedido.status === 'aguardando'
    ? getUrgencia(getTempoRestante(pedido.created_at, pedido.aguardando_desde))
    : 'ok'

  const badgeSt = BADGE_STATUS_COR[pedido.status] ?? BADGE_STATUS_COR.aguardando
  const origemCfg = ORIGEM_CONFIG[pedido.origem] ?? ORIGEM_CONFIG.cardapio

  return (
    <div className={`pp-card urgencia-${urgenciaAtual}`} style={{ borderTop: `3px solid ${origemCfg.borda}` }}>
      {/* Header */}
      <div className="pp-card-header">
        <div className="pp-card-header-left">
          <span className="pp-numero">#{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</span>
          {/* Badge de origem */}
          <span style={{
            background: origemCfg.bg,
            color: origemCfg.color,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 7px',
            borderRadius: 20,
            letterSpacing: '0.03em',
            flexShrink: 0,
          }}>
            {origemCfg.label}
          </span>
          {/* Badge de status para pedidos não-aguardando */}
          {pedido.status !== 'aguardando' && (
            <span
              className="pp-status-badge"
              style={{ background: badgeSt.bg, color: badgeSt.color }}
            >
              {LABEL_STATUS[pedido.status] ?? pedido.status}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Badge tipo entrega */}
          <span className={`pp-tipo-badge ${isRetirada ? 'retirada' : 'entrega'}`}>
            {isRetirada ? 'Retirada' : 'Entrega'}
          </span>
          <span className="pp-hora">{hora}</span>
          {/* Imprimir cupom */}
          <button
            type="button"
            title="Imprimir cupom"
            aria-label="Imprimir cupom"
            onClick={() => onImprimir(pedido)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2,
              display: 'flex', alignItems: 'center', color: 'var(--text-muted)',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Timer — só para pedidos aguardando */}
      {pedido.status === 'aguardando' && (
        <TimerRegressivo
          createdAt={pedido.created_at}
          aguardandoDesde={pedido.aguardando_desde}
          onExpirado={() => onExpirado(pedido.id)}
        />
      )}

      {/* Cliente */}
      <div className="pp-cliente">
        <span className="pp-cliente-nome">{pedido.cliente_nome || '—'}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {pedido.cliente_telefone && (
            <a href={`tel:${pedido.cliente_telefone}`} className="pp-cliente-tel">
              {pedido.cliente_telefone}
            </a>
          )}
          {pedido.cliente_telefone && (
            <button
              type="button"
              title="Enviar mensagem pelo WhatsApp"
              onClick={() => onEnviarMensagem(pedido)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: 2, display: 'flex', alignItems: 'center',
                color: '#25d366',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                <path d="M12 0C5.373 0 0 5.373 0 12c0 2.124.558 4.118 1.533 5.845L.057 23.899l6.199-1.476A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.814 9.814 0 0 1-5.002-1.368l-.359-.214-3.68.875.938-3.577-.234-.369A9.818 9.818 0 0 1 2.182 12C2.182 6.579 6.579 2.182 12 2.182S21.818 6.579 21.818 12 17.421 21.818 12 21.818z"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Endereco — só para entrega */}
      {!isRetirada && endereco && (
        <div className="pp-endereco">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          {endereco}
        </div>
      )}
      {isRetirada && (
        <div className="pp-endereco" style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Cliente vai retirar na loja
        </div>
      )}

      {/* Itens */}
      {itens.length > 0 && (
        <ul className="pp-itens">
          {itens.map((item, i) => {
            const qtd = item.qtd ?? item.quantidade ?? 1
            const sub = item.subtotal != null
              ? Number(item.subtotal)
              : qtd * Number(item.preco ?? item.preco_unitario ?? 0)
            return (
              <li key={i}>
                <span className="pp-item-qtd">{qtd}x</span>
                <span className="pp-item-nome">{item.nome}</span>
                <span className="pp-item-sub">{fmt(sub)}</span>
              </li>
            )
          })}
        </ul>
      )}

      {/* Totais */}
      <div className="pp-totais">
        {pedido.subtotal != null && (
          <div className="pp-totais-row">
            <span>Subtotal</span>
            <span>{fmt(pedido.subtotal)}</span>
          </div>
        )}
        {!isRetirada && pedido.taxa_entrega != null && (
          <div className="pp-totais-row">
            <span>Taxa de entrega</span>
            <span>{fmt(pedido.taxa_entrega)}</span>
          </div>
        )}
        <div className="pp-totais-total">
          <span>Total</span>
          <span>{fmt(pedido.total)}</span>
        </div>
      </div>

      {/* Pagamento */}
      <div className="pp-pagamento-row">
        {pagamento === 'pix' && (
          <span className="pp-badge pp-badge-pix">Pix</span>
        )}
        {pagamento === 'pix' && pedido.pix_status === 'pago' && (
          <span className="pp-badge-pix-pago">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
            PIX pago
          </span>
        )}
        {pagamento === 'dinheiro' && (
          <span className="pp-badge pp-badge-dinheiro">Dinheiro</span>
        )}
        {pagamento === 'dinheiro' && pedido.troco_para > 0 && (
          <span className="pp-troco">Troco para {fmt(pedido.troco_para)}</span>
        )}
        {pagamento !== 'pix' && pagamento !== 'dinheiro' && pagamento && (
          <span className="pp-badge pp-badge-outro">{pagamento}</span>
        )}
      </div>

      {/* Observacoes */}
      {pedido.observacoes && (
        <div className="pp-obs">
          <span className="pp-obs-label">Obs:</span>
          {pedido.observacoes}
        </div>
      )}

      {/* Acoes por status */}
      <div className="pp-acoes">
        {/* Passo 1: aceitar */}
        {pedido.status === 'aguardando' && (
          <>
            <button type="button" className="pp-btn pp-btn-confirmar" onClick={() => onConfirmar(pedido.id)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>
              Confirmar
            </button>
            <button type="button" className="pp-btn pp-btn-recusar" onClick={() => onRecusar(pedido)} title="Recusar pedido">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              Recusar
            </button>
          </>
        )}

        {/* Balcão (PDV): venda feita pelo vendedor — finaliza direto, sem código de entrega */}
        {pedido.origem === 'balcao' && (pedido.status === 'confirmado' || pedido.status === 'em_preparo' || pedido.status === 'saiu_entrega') && (
          <button
            type="button"
            className="pp-btn pp-btn-avancar"
            style={{ width: '100%', background: '#16a34a', borderColor: '#16a34a' }}
            onClick={() => onAvancar(pedido.id, 'entregue')}
          >
            Finalizar venda
          </button>
        )}

        {/* Passo 2: preparando → despachar (fluxo de delivery, não-balcão) */}
        {pedido.origem !== 'balcao' && (pedido.status === 'confirmado' || pedido.status === 'em_preparo') && (
          <button type="button" className="pp-btn pp-btn-avancar"
            onClick={() => onAvancar(pedido.id, 'saiu_entrega')}>
            Despachar
          </button>
        )}

        {/* Passo 3: saiu → primeiro mostra status, depois confirma com código */}
        {pedido.origem !== 'balcao' && pedido.status === 'saiu_entrega' && (
          <div style={{ width: '100%' }}>
            {!confirmandoEntrega ? (
              <>
                <p style={{ textAlign: 'center', color: '#a78bfa', fontSize: 13, fontWeight: 600, margin: '0 0 10px' }}>
                  🛵 Pedido saiu para entrega
                </p>
                <button
                  type="button"
                  className="pp-btn pp-btn-avancar"
                  onClick={() => { setConfirmandoEntrega(true); setTimeout(() => digitRefs.current[0]?.focus(), 80) }}
                  style={{ width: '100%', background: '#7c3aed', borderColor: '#7c3aed' }}
                >
                  Confirmar entrega
                </button>
              </>
            ) : (
              <>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '0 0 8px' }}>
                  Peça o código de 4 dígitos ao cliente:
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '4px 0 10px' }}>
                  {[0, 1, 2, 3].map(i => (
                    <input
                      key={i}
                      ref={el => { digitRefs.current[i] = el }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={codigoDigitos[i]}
                      onChange={e => handleDigitChange(i, e.target.value)}
                      onKeyDown={e => handleKeyDown(i, e)}
                      style={{
                        width: 52, height: 58, textAlign: 'center',
                        fontSize: 24, fontWeight: 800, borderRadius: 10,
                        border: `2px solid ${erroLocal ? '#ef4444' : '#444'}`,
                        background: '#0f0f1a', color: '#fff', outline: 'none',
                      }}
                    />
                  ))}
                </div>
                {erroLocal && (
                  <p style={{ color: '#ef4444', fontSize: 12, textAlign: 'center', margin: '0 0 8px' }}>
                    {erroLocal}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="pp-btn pp-btn-recusar"
                    onClick={() => { setConfirmandoEntrega(false); setCodigoDigitos(['','','','']); setErroLocal(null) }}
                    style={{ flex: '0 0 auto' }}
                  >
                    Voltar
                  </button>
                  <button
                    type="button"
                    className="pp-btn pp-btn-avancar"
                    onClick={handleConfirmarComCodigo}
                    disabled={codigoDigitos.some(d => d === '')}
                    style={{ flex: 1 }}
                  >
                    Confirmar entrega
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Empty state ─────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="pp-empty">
      <div className="pp-empty-icon">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
          <rect x="9" y="3" width="6" height="4" rx="1"/>
          <line x1="9" y1="12" x2="15" y2="12"/>
          <line x1="9" y1="16" x2="13" y2="16"/>
        </svg>
      </div>
      <h2 className="pp-empty-titulo">Nenhum pedido ativo</h2>
      <p className="pp-empty-sub">
        Novos pedidos aparecerao aqui instantaneamente. Deixe essa aba aberta.
      </p>
      <div className="pp-empty-dot" aria-hidden="true" />
    </div>
  )
}

// ── Skeleton de loading ─────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="pp-grid">
      {[1, 2, 3].map(i => (
        <div key={i} className="pp-card pp-card-skeleton">
          <div className="pp-skel-row" style={{ width: '45%', marginBottom: 14 }} />
          <div className="pp-skel-row" style={{ width: '100%', height: 56, marginBottom: 12 }} />
          <div className="pp-skel-row" style={{ width: '70%', marginBottom: 8 }} />
          <div className="pp-skel-row" style={{ width: '55%', marginBottom: 8 }} />
          <div className="pp-skel-row" style={{ width: '35%' }} />
        </div>
      ))}
    </div>
  )
}

// ── Config de som (lida do localStorage para respeitar config.somAtivo) ───
// O painel não tem um painel de config próprio aqui, mas respeitamos
// a chave "painelConfig" caso exista — senão, som ligado por padrão.
function somAtivoConfig() {
  try {
    const raw = localStorage.getItem('painelConfig')
    if (!raw) return true
    const cfg = JSON.parse(raw)
    return cfg.somAtivo !== false
  } catch {
    return true
  }
}

// ── Verifica se a loja deveria estar aberta pelo horário ────
function lojaAbertaPorHorario(emp) {
  if (!emp?.horario_abertura || !emp?.horario_fechamento) return true
  const horaBR = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }))
  const minuto = horaBR.getHours() * 60 + horaBR.getMinutes()
  const [aH, aM] = emp.horario_abertura.slice(0, 5).split(':').map(Number)
  const [fH, fM] = emp.horario_fechamento.slice(0, 5).split(':').map(Number)
  return minuto >= aH * 60 + aM && minuto < fH * 60 + fM
}

// ── Toggle reutilizável (liga/desliga) ─────────────────────
function ToggleRow({ label, ativo, onToggle }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={ativo}
        style={{
          width: 44, height: 24, borderRadius: 20, border: 'none', cursor: 'pointer',
          position: 'relative', flexShrink: 0,
          background: ativo ? 'var(--primary, #7c3aed)' : 'var(--border, #3a3a4a)',
          transition: 'background .15s',
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: ativo ? 23 : 3, width: 18, height: 18,
          borderRadius: '50%', background: '#fff', transition: 'left .15s',
        }} />
      </button>
    </div>
  )
}

// Botões da barra lateral direita (extensível — é só adicionar itens aqui)
const RIGHTBAR_BOTOES = [
  {
    id: 'impressora', label: 'Impressora',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 9 6 2 18 2 18 9"/>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
        <rect x="6" y="14" width="12" height="8"/>
      </svg>
    ),
  },
  {
    id: 'pedidos', label: 'Pedidos',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
    ),
  },
  {
    id: 'chat', label: 'Mensagens',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
      </svg>
    ),
  },
  {
    id: 'catalogo', label: 'Catálogo',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    id: 'hoje', label: 'Hoje',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="18" rx="2"/>
        <line x1="16" y1="2" x2="16" y2="6"/>
        <line x1="8" y1="2" x2="8" y2="6"/>
        <line x1="3" y1="10" x2="21" y2="10"/>
        <polyline points="9 16 11 18 15 14"/>
      </svg>
    ),
  },
]

// Timer compacto para os cards "a aceitar"
function MiniTimer({ createdAt, aguardandoDesde, onExpirado }) {
  const [restante, setRestante] = useState(() => getTempoRestante(createdAt, aguardandoDesde))
  const expRef = useRef(false)
  useEffect(() => {
    if (restante === 0) {
      if (!expRef.current) { expRef.current = true; onExpirado() }
      return
    }
    const id = setTimeout(() => setRestante(getTempoRestante(createdAt, aguardandoDesde)), 500)
    return () => clearTimeout(id)
  }, [restante, createdAt, aguardandoDesde, onExpirado])
  const urg = getUrgencia(restante)
  const cor = urg === 'critico' ? '#ef4444' : urg === 'atencao' ? '#f59e0b' : '#16a34a'
  return <span style={{ fontSize: 11, fontWeight: 800, color: cor, whiteSpace: 'nowrap' }}>⏱ {formatarTempo(restante)}</span>
}

// Card compacto do quadro — clica pra abrir o pedido completo
function CardMini({ pedido, onClick, onExpirado }) {
  const oc = ORIGEM_CONFIG[pedido.origem] ?? ORIGEM_CONFIG.cardapio
  const itens = Array.isArray(pedido.itens) ? pedido.itens : []
  const qtdItens = itens.reduce((s, i) => s + Number(i.qtd ?? i.quantidade ?? 1), 0)
  const hora = new Date(pedido.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const isRetirada = (pedido.tipo_entrega || 'entrega') === 'retirada'
  return (
    <button type="button" onClick={onClick} className="pp-mini" style={{ borderLeft: `3px solid ${oc.borda}` }}>
      <div className="pp-mini-top">
        <span className="pp-mini-num">#{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()} · {fmt(pedido.total)}</span>
        {pedido.status === 'aguardando' && onExpirado && (
          <MiniTimer createdAt={pedido.created_at} aguardandoDesde={pedido.aguardando_desde} onExpirado={() => onExpirado(pedido.id)} />
        )}
      </div>
      <div className="pp-mini-sub">{hora} · {pedido.cliente_nome || '—'}</div>
      <div className="pp-mini-tags">
        <span className="pp-mini-badge" style={{ background: oc.bg, color: oc.color }}>{oc.label}</span>
        <span className="pp-mini-itens">{qtdItens} {qtdItens === 1 ? 'item' : 'itens'}</span>
        {isRetirada && <span className="pp-mini-itens">{pedido.origem === 'balcao' ? 'Balcão' : 'Retirada'}</span>}
      </div>
    </button>
  )
}

// Coluna do quadro
function Coluna({ titulo, cor, count, vazio, children }) {
  return (
    <div className="pp-col">
      <div className="pp-col-head" style={{ borderTopColor: cor }}>
        <span>{titulo}</span>
        <span className="pp-col-count" style={{ background: cor }}>{count}</span>
      </div>
      <div className="pp-col-body">
        {count === 0 ? <div className="pp-col-vazio">{vazio}</div> : children}
      </div>
    </div>
  )
}

// ── Conversa aberta (loja respondendo cliente) ──────────────
function ChatConversa({ thread, texto, onTexto, enviando, onEnviar, onVoltar, canalLabel }) {
  const fimRef = useRef(null)
  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: 'end' })
  }, [thread.msgs.length])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)' }}>
      {/* Cabeçalho da conversa */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10, borderBottom: '1px solid var(--border, #2a2a3a)', marginBottom: 8 }}>
        <button type="button" onClick={onVoltar} aria-label="Voltar"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', fontSize: 20, lineHeight: 1, padding: 0 }}>
          ‹
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {thread.cliente_nome || thread.cliente_ref || 'Cliente'}
          </div>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 20,
            background: thread.canal === 'app' ? '#f97316' : '#3b82f6', color: '#fff',
          }}>{canalLabel}</span>
        </div>
      </div>

      {/* Mensagens */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 2px' }}>
        {thread.msgs.map(m => {
          const daLoja = m.remetente === 'loja'
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: daLoja ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth: '82%', padding: '7px 11px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.35,
                background: daLoja ? '#7c3aed' : 'var(--bg, #0f0f1a)',
                color: daLoja ? '#fff' : 'var(--text)',
                border: daLoja ? 'none' : '1px solid var(--border, #2a2a3a)',
                borderBottomRightRadius: daLoja ? 3 : 12,
                borderBottomLeftRadius: daLoja ? 12 : 3,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {m.texto}
                <div style={{ fontSize: 9.5, opacity: .65, marginTop: 3, textAlign: 'right' }}>
                  {new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          )
        })}
        <div ref={fimRef} />
      </div>

      {/* Caixa de resposta */}
      <div style={{ display: 'flex', gap: 6, paddingTop: 8, borderTop: '1px solid var(--border, #2a2a3a)' }}>
        <textarea
          value={texto}
          onChange={e => onTexto(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onEnviar() } }}
          placeholder="Escreva uma resposta..."
          rows={1}
          style={{
            flex: 1, resize: 'none', maxHeight: 90, padding: '9px 11px', borderRadius: 10,
            border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
            color: 'var(--text)', fontSize: 13.5, fontFamily: 'inherit',
          }}
        />
        <button type="button" onClick={onEnviar} disabled={!texto.trim() || enviando}
          style={{
            flexShrink: 0, width: 42, borderRadius: 10, border: 'none', cursor: texto.trim() ? 'pointer' : 'default',
            background: texto.trim() ? '#7c3aed' : 'var(--border, #2a2a3a)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// ── Componente principal ────────────────────────────────────
export default function PainelPedidos() {
  const { empresa, logout } = useAuth()
  const [pedidos, setPedidos] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [lojaAberta, setLojaAberta] = useState(false)
  const [togglingLoja, setTogglingLoja] = useState(false)
  const [avisoHorario, setAvisoHorario] = useState(null)
  const [pedidoRecusando, setPedidoRecusando] = useState(null)
  const [pedidoMensagem, setPedidoMensagem] = useState(null)
  const [vendaAberta, setVendaAberta] = useState(false)
  const [pedidoDetalhe, setPedidoDetalhe] = useState(null) // pedido aberto em detalhe (card completo)
  const [autoImprimir, setAutoImprimir] = useState(autoImprimirAtivo)

  function toggleAutoImprimir() {
    const novo = !autoImprimir
    setAutoImprimir(novo)
    try {
      const cfg = JSON.parse(localStorage.getItem('painelConfig') || '{}')
      cfg.autoImprimir = novo
      localStorage.setItem('painelConfig', JSON.stringify(cfg))
    } catch {
      localStorage.setItem('painelConfig', JSON.stringify({ autoImprimir: novo }))
    }
  }

  function handleImprimir(pedido) {
    imprimirCupom(pedido, empresa)
  }

  // ── Painel lateral direito (Impressora / Pedidos) ─────────
  const [painelDireito, setPainelDireito] = useState(null) // null | 'impressora' | 'pedidos'
  const [larguraCupom, setLarguraCupom] = useState(() => {
    try { return JSON.parse(localStorage.getItem('painelConfig') || '{}').larguraCupom === '58mm' ? '58mm' : '80mm' }
    catch { return '80mm' }
  })
  const [somAtivo, setSomAtivo] = useState(somAtivoConfig)
  const [cupomCfg, setCupomCfg] = useState(() => {
    try { return JSON.parse(localStorage.getItem('painelConfig') || '{}').cupom || {} }
    catch { return {} }
  })
  const [historico, setHistorico] = useState([])
  const [loadingHist, setLoadingHist] = useState(false)
  // Concluídos do dia
  const [concluidosHoje, setConcluidosHoje] = useState([])
  const [loadingHoje, setLoadingHoje] = useState(false)
  // Caixa de entrada (chat com clientes) — a loja responde aqui
  const [chatMsgs, setChatMsgs]       = useState([])
  const [chatAberto, setChatAberto]   = useState(null)   // "canal|cliente_ref"
  const [chatTexto, setChatTexto]     = useState('')
  const [enviandoChat, setEnviandoChat] = useState(false)
  // Catálogo (pausar/ativar itens da loja online)
  const [catalogo, setCatalogo] = useState([])
  const [loadingCatalogo, setLoadingCatalogo] = useState(false)
  const [buscaCatalogo, setBuscaCatalogo] = useState('')
  const [pausandoId, setPausandoId] = useState(null)
  const [qzStatus, setQzStatus] = useState('idle') // idle | verificando | ok | sem-qz
  const [impressoras, setImpressoras] = useState([])
  const [impressoraPadrao, setImpressoraPadrao] = useState(null)
  const [impressoraSel, setImpressoraSel] = useState(() => {
    try { return JSON.parse(localStorage.getItem('painelConfig') || '{}').impressora || '' }
    catch { return '' }
  })

  function patchPainelConfig(patch) {
    try {
      const cfg = JSON.parse(localStorage.getItem('painelConfig') || '{}')
      Object.assign(cfg, patch)
      localStorage.setItem('painelConfig', JSON.stringify(cfg))
    } catch {
      localStorage.setItem('painelConfig', JSON.stringify(patch))
    }
  }

  function escolherLargura(v) { setLarguraCupom(v); patchPainelConfig({ larguraCupom: v }) }
  function toggleSom() { const novo = !somAtivo; setSomAtivo(novo); patchPainelConfig({ somAtivo: novo }) }
  function setCupom(patch) {
    setCupomCfg(prev => {
      const novo = { ...prev, ...patch }
      patchPainelConfig({ cupom: novo })
      return novo
    })
  }

  function imprimirTeste() {
    imprimirCupom({
      numero_pedido: 'TESTE',
      created_at: new Date().toISOString(),
      tipo_entrega: 'entrega',
      cliente_nome: 'Cliente Teste',
      cliente_telefone: '(00) 00000-0000',
      endereco_rua: 'Rua Exemplo', endereco_numero: '123',
      endereco_bairro: 'Centro', endereco_cidade: 'Cidade',
      itens: [{ nome: 'Produto A', qtd: 2, preco: 5 }, { nome: 'Produto B', qtd: 1, preco: 3.5 }],
      subtotal: 13.5, taxa_entrega: 5, total: 18.5,
      forma_pagamento: 'dinheiro', troco_para: 50,
      observacoes: 'Cupom de teste de impressão', codigo_entrega: '0000',
    }, empresa)
  }

  const carregarHistorico = useCallback(async () => {
    if (!empresa) return
    setLoadingHist(true)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .in('status', ['entregue', 'cancelado'])
      .order('created_at', { ascending: false })
      .limit(40)
    setHistorico(data || [])
    setLoadingHist(false)
  }, [empresa])

  useEffect(() => {
    if (painelDireito === 'pedidos') carregarHistorico()
  }, [painelDireito, carregarHistorico])

  // ── Concluídos do dia (vendas finalizadas hoje) ─────────────
  const carregarConcluidosHoje = useCallback(async () => {
    if (!empresa) return
    setLoadingHoje(true)
    const inicio = new Date()
    inicio.setHours(0, 0, 0, 0)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .eq('status', 'entregue')
      .gte('created_at', inicio.toISOString())
      .order('created_at', { ascending: false })
    setConcluidosHoje(data || [])
    setLoadingHoje(false)
  }, [empresa])

  useEffect(() => {
    if (painelDireito === 'hoje') carregarConcluidosHoje()
  }, [painelDireito, carregarConcluidosHoje])

  // Carrega a coluna "Concluídos" do quadro assim que o painel abre
  useEffect(() => { carregarConcluidosHoje() }, [carregarConcluidosHoje])

  // ── Chat: carrega mensagens e escuta em tempo real ──────────
  useEffect(() => {
    if (!empresa) return
    let ativo = true
    ;(async () => {
      const { data } = await supabase
        .from('mensagens_chat')
        .select('*')
        .eq('empresa_id', empresa.id)
        .order('created_at', { ascending: true })
        .limit(500)
      if (ativo) setChatMsgs(data || [])
    })()
    const canal = supabase
      .channel(`chat_${empresa.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'mensagens_chat', filter: `empresa_id=eq.${empresa.id}` },
        payload => {
          if (payload.eventType === 'INSERT') {
            setChatMsgs(prev => prev.some(m => m.id === payload.new.id) ? prev : [...prev, payload.new])
          } else if (payload.eventType === 'UPDATE') {
            setChatMsgs(prev => prev.map(m => m.id === payload.new.id ? payload.new : m))
          }
        })
      .subscribe()
    return () => { ativo = false; canal.unsubscribe() }
  }, [empresa])

  // Marca como lidas as mensagens do cliente ao abrir a conversa, e envia resposta
  async function abrirThread(t) {
    setChatAberto(t.key)
    const naoLidas = t.msgs.filter(m => m.remetente === 'cliente' && !m.lida).map(m => m.id)
    if (naoLidas.length) {
      setChatMsgs(prev => prev.map(m => naoLidas.includes(m.id) ? { ...m, lida: true } : m))
      await supabase.from('mensagens_chat').update({ lida: true }).in('id', naoLidas)
    }
  }
  async function enviarChat() {
    const txt = chatTexto.trim()
    if (!txt || !chatAberto) return
    const sep = chatAberto.indexOf('|')
    const canal = chatAberto.slice(0, sep)
    const cliente_ref = chatAberto.slice(sep + 1)
    const thread = chatMsgs.find(m => `${m.canal}|${m.cliente_ref}` === chatAberto)
    setEnviandoChat(true)
    const { error } = await supabase.from('mensagens_chat').insert({
      empresa_id: empresa.id, canal, cliente_ref,
      cliente_nome: thread?.cliente_nome ?? null, remetente: 'loja', texto: txt,
    })
    setEnviandoChat(false)
    if (!error) setChatTexto('')
  }

  // ── Catálogo: carrega os produtos da loja ───────────────────
  const carregarCatalogo = useCallback(async () => {
    if (!empresa) return
    setLoadingCatalogo(true)
    const { data } = await supabase
      .from('produtos')
      .select('id, nome, preco_venda, categoria, disponivel_delivery')
      .eq('empresa_id', empresa.id)
      .order('nome', { ascending: true })
    setCatalogo(data || [])
    setLoadingCatalogo(false)
  }, [empresa])

  useEffect(() => {
    if (painelDireito === 'catalogo') carregarCatalogo()
  }, [painelDireito, carregarCatalogo])

  // Pausa/reativa um item — pausado some da loja online na hora.
  async function togglePausarProduto(prod) {
    const novo = !prod.disponivel_delivery
    setPausandoId(prod.id)
    setCatalogo(prev => prev.map(p => p.id === prod.id ? { ...p, disponivel_delivery: novo } : p))
    const { error } = await supabase
      .from('produtos')
      .update({ disponivel_delivery: novo })
      .eq('id', prod.id)
    setPausandoId(null)
    if (error) {
      // reverte em caso de falha
      setCatalogo(prev => prev.map(p => p.id === prod.id ? { ...p, disponivel_delivery: prod.disponivel_delivery } : p))
    }
  }

  async function detectarImpressoras() {
    setQzStatus('verificando')
    try {
      const { printers, padrao } = await qzListarImpressoras()
      setImpressoras(printers)
      setImpressoraPadrao(padrao)
      setQzStatus('ok')
      // Sem impressora escolhida ainda? sugere a padrão do PC
      setImpressoraSel(prev => {
        if (prev) return prev
        if (padrao) { patchPainelConfig({ impressora: padrao }); return padrao }
        return prev
      })
    } catch {
      setQzStatus('sem-qz')
    }
  }

  function escolherImpressora(name) {
    setImpressoraSel(name)
    patchPainelConfig({ impressora: name })
  }

  useEffect(() => {
    if (painelDireito === 'impressora') detectarImpressoras()
  }, [painelDireito]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Ref para o intervalo do loop de som ───────────────────
  const somLoopRef = useRef(null)

  function iniciarLoopSom() {
    if (!somAtivoConfig()) return
    if (somLoopRef.current) return // já rodando
    tocarSom()
    somLoopRef.current = setInterval(tocarSom, 3000)
  }

  function pararLoopSom() {
    if (somLoopRef.current) {
      clearInterval(somLoopRef.current)
      somLoopRef.current = null
    }
  }

  // ── Atualiza <title> com contagem ──────────────────────────
  const total = pedidos.length
  useEffect(() => {
    document.title = total > 0 ? `(${total}) Gestor` : 'Gestor'
    return () => { document.title = 'CRM' }
  }, [total])

  // ── Para o loop de som quando não há mais pedidos aguardando ─
  useEffect(() => {
    const temAguardando = pedidos.some(p => p.status === 'aguardando')
    if (!temAguardando) {
      pararLoopSom()
    }
  }, [pedidos]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sincroniza estado de loja com empresa ─────────────────
  useEffect(() => {
    if (empresa) setLojaAberta(empresa.delivery_ativo ?? false)
  }, [empresa])

  // ── Auto-fecha pelo horário de funcionamento ───────────────
  useEffect(() => {
    if (!empresa) return
    function verificarHorario() {
      if (!lojaAbertaPorHorario(empresa)) {
        setLojaAberta(prev => {
          if (prev) {
            supabase.from('empresas').update({ delivery_ativo: false }).eq('id', empresa.id).then(() => {})
          }
          return false
        })
      }
    }
    verificarHorario()
    const id = setInterval(verificarHorario, 60_000)
    return () => clearInterval(id)
  }, [empresa]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Heartbeat: sinaliza que o painel está online ───────────
  // Atualiza last_heartbeat_at a cada 60s enquanto a aba estiver aberta.
  // O portal mostra "Aberta" só se o heartbeat chegou há menos de 2 min.
  useEffect(() => {
    if (!empresa) return
    async function heartbeat() {
      await supabase
        .from('empresas')
        .update({ last_heartbeat_at: new Date().toISOString() })
        .eq('id', empresa.id)
    }
    heartbeat()
    const timer = setInterval(heartbeat, 60_000)
    return () => clearInterval(timer)
  }, [empresa])

  // ── Busca inicial: todos os pedidos ativos (não finalizados) ──
  const carregarPedidos = useCallback(async () => {
    if (!empresa) return
    setCarregando(true)
    const { data } = await supabase
      .from('pedidos_delivery')
      .select('*')
      .eq('empresa_id', empresa.id)
      .not('status', 'in', '("entregue","cancelado","aguardando_pagamento")')
      .order('created_at', { ascending: true }) // mais antigos primeiro — urgência visual natural
    setPedidos(data || [])
    setCarregando(false)
  }, [empresa])

  // ── Realtime subscription + polling de segurança + visibilidade ──
  useEffect(() => {
    if (!empresa) return
    carregarPedidos()

    // Bug 2 — reconexão: ao reconectar (status SUBSCRIBED) recarrega os pedidos
    const channel = supabase
      .channel(`painel_pedidos_${empresa.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pedidos_delivery',
          filter: `empresa_id=eq.${empresa.id}`,
        },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const novo = payload.new
            // Só adiciona ao painel se não for finalizado E não for aguardando pagamento PIX
            if (!STATUS_FINALIZADOS.has(novo.status) && novo.status !== 'aguardando_pagamento') {
              setPedidos(prev => [...prev, novo])
              if (novo.status === 'aguardando') {
                iniciarLoopSom()
                if (autoImprimirAtivo()) imprimirCupom(novo, empresa)
              }
            }
          } else if (payload.eventType === 'UPDATE') {
            const { new: novo } = payload
            if (STATUS_FINALIZADOS.has(novo.status)) {
              // Pedido finalizado — remove do painel
              setPedidos(prev => prev.filter(p => p.id !== novo.id))
            } else if (novo.status !== 'aguardando_pagamento') {
              setPedidos(prev => {
                const jaEstaNopainel = prev.some(p => p.id === novo.id)
                if (!jaEstaNopainel) {
                  // Pedido chegou ao painel agora (ex: PIX confirmado)
                  if (novo.status === 'aguardando') {
                    iniciarLoopSom()
                    if (autoImprimirAtivo()) imprimirCupom(novo, empresa)
                  }
                  return [...prev, novo]
                }
                // Atualiza card existente
                return prev.map(p => p.id === novo.id ? { ...p, ...novo } : p)
              })
            }
          } else if (payload.eventType === 'DELETE') {
            setPedidos(prev => prev.filter(p => p.id !== payload.old.id))
          }
        }
      )
      .subscribe((status) => {
        // Bug 2 — reconexão: recarrega pedidos ao (re)conectar o canal
        if (status === 'SUBSCRIBED') {
          carregarPedidos()
        }
      })

    // Bug 2 — polling de segurança: garante atualização a cada 30s
    // mesmo que o Realtime esteja caído
    const pollingId = setInterval(carregarPedidos, 30_000)

    // Bug 2 — visibilidade: recarrega ao voltar para a aba
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') {
        carregarPedidos()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      channel.unsubscribe()
      clearInterval(pollingId)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      // Bug 1 — cleanup: para o loop de som ao desmontar o componente
      pararLoopSom()
    }
  }, [empresa, carregarPedidos]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-conclusão de pedidos parados em "saiu para entrega" ──
  // Verifica a cada minuto se algum pedido saiu para entrega há mais
  // de 6h sem ter o código confirmado e o conclui automaticamente.
  // Fallback de referência: saiu_entrega_at → updated_at → created_at
  // (pedidos antigos não têm saiu_entrega_at preenchido).
  useEffect(() => {
    function verificarParados() {
      const agora = Date.now()
      pedidos.forEach(p => {
        if (p.status !== 'saiu_entrega') return
        const ref = p.saiu_entrega_at ?? p.updated_at ?? p.created_at
        if (!ref) return
        if (agora - new Date(ref).getTime() >= AUTO_CONCLUIR_ENTREGA_MS) {
          // Conclui automaticamente — remove do painel e marca entregue no banco.
          setPedidos(prev => prev.filter(x => x.id !== p.id))
          supabase
            .from('pedidos_delivery')
            .update({ status: 'entregue' })
            .eq('id', p.id)
            .eq('status', 'saiu_entrega') // guarda: só conclui se ainda estiver saindo
            .then(() => {})
        }
      })
    }
    verificarParados()
    const id = setInterval(verificarParados, 60_000)
    return () => clearInterval(id)
  }, [pedidos])

  // ── Handlers ──────────────────────────────────────────────
  async function notificarCliente(pedidoId, novoStatus) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      fetch(`${SUPABASE_URL}/functions/v1/whatsapp-pedido-notify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ pedido_id: pedidoId, novo_status: novoStatus }),
      })
    } catch {
      // silencioso — notificação é best-effort
    }
  }

  async function handleAvancar(id, novoStatus) {
    const update = { status: novoStatus }

    // Gera código de confirmação de 4 dígitos ao despachar.
    // O cliente apresenta esse código ao entregador para confirmar o recebimento.
    if (novoStatus === 'saiu_entrega') {
      update.codigo_entrega = String(Math.floor(1000 + Math.random() * 9000))
      // Marca quando saiu para entrega — usado pelo auto-conclusão de 6h.
      update.saiu_entrega_at = new Date().toISOString()
    }

    // Atualização otimista — resposta imediata sem esperar Realtime
    if (STATUS_FINALIZADOS.has(novoStatus)) {
      setPedidos(prev => prev.filter(p => p.id !== id))
    } else {
      setPedidos(prev => prev.map(p => p.id === id ? { ...p, ...update } : p))
    }

    await supabase
      .from('pedidos_delivery')
      .update(update)
      .eq('id', id)

    // Pedido concluído → recarrega a coluna "Concluídos hoje"
    if (novoStatus === 'entregue') carregarConcluidosHoje()

    notificarCliente(id, novoStatus)
  }

  async function handleConfirmar(id) {
    await handleAvancar(id, 'confirmado')
  }

  async function handleConfirmarRecusa(id, motivo) {
    setPedidos(prev => prev.filter(p => p.id !== id))
    setPedidoRecusando(null)

    // Se o pedido foi pago via PIX, aciona reembolso automático via Edge Function
    const pedido = pedidos.find(p => p.id === id)
    if (pedido?.mp_payment_id) {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch(`${SUPABASE_URL}/functions/v1/refund-pix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ order_id: id, motivo }),
      })
    } else {
      await supabase
        .from('pedidos_delivery')
        .update({ status: 'cancelado', motivo_cancelamento: motivo })
        .eq('id', id)
    }

    notificarCliente(id, 'cancelado')
  }

  async function handleExpirado(id) {
    const pedido = pedidos.find(p => p.id === id)
    setPedidos(prev => prev.filter(p => p.id !== id))

    if (pedido?.mp_payment_id) {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch(`${SUPABASE_URL}/functions/v1/refund-pix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ order_id: id, motivo: 'Tempo de aceite esgotado' }),
      })
    } else {
      await supabase
        .from('pedidos_delivery')
        .update({ status: 'cancelado', motivo_cancelamento: 'Tempo de aceite esgotado' })
        .eq('id', id)
        .eq('status', 'aguardando')
    }

    notificarCliente(id, 'cancelado')
  }

  async function handleEnviarMensagem(pedido, texto) {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/whatsapp-connect`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          action: 'send_message',
          phone: pedido.cliente_telefone,
          text: texto,
        }),
      })
      const data = await res.json()
      return data.ok === true
    } catch {
      return false
    }
  }

  async function handleToggleLoja() {
    if (!empresa || togglingLoja) return
    const tentandoAbrir = !lojaAberta
    // Bloqueia abertura manual fora do horário
    if (tentandoAbrir && !lojaAbertaPorHorario(empresa)) {
      const ab = empresa.horario_abertura?.slice(0, 5)
      const fe = empresa.horario_fechamento?.slice(0, 5)
      setAvisoHorario(`Horário de funcionamento: ${ab} às ${fe}. Ajuste em Minha Loja para abrir fora do horário.`)
      setTimeout(() => setAvisoHorario(null), 5000)
      return
    }
    setTogglingLoja(true)
    const { error } = await supabase
      .from('empresas')
      .update({ delivery_ativo: tentandoAbrir })
      .eq('id', empresa.id)
    if (!error) setLojaAberta(tentandoAbrir)
    setTogglingLoja(false)
  }

  // ── Loading inicial (sem empresa ainda) ───────────────────
  if (!empresa) {
    return (
      <div className="pp-loading">
        <div className="pp-spinner" aria-hidden="true" />
        <span className="pp-loading-text">Carregando painel...</span>
      </div>
    )
  }

  const catalogoFiltrado = catalogo.filter(p =>
    !buscaCatalogo.trim() || p.nome?.toLowerCase().includes(buscaCatalogo.trim().toLowerCase())
  )

  // Agrupa as mensagens em conversas (canal + cliente)
  const chatThreads = Object.values(chatMsgs.reduce((acc, m) => {
    const k = `${m.canal}|${m.cliente_ref}`
    if (!acc[k]) acc[k] = { key: k, canal: m.canal, cliente_ref: m.cliente_ref, cliente_nome: m.cliente_nome, msgs: [], unread: 0 }
    acc[k].msgs.push(m)
    if (m.cliente_nome) acc[k].cliente_nome = m.cliente_nome
    if (m.remetente === 'cliente' && !m.lida) acc[k].unread++
    return acc
  }, {})).sort((a, b) =>
    new Date(b.msgs[b.msgs.length - 1].created_at) - new Date(a.msgs[a.msgs.length - 1].created_at)
  )
  const chatNaoLidas = chatThreads.reduce((s, t) => s + t.unread, 0)
  const threadAberta = chatThreads.find(t => t.key === chatAberto)
  const CANAL_LABEL = { app: 'App', lojaonline: 'Loja online', whatsapp: 'WhatsApp' }

  return (
    <div className="pp-root">
      {/* Header fixo */}
      <header className="pp-header">
        <div className="pp-header-left">
          {/* Logo mark */}
          <div className="pp-logo-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
          <span className="pp-loja-nome">{empresa.nome || 'Gestor'}</span>
          {total > 0 && (
            <span className="pp-count-badge" aria-label={`${total} pedidos ativos`}>
              {total}
            </span>
          )}
        </div>

        <div className="pp-header-right">
          {/* Nova venda (balcão / PDV) */}
          <button
            type="button"
            className="pp-toggle-loja aberta"
            onClick={() => setVendaAberta(true)}
            title="Registrar uma venda no balcão"
            style={{ background: '#7c3aed', borderColor: '#7c3aed', color: '#fff' }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>Vender</span>
          </button>

          {/* Sair */}
          <button type="button" className="pp-back-link" title="Sair" onClick={logout}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            <span>Sair</span>
          </button>

          {/* Toggle impressão automática */}
          <button
            type="button"
            className={`pp-toggle-loja ${autoImprimir ? 'aberta' : 'fechada'}`}
            onClick={toggleAutoImprimir}
            title={autoImprimir ? 'Imprimir cupom automaticamente ao chegar pedido' : 'Impressão automática desligada'}
            aria-label="Alternar impressão automática"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9"/>
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
              <rect x="6" y="14" width="12" height="8"/>
            </svg>
            <span>{autoImprimir ? 'Auto-imprimir ON' : 'Auto-imprimir OFF'}</span>
          </button>

          {/* Toggle loja */}
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className={`pp-toggle-loja ${lojaAberta ? 'aberta' : 'fechada'}`}
              onClick={handleToggleLoja}
              disabled={togglingLoja}
              aria-label={lojaAberta ? 'Loja aberta — clique para fechar' : 'Loja fechada — clique para abrir'}
            >
              <span className="pp-toggle-dot" aria-hidden="true" />
              <span>{togglingLoja ? 'Aguarde...' : lojaAberta ? 'Loja aberta' : 'Loja fechada'}</span>
            </button>
            {avisoHorario && (
              <div style={{
                position: 'absolute', top: 'calc(100% + 8px)', right: 0,
                background: '#1e293b', border: '1px solid #f59e0b',
                color: '#fbbf24', borderRadius: 8, padding: '8px 12px',
                fontSize: 12, whiteSpace: 'nowrap', zIndex: 999,
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              }}>
                ⏰ {avisoHorario}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Corpo — quadro com 4 colunas (cards compactos; clica pra ver completo) */}
      <main className="pp-body" style={{ paddingRight: 56 }}>
        {carregando ? (
          <SkeletonGrid />
        ) : (
          <div className="pp-board">
            <Coluna titulo="A aceitar" cor="#ca8a04"
              count={pedidos.filter(p => p.status === 'aguardando').length}
              vazio="Nenhum pedido novo">
              {pedidos.filter(p => p.status === 'aguardando').map(p => (
                <CardMini key={p.id} pedido={p} onExpirado={handleExpirado} onClick={() => setPedidoDetalhe(p)} />
              ))}
            </Coluna>

            <Coluna titulo="Na cozinha" cor="#1d4ed8"
              count={pedidos.filter(p => p.status === 'confirmado' || p.status === 'em_preparo').length}
              vazio="Nada em preparo">
              {pedidos.filter(p => p.status === 'confirmado' || p.status === 'em_preparo').map(p => (
                <CardMini key={p.id} pedido={p} onClick={() => setPedidoDetalhe(p)} />
              ))}
            </Coluna>

            <Coluna titulo="Em entrega" cor="#7c3aed"
              count={pedidos.filter(p => p.status === 'saiu_entrega').length}
              vazio="Ninguém na rua">
              {pedidos.filter(p => p.status === 'saiu_entrega').map(p => (
                <CardMini key={p.id} pedido={p} onClick={() => setPedidoDetalhe(p)} />
              ))}
            </Coluna>

            <Coluna titulo="Concluídos hoje" cor="#16a34a"
              count={concluidosHoje.length}
              vazio="Nenhum concluído hoje">
              {concluidosHoje.map(p => (
                <CardMini key={p.id} pedido={p} onClick={() => setPedidoDetalhe(p)} />
              ))}
            </Coluna>
          </div>
        )}
      </main>

      {/* Modal de recusa */}
      {pedidoRecusando && (
        <ModalRecusa
          pedido={pedidoRecusando}
          onConfirmar={handleConfirmarRecusa}
          onFechar={() => setPedidoRecusando(null)}
        />
      )}

      {/* Modal de mensagem WhatsApp */}
      {pedidoMensagem && (
        <ModalMensagem
          pedido={pedidoMensagem}
          onEnviar={handleEnviarMensagem}
          onFechar={() => setPedidoMensagem(null)}
        />
      )}

      {/* Modal de venda no balcão (PDV) */}
      {vendaAberta && (
        <ModalVenda
          empresa={empresa}
          onFechar={() => setVendaAberta(false)}
          onCriado={carregarPedidos}
        />
      )}

      {/* Detalhe do pedido — card completo ao clicar num card compacto */}
      {pedidoDetalhe && (
        <div className="pp-modal-overlay" onClick={() => setPedidoDetalhe(null)} style={{ zIndex: 120 }}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(440px, 94vw)', maxHeight: '92vh', overflowY: 'auto' }}>
            <CardPedido
              pedido={pedidos.find(p => p.id === pedidoDetalhe.id) || concluidosHoje.find(p => p.id === pedidoDetalhe.id) || pedidoDetalhe}
              onConfirmar={(id) => { handleConfirmar(id); setPedidoDetalhe(null) }}
              onRecusar={(p) => { setPedidoRecusando(p); setPedidoDetalhe(null) }}
              onExpirado={(id) => { handleExpirado(id); setPedidoDetalhe(null) }}
              onAvancar={(id, st) => { handleAvancar(id, st); setPedidoDetalhe(null) }}
              onEnviarMensagem={(p) => { setPedidoMensagem(p); setPedidoDetalhe(null) }}
              onImprimir={handleImprimir}
            />
          </div>
        </div>
      )}

      {/* ── Gaveta lateral direita ── */}
      {painelDireito && (
        <aside style={{
          position: 'fixed', top: 60, right: 56, bottom: 0, width: 'min(340px, 82vw)', zIndex: 39,
          background: 'var(--surface, #16161f)', borderLeft: '1px solid var(--border, #2a2a3a)',
          boxShadow: '-8px 0 24px rgba(0,0,0,.25)', overflowY: 'auto', padding: 16,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--text)' }}>
              {painelDireito === 'impressora' ? 'Impressora'
                : painelDireito === 'pedidos' ? 'Pedidos finalizados'
                : painelDireito === 'hoje' ? 'Concluídos hoje'
                : painelDireito === 'chat' ? 'Mensagens'
                : 'Catálogo'}
            </h3>
            <button type="button" onClick={() => setPainelDireito(null)} aria-label="Fechar"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 22, lineHeight: 1 }}>
              ×
            </button>
          </div>

          {/* Painel: Mensagens (chat App + Loja online) */}
          {painelDireito === 'chat' && (
            threadAberta ? (
              <ChatConversa
                thread={threadAberta}
                texto={chatTexto}
                onTexto={setChatTexto}
                enviando={enviandoChat}
                onEnviar={enviarChat}
                onVoltar={() => setChatAberto(null)}
                canalLabel={CANAL_LABEL[threadAberta.canal] ?? threadAberta.canal}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {chatThreads.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 12px', fontSize: 13 }}>
                    Nenhuma conversa ainda.<br />
                    Mensagens do app e da loja online aparecem aqui.
                  </div>
                ) : chatThreads.map(t => {
                  const ultima = t.msgs[t.msgs.length - 1]
                  const hora = new Date(ultima.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                  const canalLbl = CANAL_LABEL[t.canal] ?? t.canal
                  return (
                    <button key={t.key} type="button" onClick={() => abrirThread(t)}
                      style={{
                        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                        border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '10px 12px',
                        background: t.unread ? 'rgba(124,58,237,.08)' : 'transparent',
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.cliente_nome || t.cliente_ref || 'Cliente'}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{hora}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        <span style={{
                          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 20, flexShrink: 0,
                          background: t.canal === 'app' ? '#f97316' : '#3b82f6', color: '#fff',
                        }}>{canalLbl}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {ultima.remetente === 'loja' ? 'Você: ' : ''}{ultima.texto}
                        </span>
                        {t.unread > 0 && (
                          <span style={{ flexShrink: 0, minWidth: 18, height: 18, borderRadius: 9, background: '#7c3aed', color: '#fff', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>
                            {t.unread}
                          </span>
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          )}

          {/* Painel: Impressora */}
          {painelDireito === 'impressora' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* QZ Tray — impressora do PC */}
              <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Impressora do PC</span>
                  {qzStatus === 'ok' && <span style={{ fontSize: 11, color: '#16a34a', fontWeight: 700 }}>● Conectado</span>}
                  {qzStatus === 'verificando' && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>verificando…</span>}
                  {qzStatus === 'sem-qz' && <span style={{ fontSize: 11, color: '#dc2626', fontWeight: 700 }}>● Não encontrado</span>}
                </div>

                {qzStatus === 'ok' && (
                  <>
                    {impressoras.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#dc2626' }}>Nenhuma impressora encontrada neste PC.</div>
                    ) : (
                      <select
                        value={impressoraSel}
                        onChange={e => escolherImpressora(e.target.value)}
                        style={{
                          width: '100%', padding: '8px 10px', borderRadius: 8,
                          border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
                          color: 'var(--text)', fontSize: 13,
                        }}
                      >
                        <option value="">Selecione a impressora</option>
                        {impressoras.map(p => (
                          <option key={p} value={p}>{p}{p === impressoraPadrao ? ' (padrão)' : ''}</option>
                        ))}
                      </select>
                    )}
                    <button type="button" onClick={detectarImpressoras} style={{
                      alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--primary, #a78bfa)', fontSize: 12, fontWeight: 700, padding: 0,
                    }}>
                      ↻ Atualizar lista
                    </button>
                  </>
                )}

                {qzStatus === 'sem-qz' && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    Para escolher a impressora e imprimir automático, instale o <strong>QZ Tray</strong> (grátis) neste computador e deixe o programa aberto.
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <a href="https://qz.io/download/" target="_blank" rel="noreferrer" style={{
                        flex: 1, textAlign: 'center', padding: '8px 0', borderRadius: 8,
                        background: 'var(--primary, #7c3aed)', color: '#fff', fontWeight: 700, fontSize: 13, textDecoration: 'none',
                      }}>
                        Baixar QZ Tray
                      </a>
                      <button type="button" onClick={detectarImpressoras} style={{
                        padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border, #2a2a3a)',
                        cursor: 'pointer', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 13,
                      }}>
                        Tentar de novo
                      </button>
                    </div>
                  </div>
                )}

                {qzStatus === 'verificando' && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Procurando o QZ Tray…</div>
                )}
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>Largura do cupom</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['80mm', '58mm'].map(w => (
                    <button key={w} type="button" onClick={() => escolherLargura(w)} style={{
                      flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      border: `1.5px solid ${larguraCupom === w ? 'var(--primary, #7c3aed)' : 'var(--border, #2a2a3a)'}`,
                      background: larguraCupom === w ? 'rgba(124,58,237,.15)' : 'transparent',
                      color: larguraCupom === w ? 'var(--primary, #a78bfa)' : 'var(--text)',
                    }}>{w}</button>
                  ))}
                </div>
              </div>

              {/* Cupom — o que aparece */}
              <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>Cupom — o que aparece</span>

                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Tamanho da fonte</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[['normal', 'Normal'], ['grande', 'Grande']].map(([v, lbl]) => {
                      const ativo = (cupomCfg.fonte === 'grande' ? 'grande' : 'normal') === v
                      return (
                        <button key={v} type="button" onClick={() => setCupom({ fonte: v })} style={{
                          flex: 1, padding: '8px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                          border: `1.5px solid ${ativo ? 'var(--primary, #7c3aed)' : 'var(--border, #2a2a3a)'}`,
                          background: ativo ? 'rgba(124,58,237,.15)' : 'transparent',
                          color: ativo ? 'var(--primary, #a78bfa)' : 'var(--text)',
                        }}>{lbl}</button>
                      )
                    })}
                  </div>
                </div>

                <ToggleRow label="Telefone do cliente" ativo={cupomCfg.telCliente !== false} onToggle={() => setCupom({ telCliente: cupomCfg.telCliente === false })} />
                <ToggleRow label="Endereço de entrega" ativo={cupomCfg.endereco !== false} onToggle={() => setCupom({ endereco: cupomCfg.endereco === false })} />
                <ToggleRow label="Taxa de entrega" ativo={cupomCfg.taxa !== false} onToggle={() => setCupom({ taxa: cupomCfg.taxa === false })} />
                <ToggleRow label="Observações" ativo={cupomCfg.obs !== false} onToggle={() => setCupom({ obs: cupomCfg.obs === false })} />
                <ToggleRow label="Código de entrega" ativo={cupomCfg.codigo !== false} onToggle={() => setCupom({ codigo: cupomCfg.codigo === false })} />
                <ToggleRow label="Total de itens" ativo={cupomCfg.totalItens === true} onToggle={() => setCupom({ totalItens: !(cupomCfg.totalItens === true) })} />
              </div>

              <ToggleRow label="Imprimir automático" ativo={autoImprimir} onToggle={toggleAutoImprimir} />
              <ToggleRow label="Som de novo pedido" ativo={somAtivo} onToggle={toggleSom} />

              <button type="button" onClick={imprimirTeste} style={{
                padding: '10px 0', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: 'var(--primary, #7c3aed)', color: '#fff', fontWeight: 700, fontSize: 14,
              }}>
                Imprimir cupom de teste
              </button>

              <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Com o <strong>QZ Tray</strong> instalado e aberto, o cupom imprime sozinho na impressora escolhida — sem janela.{' '}
                <a href="https://qz.io/download/" target="_blank" rel="noreferrer" style={{ color: 'var(--primary, #a78bfa)', fontWeight: 700 }}>
                  Baixar QZ Tray
                </a>
              </p>
            </div>
          )}

          {/* Painel: Pedidos finalizados (histórico + reimpressão) */}
          {painelDireito === 'pedidos' && (
            loadingHist ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Carregando...</div>
            ) : historico.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Nenhum pedido finalizado ainda.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {historico.map(p => {
                  const st = BADGE_STATUS_COR[p.status] ?? BADGE_STATUS_COR.entregue
                  return (
                    <div key={p.id} style={{
                      border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '10px 12px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                          #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()} · {fmt(p.total)}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          {new Date(p.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: st.bg, color: st.color }}>
                          {LABEL_STATUS[p.status] ?? p.status}
                        </span>
                      </div>
                      <button type="button" onClick={() => imprimirCupom(p, empresa)} title="Reimprimir cupom"
                        style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', borderRadius: 8, cursor: 'pointer', padding: 6, color: 'var(--text-muted)', flexShrink: 0 }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <polyline points="6 9 6 2 18 2 18 9"/>
                          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                          <rect x="6" y="14" width="12" height="8"/>
                        </svg>
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          )}

          {/* Painel: Catálogo (pausar/ativar itens da loja online) */}
          {painelDireito === 'catalogo' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
                Pause um item quando ele acabar — ele <strong>some da loja online na hora</strong>. Reative quando voltar ao estoque.
              </p>
              <input
                type="search"
                value={buscaCatalogo}
                onChange={e => setBuscaCatalogo(e.target.value)}
                placeholder="Buscar produto..."
                style={{
                  width: '100%', padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)',
                  color: 'var(--text)', fontSize: 13,
                }}
              />
              {loadingCatalogo ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Carregando...</div>
              ) : catalogoFiltrado.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>
                  {buscaCatalogo ? 'Nenhum produto encontrado.' : 'Nenhum produto cadastrado.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {catalogoFiltrado.map(prod => {
                    const pausado = prod.disponivel_delivery === false
                    return (
                      <div key={prod.id} style={{
                        border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '10px 12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                        opacity: pausado ? 0.6 : 1,
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {prod.nome}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {fmt(prod.preco_venda)}{prod.categoria ? ` · ${prod.categoria}` : ''}
                            {pausado && <span style={{ color: '#dc2626', fontWeight: 700 }}> · Pausado</span>}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => togglePausarProduto(prod)}
                          disabled={pausandoId === prod.id}
                          style={{
                            flexShrink: 0, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
                            fontWeight: 700, fontSize: 12, border: '1.5px solid',
                            borderColor: pausado ? '#16a34a' : '#dc2626',
                            background: pausado ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
                            color: pausado ? '#16a34a' : '#dc2626',
                          }}
                        >
                          {pausandoId === prod.id ? '...' : pausado ? 'Ativar' : 'Pausar'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          {/* Painel: Concluídos do dia */}
          {painelDireito === 'hoje' && (
            loadingHoje ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>Carregando...</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Resumo do dia */}
                <div style={{ border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '12px 14px', background: 'rgba(34,197,94,.08)' }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 700 }}>
                    {concluidosHoje.length} pedido{concluidosHoje.length !== 1 ? 's' : ''} concluído{concluidosHoje.length !== 1 ? 's' : ''} hoje
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#16a34a', marginTop: 2 }}>
                    {fmt(concluidosHoje.reduce((s, p) => s + Number(p.total || 0), 0))}
                  </div>
                </div>

                {concluidosHoje.length === 0 ? (
                  <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20, fontSize: 13 }}>
                    Nenhum pedido concluído hoje ainda.
                  </div>
                ) : (
                  concluidosHoje.map(p => {
                    const oc = ORIGEM_CONFIG[p.origem] ?? ORIGEM_CONFIG.cardapio
                    return (
                      <div key={p.id} style={{
                        border: '1px solid var(--border, #2a2a3a)', borderRadius: 10, padding: '10px 12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
                            #{p.numero_pedido ?? p.id.slice(-4).toUpperCase()} · {fmt(p.total)}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {new Date(p.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · {p.cliente_nome || '—'}
                          </div>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, background: oc.bg, color: oc.color }}>
                            {oc.label}
                          </span>
                        </div>
                        <button type="button" onClick={() => imprimirCupom(p, empresa)} title="Reimprimir cupom"
                          style={{ background: 'none', border: '1px solid var(--border, #2a2a3a)', borderRadius: 8, cursor: 'pointer', padding: 6, color: 'var(--text-muted)', flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="6 9 6 2 18 2 18 9"/>
                            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                            <rect x="6" y="14" width="12" height="8"/>
                          </svg>
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
            )
          )}
        </aside>
      )}

      {/* ── Barra lateral direita (ações do gestor) ── */}
      <nav style={{
        position: 'fixed', top: 60, right: 0, bottom: 0, width: 56, zIndex: 40,
        background: 'var(--surface, #16161f)', borderLeft: '1px solid var(--border, #2a2a3a)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '10px 0',
      }}>
        {RIGHTBAR_BOTOES.map(b => {
          const ativo = painelDireito === b.id
          return (
            <button key={b.id} type="button" title={b.label}
              onClick={() => setPainelDireito(prev => prev === b.id ? null : b.id)}
              style={{
                position: 'relative',
                width: 44, height: 48, borderRadius: 10, cursor: 'pointer',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
                border: `1px solid ${ativo ? 'var(--primary, #7c3aed)' : 'transparent'}`,
                background: ativo ? 'rgba(124,58,237,.15)' : 'transparent',
                color: ativo ? 'var(--primary, #a78bfa)' : 'var(--text-muted, #9aa0b5)',
              }}>
              {b.icon}
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.02em' }}>{b.label}</span>
              {b.id === 'chat' && chatNaoLidas > 0 && (
                <span style={{
                  position: 'absolute', top: 4, right: 4, minWidth: 16, height: 16, borderRadius: 8,
                  background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px',
                }}>{chatNaoLidas}</span>
              )}
            </button>
          )
        })}
      </nav>

    </div>
  )
}
