import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'
const BUCKET = 'plataforma'

const CHAVES_TEXTO = [
  { chave: 'nome_plataforma', label: 'Nome da plataforma', placeholder: 'FWC Inter', hint: 'Aparece no sidebar do super admin e nos e-mails.' },
  { chave: 'trial_dias', label: 'Duração do trial (dias)', placeholder: '14', type: 'number', hint: 'Novas empresas recebem este período grátis.' },
  { chave: 'mensalidade_padrao', label: 'Mensalidade padrão (R$)', placeholder: '99.90', type: 'number', hint: 'Valor pré-preenchido ao criar nova empresa.' },
  { chave: 'cor_primaria_padrao', label: 'Cor primária padrão', placeholder: '#863bff', type: 'color', hint: 'Cor do app de novas lojas, pode ser alterada por empresa.' },
]

const CHAVES_MLM = [
  { chave: 'mlm_pct_nivel_1', label: 'Saque N1 — direto (%)', placeholder: '2.0', hint: 'Todos os níveis ganham os mesmos pontos do comprador. Este % define quanto do saldo N1 vira dinheiro.' },
  { chave: 'mlm_pct_nivel_2', label: 'Saque N2 — 2º nível (%)', placeholder: '1.5', hint: '' },
  { chave: 'mlm_pct_nivel_3', label: 'Saque N3 — 3º nível (%)', placeholder: '1.0', hint: '' },
  { chave: 'mlm_pct_nivel_4', label: 'Saque N4 — 4º nível (%)', placeholder: '1.0', hint: '' },
  { chave: 'mlm_pct_nivel_5', label: 'Saque N5 — 5º nível (%)', placeholder: '0.5', hint: '' },
  { chave: 'acumulado_pct_diretos',  label: 'Spillover acumulado dos diretos (%)', placeholder: '20', hint: 'X% dos pontos de cada direto vai para os pontos acumulados de quem indicou.' },
  { chave: 'comissao_indicacao_loja_pct', label: 'Comissão por indicação de loja (%)', placeholder: '5', hint: 'Quem trouxe a loja ganha esta % das vendas brutas dela (1 nível só).' },
]

export default function SuperAdminConfig() {
  const [logoUrl, setLogoUrl] = useState('')
  const [configs, setConfigs] = useState({})
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingMlm, setSavingMlm] = useState(false)
  const [savingCb, setSavingCb] = useState(false)
  const [savingComissao, setSavingComissao] = useState(false)
  const [savingComissaoPix, setSavingComissaoPix] = useState(false)
  const [msg, setMsg] = useState(null)
  const inputRef = useRef(null)

  // Prêmios
  const [premios, setPremios]               = useState([])
  const [showFormPremio, setShowFormPremio] = useState(false)
  const [salvandoPremio, setSalvandoPremio] = useState(false)
  const [uploadandoFoto, setUploadandoFoto] = useState(false)
  const [deletandoId, setDeletandoId]       = useState(null)
  const fotoInputRef = useRef(null)
  const [novoPremio, setNovoPremio] = useState({ nome: '', descricao: '', pontos_necessarios: '', foto_url: '', ativo: true })

  // Link raiz
  const [linkRaizToken, setLinkRaizToken] = useState('')
  const [savingLinkRaiz, setSavingLinkRaiz] = useState(false)
  const [linkCopiado, setLinkCopiado] = useState(false)

  const linkRaizUrl = `${window.location.origin}/entrar?ref=${linkRaizToken}`

  async function handleSalvarLinkRaiz(e) {
    e.preventDefault()
    if (!linkRaizToken.trim()) return
    setSavingLinkRaiz(true)
    const { error } = await supabase.from('configuracoes_plataforma')
      .upsert({ chave: 'link_raiz_token', valor: linkRaizToken.trim() })
    setSavingLinkRaiz(false)
    setMsg(error
      ? { tipo: 'erro', texto: 'Erro: ' + error.message }
      : { tipo: 'ok', texto: 'Link raiz atualizado!' }
    )
  }

  function handleCopiarLink() {
    navigator.clipboard.writeText(linkRaizUrl)
    setLinkCopiado(true)
    setTimeout(() => setLinkCopiado(false), 2000)
  }

  const loadPremios = useCallback(async () => {
    const { data } = await supabase.from('premios_pontos').select('*').order('pontos_necessarios')
    setPremios(data ?? [])
  }, [])

  useEffect(() => { loadPremios() }, [loadPremios])

  useEffect(() => {
    supabase
      .from('configuracoes_plataforma')
      .select('chave, valor')
      .then(({ data }) => {
        const map = {}
        for (const row of data ?? []) map[row.chave] = row.valor
        setLogoUrl(map.logo_url ?? '')
        setLinkRaizToken(map.link_raiz_token ?? '')
        setConfigs(map)
        setLoading(false)
      })
  }, [])

  async function handleUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return

    const ext = file.name.split('.').pop()
    const path = `logo_plataforma.${ext}`
    setUploading(true)
    setMsg(null)

    await supabase.storage.from(BUCKET).remove([path])

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type })

    if (upErr) {
      setMsg({ tipo: 'erro', texto: 'Erro no upload: ' + upErr.message })
      setUploading(false)
      return
    }

    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}?t=${Date.now()}`

    const { error: dbErr } = await supabase
      .from('configuracoes_plataforma')
      .upsert({ chave: 'logo_url', valor: url })

    if (dbErr) {
      setMsg({ tipo: 'erro', texto: 'Erro ao salvar: ' + dbErr.message })
    } else {
      setLogoUrl(url)
      setConfigs(prev => ({ ...prev, logo_url: url }))
      setMsg({ tipo: 'ok', texto: 'Logo atualizada com sucesso!' })
    }

    setUploading(false)
    e.target.value = ''
  }

  async function handleRemover() {
    if (!confirm('Remover a logo da plataforma?')) return
    setUploading(true)
    await supabase.storage.from(BUCKET).remove(['logo_plataforma.png', 'logo_plataforma.jpg', 'logo_plataforma.webp'])
    await supabase.from('configuracoes_plataforma').upsert({ chave: 'logo_url', valor: '' })
    setLogoUrl('')
    setConfigs(prev => ({ ...prev, logo_url: '' }))
    setMsg({ tipo: 'ok', texto: 'Logo removida.' })
    setUploading(false)
  }

  async function handleSalvarConfigs(e) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)

    const upserts = CHAVES_TEXTO.map(c => ({
      chave: c.chave,
      valor: configs[c.chave] ?? '',
    }))

    const { error } = await supabase
      .from('configuracoes_plataforma')
      .upsert(upserts)

    setSaving(false)
    if (error) {
      setMsg({ tipo: 'erro', texto: 'Erro ao salvar: ' + error.message })
    } else {
      setMsg({ tipo: 'ok', texto: 'Configurações salvas!' })
    }
  }

  async function handleSalvarCashback(e) {
    e.preventDefault()
    setSavingCb(true)
    setMsg(null)
    const upserts = [
      { chave: 'cashback_pct',   valor: configs.cashback_pct   ?? '2.0' },
      { chave: 'cashback_ativo', valor: configs.cashback_ativo === 'false' ? 'false' : 'true' },
    ]
    const { error } = await supabase.from('configuracoes_plataforma').upsert(upserts)
    setSavingCb(false)
    setMsg(error
      ? { tipo: 'erro', texto: 'Erro: ' + error.message }
      : { tipo: 'ok', texto: 'Cashback salvo!' }
    )
  }

  async function handleSalvarComissao(e) {
    e.preventDefault()
    setSavingComissao(true)
    setMsg(null)
    const { error } = await supabase.from('configuracoes_plataforma').upsert([
      { chave: 'comissao_vendas_pct',   valor: configs.comissao_vendas_pct   ?? '0' },
      { chave: 'comissao_vendas_ativo', valor: configs.comissao_vendas_ativo === 'false' ? 'false' : 'true' },
    ])
    setSavingComissao(false)
    setMsg(error
      ? { tipo: 'erro', texto: 'Erro: ' + error.message }
      : { tipo: 'ok', texto: 'Comissão salva!' }
    )
  }

  async function handleSalvarComissaoPix(e) {
    e.preventDefault()
    setSavingComissaoPix(true)
    setMsg(null)
    const { error } = await supabase.from('configuracoes_plataforma').upsert([
      { chave: 'comissao_pix_percent', valor: String(configs.comissao_pix_percent ?? '0.5') },
    ])
    setSavingComissaoPix(false)
    setMsg(error
      ? { tipo: 'erro', texto: 'Erro: ' + error.message }
      : { tipo: 'ok', texto: 'Comissão do PIX salva!' }
    )
  }

  async function handleSalvarMLM(e) {
    e.preventDefault()
    setSavingMlm(true)
    setMsg(null)

    const upserts = [
      ...CHAVES_MLM.map(c => ({ chave: c.chave, valor: configs[c.chave] ?? '' })),
      { chave: 'mlm_ativo', valor: configs.mlm_ativo === 'false' ? 'false' : 'true' },
    ]

    const { error } = await supabase
      .from('configuracoes_plataforma')
      .upsert(upserts)

    setSavingMlm(false)
    if (error) {
      setMsg({ tipo: 'erro', texto: 'Erro ao salvar: ' + error.message })
    } else {
      setMsg({ tipo: 'ok', texto: 'Programa de indicações salvo!' })
    }
  }

  async function handleUploadFotoPremio(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadandoFoto(true)
    const ext = file.name.split('.').pop()
    const path = `premios/premio_${Date.now()}.${ext}`
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type })
    if (upErr) { alert('Erro no upload: ' + upErr.message); setUploadandoFoto(false); return }
    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}?t=${Date.now()}`
    setNovoPremio(prev => ({ ...prev, foto_url: url }))
    setUploadandoFoto(false)
    e.target.value = ''
  }

  async function handleSalvarPremio(e) {
    e.preventDefault()
    if (!novoPremio.nome || !novoPremio.pontos_necessarios) { alert('Preencha nome e pontos.'); return }
    setSalvandoPremio(true)
    const { error } = await supabase.from('premios_pontos').insert({
      nome: novoPremio.nome,
      descricao: novoPremio.descricao || null,
      pontos_necessarios: parseInt(novoPremio.pontos_necessarios),
      foto_url: novoPremio.foto_url || null,
      ativo: novoPremio.ativo,
    })
    setSalvandoPremio(false)
    if (error) { alert('Erro: ' + error.message); return }
    setNovoPremio({ nome: '', descricao: '', pontos_necessarios: '', foto_url: '', ativo: true })
    setShowFormPremio(false)
    loadPremios()
  }

  async function handleDeletarPremio(id) {
    if (!confirm('Remover este prêmio?')) return
    setDeletandoId(id)
    await supabase.from('premios_pontos').delete().eq('id', id)
    setDeletandoId(null)
    loadPremios()
  }

  async function toggleAtivoPremio(id, ativo) {
    await supabase.from('premios_pontos').update({ ativo: !ativo }).eq('id', id)
    loadPremios()
  }

  if (loading) return <div className="page-loading">Carregando...</div>

  return (
    <div className="page-container">
      <div className="page-header">
        <h1 className="page-title">Configurações da Plataforma</h1>
      </div>

      <div style={{ columnWidth: 440, columnGap: 20 }}>

        {/* Configurações gerais */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 18px', fontSize: 16, fontWeight: 700 }}>Configurações Gerais</h2>
          <form onSubmit={handleSalvarConfigs}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {CHAVES_TEXTO.map(c => (
                <div key={c.chave} className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontWeight: 600, fontSize: 13 }}>{c.label}</label>
                  {c.type === 'color' ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                      <input
                        type="color"
                        value={configs[c.chave] || '#863bff'}
                        onChange={ev => setConfigs(prev => ({ ...prev, [c.chave]: ev.target.value }))}
                        style={{ width: 40, height: 36, padding: 2, borderRadius: 6, border: '1.5px solid var(--border)', cursor: 'pointer' }}
                      />
                      <input
                        type="text"
                        value={configs[c.chave] ?? ''}
                        onChange={ev => setConfigs(prev => ({ ...prev, [c.chave]: ev.target.value }))}
                        placeholder={c.placeholder}
                        style={{ flex: 1 }}
                      />
                    </div>
                  ) : (
                    <input
                      type={c.type ?? 'text'}
                      value={configs[c.chave] ?? ''}
                      onChange={ev => setConfigs(prev => ({ ...prev, [c.chave]: ev.target.value }))}
                      placeholder={c.placeholder}
                      step={c.type === 'number' ? 'any' : undefined}
                      min={c.type === 'number' ? '0' : undefined}
                      style={{ marginTop: 6 }}
                    />
                  )}
                  {c.hint && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>
                      {c.hint}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving}
              style={{ marginTop: 20 }}
            >
              {saving ? 'Salvando...' : 'Salvar configurações'}
            </button>
          </form>
        </div>

        {/* Cashback */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Cashback</h2>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            O comprador recebe de volta uma % da compra em pontos, que pode resgatar como dinheiro.
          </p>

          <p style={{ margin: '-14px 0 16px', fontSize: 13, color: 'var(--text-muted)' }}>
            O percentual de cashback é informativo — mostra quanto o comprador recebe de volta em reais.
            Os pontos são calculados diretamente pelo valor da compra (1 real = pontos, conforme Conversão de Pontos abaixo).
          </p>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 10,
            border: '1.5px solid var(--border)', marginBottom: 18,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Cashback ativo</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Desativar para de gerar cashback para compradores.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfigs(prev => ({ ...prev, cashback_ativo: prev.cashback_ativo === 'false' ? 'true' : 'false' }))}
              style={{
                width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', padding: 0,
                background: configs.cashback_ativo === 'false' ? 'var(--border)' : 'var(--primary)',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: configs.cashback_ativo === 'false' ? 3 : 23,
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                transition: 'left 0.2s', display: 'block',
              }} />
            </button>
          </div>

          <form onSubmit={handleSalvarCashback}>
            <div className="form-field" style={{ margin: '0 0 16px' }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Percentual de cashback (%)</label>
              <input
                type="number" step="0.1" min="0" max="100"
                value={configs.cashback_pct ?? '2.0'}
                onChange={e => setConfigs(prev => ({ ...prev, cashback_pct: e.target.value }))}
                placeholder="2.0"
                style={{ marginTop: 6, maxWidth: 180 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>
                Ex: 2% → compra de R$100 gera R$2 de cashback monetário (informativo). Os pontos vêm da conversão direta.
              </span>
            </div>

            {configs.cashback_pct && configs.valor_ponto_reais && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 16,
                background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.25)',
                fontSize: 13,
              }}>
                Compra de <strong>R$ 100,00</strong> → <strong>R$ {(100 * Number(configs.cashback_pct) / 100).toFixed(2)} cashback</strong>
                {' '}· <strong>{Math.floor(100 / Number(configs.valor_ponto_reais))} pontos</strong> (1 real = {(1 / Number(configs.valor_ponto_reais)).toFixed(0)} ponto)
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={savingCb}>
              {savingCb ? 'Salvando...' : 'Salvar cashback'}
            </button>
          </form>
        </div>

        {/* ── Conversão de Pontos ── */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>💰 Conversão de Pontos</h2>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--text-muted)' }}>
            Dois momentos distintos: quanto o cliente <strong>ganha</strong> na compra e quanto pode <strong>sacar</strong> depois.
          </p>

          {/* Bloco 1: Compra → Pontos */}
          <div style={{
            padding: '14px 16px', borderRadius: 10, marginBottom: 16,
            border: '1.5px solid var(--border)', background: 'var(--bg-secondary)',
          }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>① Compra → Pontos (ganho)</div>
            <div className="form-field" style={{ margin: 0 }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Reais por 1 ponto (R$)</label>
              <input
                type="number" step="0.01" min="0.01"
                value={configs.valor_ponto_reais ?? '1.00'}
                onChange={e => setConfigs(prev => ({ ...prev, valor_ponto_reais: e.target.value }))}
                placeholder="1.00"
                style={{ marginTop: 6, maxWidth: 160 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                R$1,00 → cada real gasto = 1 ponto &nbsp;·&nbsp; R$0,10 → cada real = 10 pontos
              </span>
            </div>
            {configs.valor_ponto_reais && (
              <div style={{
                marginTop: 10, padding: '8px 12px', borderRadius: 8,
                background: 'rgba(34,197,94,.08)', border: '1px solid rgba(34,197,94,.2)',
                fontSize: 12,
              }}>
                Compra de R$100 → <strong>{Math.floor(100 / Number(configs.valor_ponto_reais))} pontos</strong> &nbsp;·&nbsp;
                Compra de R$167 → <strong>{Math.floor(167 / Number(configs.valor_ponto_reais))} pontos</strong>
              </div>
            )}
          </div>

          {/* Bloco 2: Pontos → Saque */}
          <div style={{
            padding: '14px 16px', borderRadius: 10, marginBottom: 16,
            border: '1.5px solid var(--border)', background: 'var(--bg-secondary)',
          }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>② Pontos → Dinheiro (saque)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-field" style={{ margin: 0 }}>
                <label style={{ fontWeight: 600, fontSize: 13 }}>Valor de 1 ponto no saque (R$)</label>
                <input
                  type="number" step="0.01" min="0.01"
                  value={configs.valor_resgate_ponto ?? '1.00'}
                  onChange={e => setConfigs(prev => ({ ...prev, valor_resgate_ponto: e.target.value }))}
                  placeholder="1.00"
                  style={{ marginTop: 6 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  Quanto o cliente recebe em R$ por cada ponto sacado.
                </span>
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label style={{ fontWeight: 600, fontSize: 13 }}>Pontos mínimos para sacar</label>
                <input
                  type="number" step="1" min="1"
                  value={configs.pontos_minimo_resgate ?? '100'}
                  onChange={e => setConfigs(prev => ({ ...prev, pontos_minimo_resgate: e.target.value }))}
                  placeholder="100"
                  style={{ marginTop: 6 }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, display: 'block' }}>
                  Mínimo de pontos para solicitar saque.
                </span>
              </div>
            </div>
            {configs.valor_resgate_ponto && (
              <div style={{
                marginTop: 10, padding: '8px 12px', borderRadius: 8,
                background: 'rgba(124,58,237,.08)', border: '1px solid rgba(124,58,237,.2)',
                fontSize: 12,
              }}>
                100 pontos = <strong>R${(100 * Number(configs.valor_resgate_ponto)).toFixed(2)}</strong> no saque &nbsp;·&nbsp;
                Mínimo: {configs.pontos_minimo_resgate ?? 100} pts = <strong>R${(Number(configs.pontos_minimo_resgate ?? 100) * Number(configs.valor_resgate_ponto)).toFixed(2)}</strong>
              </div>
            )}
          </div>

          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              setMsg(null)
              const { error } = await supabase.from('configuracoes_plataforma').upsert([
                { chave: 'valor_ponto_reais',     valor: configs.valor_ponto_reais     ?? '1.00' },
                { chave: 'valor_resgate_ponto',   valor: configs.valor_resgate_ponto   ?? '1.00' },
                { chave: 'pontos_minimo_resgate', valor: configs.pontos_minimo_resgate ?? '100'  },
              ])
              setSaving(false)
              setMsg(error
                ? { tipo: 'erro', texto: 'Erro: ' + error.message }
                : { tipo: 'ok', texto: 'Conversão de pontos salva!' }
              )
            }}
          >
            {saving ? 'Salvando...' : 'Salvar conversão de pontos'}
          </button>
        </div>

        {/* Comissão sobre Vendas */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Comissão sobre Vendas</h2>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            Percentual cobrado sobre cada venda feita pelo <strong>App / Portal</strong> dos clientes. Não se aplica a pedidos do WhatsApp ou Cardápio.
          </p>

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 10,
            border: '1.5px solid var(--border)', marginBottom: 18,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Cobrar comissão</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Aplica o percentual sobre o total de cada pedido.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfigs(prev => ({ ...prev, comissao_vendas_ativo: prev.comissao_vendas_ativo === 'false' ? 'true' : 'false' }))}
              style={{
                width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', padding: 0,
                background: configs.comissao_vendas_ativo === 'false' ? 'var(--border)' : 'var(--primary)',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: configs.comissao_vendas_ativo === 'false' ? 3 : 23,
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                transition: 'left 0.2s', display: 'block',
              }} />
            </button>
          </div>

          <form onSubmit={handleSalvarComissao}>
            <div className="form-field" style={{ margin: '0 0 16px' }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Percentual de comissão (%)</label>
              <input
                type="number" step="0.1" min="0" max="100"
                value={configs.comissao_vendas_pct ?? '0'}
                onChange={e => setConfigs(prev => ({ ...prev, comissao_vendas_pct: e.target.value }))}
                placeholder="5.0"
                style={{ marginTop: 6, maxWidth: 180 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>
                Ex: 5% → pedido de R$ 100,00 pelo App gera R$ 5,00 para a plataforma.
              </span>
            </div>

            {configs.comissao_vendas_pct && Number(configs.comissao_vendas_pct) > 0 && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 16,
                background: 'rgba(124,58,237,.08)', border: '1px solid rgba(124,58,237,.2)',
                fontSize: 13,
              }}>
                Pedido de <strong>R$ 100,00</strong> → <strong>R$ {(100 * Number(configs.comissao_vendas_pct) / 100).toFixed(2)}</strong> de comissão
                &nbsp;· pedido de <strong>R$ 50,00</strong> → <strong>R$ {(50 * Number(configs.comissao_vendas_pct) / 100).toFixed(2)}</strong>
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={savingComissao}>
              {savingComissao ? 'Salvando...' : 'Salvar comissão'}
            </button>
          </form>
        </div>

        {/* Comissão do PIX (Mercado Pago marketplace) */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Comissão do PIX (Mercado Pago)</h2>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            Percentual que a plataforma desconta de cada <strong>PIX pago pela loja conectada</strong> ao Mercado Pago.
            O valor cai automaticamente na sua conta (via <em>split</em> do MP); o restante vai pra loja.
          </p>

          <form onSubmit={handleSalvarComissaoPix}>
            <div className="form-field" style={{ margin: '0 0 16px' }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Percentual de comissão do PIX (%)</label>
              <input
                type="number" step="0.1" min="0" max="100"
                value={configs.comissao_pix_percent ?? '0.5'}
                onChange={e => setConfigs(prev => ({ ...prev, comissao_pix_percent: e.target.value }))}
                placeholder="0.5"
                style={{ marginTop: 6, maxWidth: 180 }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>
                Ex: 0,5% → PIX de R$ 100,00 gera R$ 0,50 pra plataforma. Use 0 para não cobrar.
              </span>
            </div>

            {configs.comissao_pix_percent != null && configs.comissao_pix_percent !== '' && Number(configs.comissao_pix_percent) > 0 && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 16,
                background: 'rgba(0,158,227,.08)', border: '1px solid rgba(0,158,227,.25)',
                fontSize: 13,
              }}>
                PIX de <strong>R$ 100,00</strong> → <strong>R$ {(100 * Number(configs.comissao_pix_percent) / 100).toFixed(2)}</strong> pra você
                &nbsp;· PIX de <strong>R$ 50,00</strong> → <strong>R$ {(50 * Number(configs.comissao_pix_percent) / 100).toFixed(2)}</strong>
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={savingComissaoPix}>
              {savingComissaoPix ? 'Salvando...' : 'Salvar comissão do PIX'}
            </button>
          </form>
        </div>

        {/* Programa de Indicações (MLM) */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>Programa de Indicações</h2>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            Todos os níveis ganham os <strong>mesmos pontos</strong> do comprador. Os percentuais definem quanto de cada nível pode ser sacado como dinheiro.
            Ex: compra de R$100 = 100 pts para o comprador <strong>e</strong> 100 pts para cada nível acima.
          </p>

          {/* Toggle ativo */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 14px', background: 'var(--bg-secondary)', borderRadius: 10,
            border: '1.5px solid var(--border)', marginBottom: 18,
          }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Programa ativo</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                Desativar suspende todas as novas comissões.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfigs(prev => ({ ...prev, mlm_ativo: prev.mlm_ativo === 'false' ? 'true' : 'false' }))}
              style={{
                width: 48, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', padding: 0,
                background: configs.mlm_ativo === 'false' ? 'var(--border)' : 'var(--primary)',
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <span style={{
                position: 'absolute', top: 3, left: configs.mlm_ativo === 'false' ? 3 : 23,
                width: 20, height: 20, borderRadius: '50%', background: '#fff',
                transition: 'left 0.2s', display: 'block',
              }} />
            </button>
          </div>

          <form onSubmit={handleSalvarMLM}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              {CHAVES_MLM.slice(0, 5).map(c => (
                <div key={c.chave} className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontWeight: 600, fontSize: 13 }}>{c.label}</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={configs[c.chave] ?? ''}
                    onChange={ev => setConfigs(prev => ({ ...prev, [c.chave]: ev.target.value }))}
                    placeholder={c.placeholder}
                    style={{ marginTop: 6 }}
                  />
                  {c.hint && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>{c.hint}</span>}
                </div>
              ))}
            </div>
            {/* preview MLM */}
            {configs.valor_ponto_reais && configs.mlm_pct_nivel_1 && (
              <div style={{
                padding: '10px 14px', borderRadius: 8, marginBottom: 16,
                background: 'rgba(124,58,237,.08)', border: '1px solid rgba(124,58,237,.2)',
                fontSize: 13, color: 'var(--text)', lineHeight: 1.8,
              }}>
                Exemplo — compra de <strong>R$100</strong>:<br />
                Comprador → <strong>{Math.floor(100 / Number(configs.valor_ponto_reais))} pts</strong>
                {' '}· saque: {configs.cashback_pct ?? 2}% = <strong>R${(Math.floor(100 / Number(configs.valor_ponto_reais)) * Number(configs.cashback_pct ?? 2) / 100).toFixed(2)}</strong><br />
                N1 (quem indicou) → <strong>{Math.floor(100 / Number(configs.valor_ponto_reais))} pts</strong> (mesmos do comprador)
                {' '}· saque: {configs.mlm_pct_nivel_1}% = <strong>R${(Math.floor(100 / Number(configs.valor_ponto_reais)) * Number(configs.mlm_pct_nivel_1) / 100).toFixed(2)}</strong>
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={savingMlm}>
              {savingMlm ? 'Salvando...' : 'Salvar programa de indicações'}
            </button>
          </form>
        </div>

        {/* Logo */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700 }}>Logo da Plataforma</h2>
          <p style={{ margin: '0 0 24px', fontSize: 13, color: 'var(--text-muted)' }}>
            Exibida no portal do cliente. Recomendado: PNG ou WEBP transparente, mínimo 128×128px.
          </p>

          <div style={{
            display: 'flex', alignItems: 'center', gap: 20, marginBottom: 24,
            padding: 20, background: 'var(--bg-secondary)', borderRadius: 12,
            border: '1px solid var(--border)',
          }}>
            {logoUrl ? (
              <>
                <img
                  src={logoUrl}
                  alt="Logo atual"
                  style={{ width: 72, height: 72, objectFit: 'contain', borderRadius: 12, background: '#1a1035' }}
                />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Logo atual</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all', maxWidth: 280 }}>
                    {logoUrl.split('/').pop().split('?')[0]}
                  </div>
                </div>
              </>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 12,
                  background: 'var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3"/>
                    <path d="m9 9 6 6M15 9l-6 6"/>
                  </svg>
                </div>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Usando a logo padrão FWC</span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              style={{ display: 'none' }}
              onChange={handleUpload}
            />
            <button
              className="btn btn-primary"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? 'Enviando...' : logoUrl ? 'Trocar logo' : 'Enviar logo'}
            </button>
            {logoUrl && (
              <button
                className="btn btn-secondary"
                onClick={handleRemover}
                disabled={uploading}
                style={{ color: 'var(--danger)' }}
              >
                Remover
              </button>
            )}
          </div>
        </div>

        {/* Prêmios por Pontos Acumulados */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Prêmios por Pontos</h2>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setShowFormPremio(v => !v)}
            >
              {showFormPremio ? 'Cancelar' : '+ Novo prêmio'}
            </button>
          </div>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            Clientes desbloqueiam prêmios ao atingir o total de pontos acumulados (nunca diminui).
          </p>

          {/* Formulário novo prêmio */}
          {showFormPremio && (
            <form onSubmit={handleSalvarPremio} style={{
              border: '1.5px solid var(--primary)', borderRadius: 12,
              padding: 16, marginBottom: 20, background: 'var(--bg-secondary)',
            }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: 'var(--primary)' }}>Novo prêmio</div>

              {/* Foto */}
              <div style={{ marginBottom: 14 }}>
                <input ref={fotoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleUploadFotoPremio} />
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  {novoPremio.foto_url ? (
                    <img src={novoPremio.foto_url} alt="Preview" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10, border: '2px solid var(--primary)' }} />
                  ) : (
                    <div style={{
                      width: 72, height: 72, borderRadius: 10, border: '2px dashed var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      background: 'var(--surface)', cursor: 'pointer',
                    }} onClick={() => fotoInputRef.current?.click()}>
                      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                      </svg>
                    </div>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => fotoInputRef.current?.click()} disabled={uploadandoFoto}>
                    {uploadandoFoto ? 'Enviando...' : novoPremio.foto_url ? 'Trocar foto' : 'Adicionar foto'}
                  </button>
                  {novoPremio.foto_url && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNovoPremio(p => ({ ...p, foto_url: '' }))} style={{ color: 'var(--danger)' }}>
                      Remover
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 12, marginBottom: 12 }}>
                <div className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontWeight: 600, fontSize: 13 }}>Nome do prêmio *</label>
                  <input
                    type="text" required placeholder="Ex: Smartphone Samsung"
                    value={novoPremio.nome}
                    onChange={e => setNovoPremio(p => ({ ...p, nome: e.target.value }))}
                    style={{ marginTop: 6 }}
                  />
                </div>
                <div className="form-field" style={{ margin: 0 }}>
                  <label style={{ fontWeight: 600, fontSize: 13 }}>Pontos necessários *</label>
                  <input
                    type="number" required min="1" placeholder="20000"
                    value={novoPremio.pontos_necessarios}
                    onChange={e => setNovoPremio(p => ({ ...p, pontos_necessarios: e.target.value }))}
                    style={{ marginTop: 6 }}
                  />
                </div>
              </div>

              <div className="form-field" style={{ margin: '0 0 16px' }}>
                <label style={{ fontWeight: 600, fontSize: 13 }}>Descrição (opcional)</label>
                <input
                  type="text" placeholder="Ex: Modelo 2024, 128GB"
                  value={novoPremio.descricao}
                  onChange={e => setNovoPremio(p => ({ ...p, descricao: e.target.value }))}
                  style={{ marginTop: 6 }}
                />
              </div>

              <button type="submit" className="btn btn-primary" disabled={salvandoPremio || uploadandoFoto}>
                {salvandoPremio ? 'Salvando...' : 'Salvar prêmio'}
              </button>
            </form>
          )}

          {/* Lista de prêmios */}
          {premios.length === 0 && !showFormPremio && (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              Nenhum prêmio cadastrado ainda. Clique em "+ Novo prêmio" para começar.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {premios.map(p => (
              <div key={p.id} style={{
                display: 'flex', gap: 14, alignItems: 'center',
                padding: '14px 16px', borderRadius: 12,
                background: p.ativo ? 'var(--bg-secondary)' : 'var(--surface)',
                border: `1.5px solid ${p.ativo ? 'var(--border)' : 'var(--border)'}`,
                opacity: p.ativo ? 1 : 0.5,
              }}>
                {/* Foto */}
                {p.foto_url ? (
                  <img src={p.foto_url} alt={p.nome} style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 10, flexShrink: 0 }} />
                ) : (
                  <div style={{
                    width: 56, height: 56, borderRadius: 10, flexShrink: 0,
                    background: 'var(--primary-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
                  }}>🎁</div>
                )}

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{p.nome}</div>
                  {p.descricao && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{p.descricao}</div>}
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: 'var(--primary-bg)', color: 'var(--primary)',
                    borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 700,
                  }}>
                    🏆 {Number(p.pontos_necessarios).toLocaleString('pt-BR')} pts
                  </div>
                </div>

                {/* Ações */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => toggleAtivoPremio(p.id, p.ativo)}
                    style={{ fontSize: 11, padding: '4px 10px' }}
                  >
                    {p.ativo ? 'Desativar' : 'Ativar'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleDeletarPremio(p.id)}
                    disabled={deletandoId === p.id}
                    style={{ fontSize: 11, padding: '4px 10px', color: 'var(--danger)' }}
                  >
                    {deletandoId === p.id ? '...' : 'Excluir'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Link Raiz */}
        <div className="card" style={{ padding: 28, breakInside: 'avoid', marginBottom: 20 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 700 }}>🔗 Link Raiz da Plataforma</h2>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text-muted)' }}>
            Quem se cadastrar sem link de indicação será atribuído automaticamente a este token.
            Compartilhe este link para capturar indicações da plataforma.
          </p>

          {/* URL de cópia */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <div style={{
              flex: 1, padding: '8px 12px', borderRadius: 8, fontSize: 12,
              background: 'var(--bg-secondary)', border: '1.5px solid var(--border)',
              color: 'var(--text-muted)', wordBreak: 'break-all', fontFamily: 'monospace',
            }}>
              {linkRaizToken ? linkRaizUrl : '— token não definido —'}
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleCopiarLink}
              disabled={!linkRaizToken}
              style={{ flexShrink: 0, fontSize: 13 }}
            >
              {linkCopiado ? '✓ Copiado!' : 'Copiar'}
            </button>
          </div>

          {/* Editar token */}
          <form onSubmit={handleSalvarLinkRaiz} style={{ display: 'flex', gap: 8 }}>
            <div className="form-field" style={{ flex: 1, margin: 0 }}>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Token do perfil raiz</label>
              <input
                type="text"
                value={linkRaizToken}
                onChange={e => setLinkRaizToken(e.target.value)}
                placeholder="ex: 89612b50"
                style={{ marginTop: 6, fontFamily: 'monospace' }}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'block' }}>
                ref_token do perfil que recebe as indicações sem link. Padrão: token do super admin.
              </span>
            </div>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={savingLinkRaiz}
              style={{ alignSelf: 'flex-end', marginBottom: 20 }}
            >
              {savingLinkRaiz ? '...' : 'Salvar'}
            </button>
          </form>
        </div>

      </div>

      {msg && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, fontSize: 13, marginTop: 20,
          background: msg.tipo === 'ok' ? 'rgba(34,197,94,.12)' : 'rgba(239,68,68,.12)',
          color: msg.tipo === 'ok' ? '#16a34a' : '#dc2626',
          border: `1px solid ${msg.tipo === 'ok' ? 'rgba(34,197,94,.3)' : 'rgba(239,68,68,.3)'}`,
        }}>
          {msg.texto}
        </div>
      )}
    </div>
  )
}
