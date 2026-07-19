import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import '../components/Page.css'

const STATUS_COR = {
  livre:     { bg: 'rgba(34,197,94,.12)',  border: '#22c55e', label: 'Livre' },
  ocupada:   { bg: 'rgba(239,68,68,.12)',  border: '#ef4444', label: 'Ocupada' },
  conta:     { bg: 'rgba(234,179,8,.14)',  border: '#eab308', label: 'Fechando conta' },
  reservada: { bg: 'rgba(59,130,246,.12)', border: '#3b82f6', label: 'Reservada' },
}

export default function PresencialMesas() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id

  const [mesas, setMesas]     = useState([])
  const [loading, setLoading] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro]       = useState(null)

  // form nova mesa
  const [numero, setNumero]         = useState('')
  const [nome, setNome]             = useState('')
  const [capacidade, setCapacidade] = useState(4)
  const [qrMesa, setQrMesa]         = useState(null)   // mesa do modal de QR
  const [qrImg, setQrImg]           = useState('')     // dataURL do QR (gerado local)
  const [copiado, setCopiado]       = useState(false)
  const [editId, setEditId]         = useState(null)   // mesa com lugares em edição
  const [editCap, setEditCap]       = useState(4)
  const [presencialAtivo, setPresencialAtivo] = useState(true) // serviço presencial ligado?
  const [ligando, setLigando]       = useState(false)

  // Link/QR do cliente aponta SEMPRE pro domínio público da loja online
  // (não pro admin/gestor onde o dono está gerando o QR).
  const linkMesa = (m) => `https://lojaonline.fwcinter.com/mesa/${m.token}`
  // QR gerado LOCALMENTE (lib qrcode) — não depende de serviço externo. Antes usava
  // api.qrserver.com e vinha vazio quando o serviço falhava/era bloqueado.
  const gerarQr = (m, size = 600) => QRCode.toDataURL(linkMesa(m), { width: size, margin: 2, errorCorrectionLevel: 'M' })

  // Gera o QR do modal assim que uma mesa é aberta.
  useEffect(() => {
    if (!qrMesa) { setQrImg(''); return }
    let cancel = false
    gerarQr(qrMesa, 600).then(u => { if (!cancel) setQrImg(u) }).catch(() => { if (!cancel) setQrImg('') })
    return () => { cancel = true }
  }, [qrMesa]) // eslint-disable-line react-hooks/exhaustive-deps

  async function baixarQr(m) {
    try {
      const url = await gerarQr(m, 600)
      const a = document.createElement('a')
      a.href = url; a.download = `qr-mesa-${m.numero}.png`
      document.body.appendChild(a); a.click(); a.remove()
    } catch (e) { alert('Não consegui gerar o QR: ' + (e?.message || e)) }
  }
  // Gera uma folha (A4) com o NOME da mesa + o QR, pronta pra salvar como PDF/imprimir.
  async function baixarPdf(m) {
    let imgSrc
    try { imgSrc = await gerarQr(m, 600) } catch (e) { alert('Não consegui gerar o QR: ' + (e?.message || e)); return }
    const nome = m.nome ? ` · ${m.nome}` : ''
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>QR Mesa ${m.numero}</title>
<style>
  @page { size: A4; margin: 20mm; }
  html,body { margin:0; padding:0; }
  body { font-family: Arial, Helvetica, sans-serif; color:#111; text-align:center; padding:48px 24px; }
  .mesa { font-size:56px; font-weight:800; margin:0 0 6px; }
  .sub { font-size:20px; color:#555; margin:0 0 28px; }
  img { width:340px; height:340px; }
  .inst { font-size:22px; font-weight:700; margin-top:28px; }
  .dica { font-size:15px; color:#666; margin-top:8px; }
</style></head><body>
  <div class="mesa">Mesa ${m.numero}${nome}</div>
  <div class="sub">Cardápio & pedidos pelo celular</div>
  <img src="${imgSrc}" alt="QR Mesa ${m.numero}">
  <div class="inst">📱 Aponte a câmera do celular e peça pela mesa</div>
  <div class="dica">Escaneie o QR code para ver o cardápio e pedir sozinho</div>
</body></html>`
    const w = window.open('', '_blank')
    if (!w) { alert('Permita abrir a janela pra gerar o PDF.'); return }
    w.document.open(); w.document.write(html); w.document.close()
    const imprimir = () => { try { w.focus(); w.print() } catch { /* ignora */ } }
    w.onload = imprimir
    setTimeout(imprimir, 700) // fallback se o onload não disparar (imagem já embutida)
  }

  async function carregar() {
    if (!empresaId) return
    const [{ data }, { data: emp }] = await Promise.all([
      supabase.from('mesas').select('*').eq('empresa_id', empresaId).order('numero'),
      supabase.from('empresas').select('presencial_ativo').eq('id', empresaId).maybeSingle(),
    ])
    setMesas(data ?? [])
    setPresencialAtivo(emp?.presencial_ativo ?? false)
    setLoading(false)
    // sugere o próximo número
    const max = (data ?? []).reduce((m, x) => Math.max(m, x.numero), 0)
    setNumero(String(max + 1))
  }

  async function ligarPresencial() {
    if (!empresaId) return
    setLigando(true)
    const { error } = await supabase.from('empresas')
      .update({ presencial_ativo: true }).eq('id', empresaId)
    setLigando(false)
    if (!error) setPresencialAtivo(true)
  }

  useEffect(() => { carregar() }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  async function adicionar(e) {
    e.preventDefault()
    setErro(null)
    const n = parseInt(numero, 10)
    if (!n || n < 1) { setErro('Informe o número da mesa.'); return }
    if (mesas.some(m => m.numero === n)) { setErro(`Já existe a mesa ${n}.`); return }
    setSalvando(true)
    const { error } = await supabase.from('mesas').insert({
      empresa_id: empresaId,
      numero: n,
      nome: nome.trim() || null,
      capacidade: parseInt(capacidade, 10) || 4,
    })
    setSalvando(false)
    if (error) { setErro(error.message); return }
    setNome(''); setCapacidade(4)
    carregar()
  }

  async function remover(id) {
    if (!window.confirm('Remover esta mesa?')) return
    await supabase.from('mesas').delete().eq('id', id)
    carregar()
  }

  async function alternarAtiva(m) {
    await supabase.from('mesas').update({ ativa: !m.ativa }).eq('id', m.id)
    carregar()
  }

  function abrirEdicaoCap(m) {
    setEditId(m.id)
    setEditCap(m.capacidade)
  }

  async function salvarCapacidade(m) {
    const c = parseInt(editCap, 10)
    if (!c || c < 1) { setEditId(null); return }
    // atualização otimista pra não "piscar" a lista inteira
    setMesas(prev => prev.map(x => x.id === m.id ? { ...x, capacidade: c } : x))
    setEditId(null)
    await supabase.from('mesas').update({ capacidade: c }).eq('id', m.id)
  }

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <p style={{ margin: 0, fontSize: 13 }}>
            <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
          </p>
          <h1>Mesas</h1>
          <p className="page-subtitle">Cadastre as mesas do seu salão.</p>
        </div>
      </div>

      {/* Aviso: sem o Serviço Presencial ligado, os QR das mesas não abrem */}
      {!presencialAtivo && (
        <div className="card" style={{
          marginBottom: 16, border: '1px solid #f59e0b', background: 'rgba(245,158,11,.1)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1, minWidth: 200, fontSize: 13.5, color: 'var(--text)' }}>
            <strong>⚠️ Serviço Presencial desligado.</strong> Os links/QR das mesas <u>não abrem</u> pro
            cliente enquanto isto estiver desligado.
          </div>
          <button type="button" className="btn btn-primary" onClick={ligarPresencial} disabled={ligando}>
            {ligando ? 'Ligando...' : 'Ligar agora'}
          </button>
        </div>
      )}

      {/* Form nova mesa */}
      <form className="card" onSubmit={adicionar} style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-field" style={{ width: 90 }}>
            <label>Número *</label>
            <input type="number" min="1" value={numero} onChange={e => setNumero(e.target.value)} />
          </div>
          <div className="form-field" style={{ flex: 1, minWidth: 160 }}>
            <label>Nome / apelido (opcional)</label>
            <input type="text" placeholder="Ex: Varanda, Balcão 1" value={nome} onChange={e => setNome(e.target.value)} />
          </div>
          <div className="form-field" style={{ width: 120 }}>
            <label>Lugares</label>
            <input type="number" min="1" value={capacidade} onChange={e => setCapacidade(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={salvando} style={{ height: 40 }}>
            {salvando ? 'Adicionando...' : '+ Adicionar mesa'}
          </button>
        </div>
        {erro && <div style={{ marginTop: 10, fontSize: 13, color: 'var(--danger)' }}>{erro}</div>}
      </form>

      {/* Grid de mesas */}
      {mesas.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Nenhuma mesa cadastrada ainda. Adicione a primeira acima. 🪑
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
          {mesas.map(m => {
            const cor = STATUS_COR[m.status] ?? STATUS_COR.livre
            return (
              <div key={m.id} style={{
                borderRadius: 12, padding: 14, position: 'relative',
                border: `2px solid ${m.ativa ? cor.border : 'var(--border)'}`,
                background: m.ativa ? cor.bg : 'transparent',
                opacity: m.ativa ? 1 : 0.55,
              }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>Mesa {m.numero}</div>
                {m.nome && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{m.nome}</div>}
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {editId === m.id ? (
                    <>
                      <span>👥</span>
                      <input
                        type="number" min="1" autoFocus
                        value={editCap}
                        onChange={e => setEditCap(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') salvarCapacidade(m); if (e.key === 'Escape') setEditId(null) }}
                        style={{ width: 52, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--primary)', background: 'var(--input-bg)', color: 'var(--text)', fontSize: 12 }}
                      />
                      <span>lugares</span>
                      <button type="button" onClick={() => salvarCapacidade(m)} aria-label="Salvar lugares"
                        style={{ fontSize: 12, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--primary)', background: 'var(--primary)', color: '#fff', fontWeight: 700 }}>✓</button>
                      <button type="button" onClick={() => setEditId(null)} aria-label="Cancelar"
                        style={{ fontSize: 12, padding: '2px 6px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>✕</button>
                    </>
                  ) : (
                    <>
                      <span>👥 {m.capacidade} lugares · {m.ativa ? cor.label : 'Inativa'}</span>
                      <button type="button" onClick={() => abrirEdicaoCap(m)} aria-label="Editar lugares" title="Editar nº de pessoas"
                        style={{ fontSize: 12, padding: '1px 6px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--primary)', fontWeight: 700, lineHeight: 1.4 }}>✏️</button>
                    </>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => { setQrMesa(m); setCopiado(false) }}
                    style={{ flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--primary)', background: 'rgba(134,59,255,.1)', color: 'var(--primary)', fontWeight: 700 }}>
                    📱 QR
                  </button>
                  <button type="button" onClick={() => alternarAtiva(m)}
                    style={{ flex: 1, fontSize: 12, padding: '5px 0', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>
                    {m.ativa ? 'Desativar' : 'Ativar'}
                  </button>
                  <button type="button" onClick={() => remover(m.id)} aria-label="Remover"
                    style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)' }}>
                    🗑
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Modal QR / Link da mesa */}
      {qrMesa && (
        <div onClick={() => setQrMesa(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 360, background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)', padding: 22, textAlign: 'center' }}>
            <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 4 }}>QR da Mesa {qrMesa.numero}</div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px' }}>
              Imprima e cole na mesa. O cliente escaneia e pede sozinho — vai direto pra cozinha.
            </p>
            {qrImg
              ? <img alt={`QR Mesa ${qrMesa.numero}`} src={qrImg} style={{ width: 240, height: 240, borderRadius: 12, background: '#fff' }} />
              : <div style={{ width: 240, height: 240, borderRadius: 12, background: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 13 }}>Gerando QR…</div>}
            <div style={{ wordBreak: 'break-all', fontSize: 12, color: 'var(--text-muted)', margin: '14px 0' }}>
              {linkMesa(qrMesa)}
            </div>
            <button type="button" onClick={() => baixarQr(qrMesa)}
              className="btn btn-primary" style={{ width: '100%', marginBottom: 8 }}>
              ⬇️ Baixar QR (pra imprimir)
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button"
                onClick={async () => { await navigator.clipboard.writeText(linkMesa(qrMesa)); setCopiado(true); setTimeout(() => setCopiado(false), 2000) }}
                className="btn btn-secondary" style={{ flex: 1 }}>
                {copiado ? '✓ Copiado!' : 'Copiar link'}
              </button>
              <button type="button" onClick={() => setQrMesa(null)}
                style={{ flex: '0 0 auto', padding: '0 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
