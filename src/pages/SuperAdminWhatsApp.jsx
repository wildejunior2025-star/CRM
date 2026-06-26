import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'

const DEFAULT_PROMPT = `TÉCNICAS DE ATENDIMENTO E VENDAS:

1. SAUDAÇÃO: Sempre cumprimente o cliente com simpatia. Use o nome do cliente se disponível.

2. ESCUTA ATIVA: Entenda o que o cliente precisa antes de oferecer produtos. Faça perguntas curtas quando necessário.

3. SUGESTÃO INTELIGENTE: Ao adicionar um produto, sempre sugira um complementar. Exemplo: se pediu refrigerante, sugira salgadinho ou gelo.

4. TRANSPARÊNCIA: Seja sempre honesto sobre preços e disponibilidade. Nunca invente informações.

5. OBJEÇÕES: Se o cliente achar caro, destaque a qualidade, quantidade ou promoção disponível. Não insista mais de uma vez.

6. FECHAMENTO: Quando o cliente parecer satisfeito com os itens, pergunte se deseja fechar o pedido.

7. LINGUAGEM: Use linguagem simples, informal e amigável. Evite palavras difíceis. Emoji com moderação é bem-vindo.

8. AGILIDADE: Respostas curtas e diretas. Máximo 3 linhas por mensagem.

9. PEDIDO MÍNIMO: Não mencione valor mínimo a menos que seja configurado pela loja.

10. DESPEDIDA: Ao fechar pedido, agradeça e informe que o pedido foi registrado com sucesso.`

const SUPABASE_URL = 'https://ycytrsqdvrviihkqfvno.supabase.co'

async function callAdminWA(body, session) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-whatsapp-connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token ?? ''}`,
    },
    body: JSON.stringify(body),
  })
  return res.json()
}

function formatPhone(phone) {
  if (!phone) return ''
  const d = phone.replace(/\D/g, '')
  if (d.length === 13) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`
  if (d.length === 12) return `+${d.slice(0,2)} (${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`
  return `+${d}`
}

export default function SuperAdminWhatsApp() {
  const [promptPadrao, setPromptPadrao] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  const [adminPhone, setAdminPhone] = useState('')
  const [alertasAtivo, setAlertasAtivo] = useState(true)
  const [savingPhone, setSavingPhone] = useState(false)
  const [phoneMsg, setPhoneMsg] = useState('')
  const [testando, setTestando] = useState(false)
  const [testMsg, setTestMsg] = useState('')

  // Remetente atual
  const [remetente, setRemetente] = useState(null) // { instanceName, state, phone }
  const [loadingRemetente, setLoadingRemetente] = useState(true)

  // Fluxo novo QR
  const [showQR, setShowQR] = useState(false)
  const [qrImg, setQrImg] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [qrStatus, setQrStatus] = useState('') // 'waiting' | 'connected' | 'error'
  const pollRef = useRef(null)

  const [empresas, setEmpresas] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadData()
    loadRemetente()
    return () => clearInterval(pollRef.current)
  }, [])

  async function getSession() {
    const { data: { session } } = await supabase.auth.getSession()
    return session
  }

  async function loadRemetente() {
    setLoadingRemetente(true)
    const session = await getSession()
    const data = await callAdminWA({ action: 'current' }, session)
    setRemetente(data)
    setLoadingRemetente(false)
  }

  async function handleConectarNovo() {
    setShowQR(true)
    setQrImg('')
    setQrStatus('waiting')
    setQrLoading(true)
    const session = await getSession()
    const data = await callAdminWA({ action: 'create_qr' }, session)
    setQrLoading(false)
    if (!data.ok || !data.qr) {
      setQrStatus('error')
      return
    }
    setQrImg(data.qr)
    // Polling a cada 3s para checar se conectou
    pollRef.current = setInterval(async () => {
      const s = await getSession()
      const check = await callAdminWA({ action: 'check_status' }, s)
      if (check.state === 'open') {
        clearInterval(pollRef.current)
        setQrStatus('connected')
        setRemetente({ instanceName: 'crmadmin', state: 'open', phone: check.phone })
        setTimeout(() => { setShowQR(false); setQrImg('') }, 2000)
      }
    }, 3000)
  }

  function handleCancelarQR() {
    clearInterval(pollRef.current)
    setShowQR(false)
    setQrImg('')
    setQrStatus('')
  }

  async function loadData() {
    setLoading(true)
    const [cfgRes, empresasRes] = await Promise.all([
      supabase.from('config_global').select('chave, valor')
        .in('chave', ['ia_prompt_padrao', 'super_admin_phone', 'alertas_mensalidade_ativo']),
      supabase.from('empresas')
        .select('id, nome, whatsapp_creditos, status, vencimento, whatsapp_config(ativo, ia_ativo, instance_name)')
        .order('nome'),
    ])
    const map = {}
    for (const row of cfgRes.data ?? []) map[row.chave] = row.valor
    setPromptPadrao(map['ia_prompt_padrao'] || DEFAULT_PROMPT)
    setAdminPhone(map['super_admin_phone'] ?? '')
    setAlertasAtivo(map['alertas_mensalidade_ativo'] !== 'false')
    setEmpresas(empresasRes.data ?? [])
    setLoading(false)
  }

  async function handleSavePrompt() {
    setSaving(true)
    const { error } = await supabase.from('config_global').upsert({
      chave: 'ia_prompt_padrao', valor: promptPadrao, atualizado_em: new Date().toISOString(),
    })
    setSaving(false)
    setSaveMsg(error ? 'Erro: ' + error.message : 'Salvo!')
    setTimeout(() => setSaveMsg(''), 3000)
  }

  async function handleSavePhone() {
    setSavingPhone(true)
    const phoneClean = adminPhone.replace(/\D/g, '')
    const [r1, r2] = await Promise.all([
      supabase.from('config_global').upsert({ chave: 'super_admin_phone', valor: phoneClean, atualizado_em: new Date().toISOString() }),
      supabase.from('config_global').upsert({ chave: 'alertas_mensalidade_ativo', valor: alertasAtivo ? 'true' : 'false', atualizado_em: new Date().toISOString() }),
    ])
    setSavingPhone(false)
    const err = r1.error || r2.error
    setPhoneMsg(err ? 'Erro: ' + err.message : 'Salvo!')
    setTimeout(() => setPhoneMsg(''), 3000)
  }

  async function handleTestarAlerta() {
    setTestando(true)
    setTestMsg('')
    try {
      const session = await getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-alertas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (json.ok) {
        setTestMsg(json.enviadas > 0 ? `Alerta enviado! ${json.enviadas} empresa(s) em atraso.` : 'Sem empresas em atraso no momento.')
      } else {
        setTestMsg('Erro: ' + (json.msg || json.error || 'falha no envio'))
      }
    } catch (e) {
      setTestMsg('Erro: ' + String(e))
    }
    setTestando(false)
  }

  const card = { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, marginBottom: 24 }
  const hoje = new Date().toISOString().split('T')[0]
  const isConectado = remetente?.state === 'open'

  return (
    <div style={{ padding: '24px', maxWidth: 960 }}>
      <h2 style={{ marginBottom: 8 }}>WhatsApp — Configurações Globais</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: 24, fontSize: 14 }}>
        Configure o número que envia cobranças e alertas, e gerencie o Vendedor IA de todas as lojas.
      </p>

      {/* WhatsApp Remetente */}
      <div style={card}>
        <h3 style={{ margin: '0 0 4px' }}>WhatsApp Remetente</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Número que envia cobranças para empresas e alertas para você.
        </p>

        {loadingRemetente ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Carregando...</p>
        ) : !showQR ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Card do remetente atual */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 16,
              padding: '14px 18px', borderRadius: 10,
              border: `1px solid ${isConectado ? '#22c55e44' : 'var(--border)'}`,
              background: isConectado ? '#16a34a0d' : 'var(--bg)',
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%', flexShrink: 0,
                background: isConectado ? '#16a34a22' : '#64748b22',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill={isConectado ? '#22c55e' : '#94a3b8'}>
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                  <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.523 5.847L0 24l6.335-1.499A11.934 11.934 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.885 0-3.65-.49-5.19-1.352l-.372-.22-3.862.913.976-3.768-.242-.387A9.937 9.937 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                {remetente?.instanceName ? (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {remetente.phone ? formatPhone(remetente.phone) : remetente.instanceName}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      Instância: {remetente.instanceName}
                    </div>
                  </>
                ) : (
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-muted)' }}>
                    Nenhum número configurado
                  </div>
                )}
              </div>
              <span style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700,
                background: isConectado ? '#16a34a22' : '#64748b22',
                color: isConectado ? '#22c55e' : '#94a3b8',
              }}>
                {isConectado ? 'Conectado' : remetente?.instanceName ? 'Desconectado' : 'Não configurado'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-secondary" onClick={loadRemetente} type="button">
                Atualizar status
              </button>
              <button className="btn btn-primary" onClick={handleConectarNovo} type="button">
                {remetente?.instanceName ? 'Trocar número' : 'Conectar número'}
              </button>
            </div>
          </div>
        ) : (
          /* Fluxo QR */
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            {qrLoading && <p style={{ color: 'var(--text-muted)' }}>Gerando QR code...</p>}

            {qrStatus === 'error' && (
              <p style={{ color: '#ef4444' }}>Erro ao gerar QR. Tente novamente.</p>
            )}

            {qrStatus === 'connected' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 40 }}>✅</div>
                <p style={{ fontWeight: 700, color: '#22c55e', marginTop: 8 }}>WhatsApp conectado!</p>
              </div>
            )}

            {qrImg && qrStatus === 'waiting' && (
              <>
                <p style={{ fontSize: 14, color: 'var(--text-muted)', textAlign: 'center' }}>
                  Abra o WhatsApp no celular → <strong>Dispositivos conectados</strong> → <strong>Conectar dispositivo</strong> → escaneie o QR abaixo
                </p>
                <img
                  src={qrImg.startsWith('data:') ? qrImg : `data:image/png;base64,${qrImg}`}
                  alt="QR Code"
                  style={{ width: 240, height: 240, borderRadius: 12, border: '1px solid var(--border)' }}
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Aguardando leitura...</p>
              </>
            )}

            {qrStatus !== 'connected' && (
              <button className="btn btn-secondary btn-sm" onClick={handleCancelarQR} type="button">
                Cancelar
              </button>
            )}
          </div>
        )}
      </div>

      {/* Alertas */}
      <div style={card}>
        <h3 style={{ margin: '0 0 4px' }}>Alertas de Mensalidade</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Receba no seu WhatsApp quando uma empresa estiver em atraso. Disparado todo dia às 9h (Brasília).
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 4 }}>Número que recebe os alertas</label>
            <input
              type="text"
              value={adminPhone}
              onChange={e => setAdminPhone(e.target.value)}
              placeholder="Ex: 5511999990000"
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14, width: 260 }}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14 }}>
            <input type="checkbox" checked={alertasAtivo} onChange={e => setAlertasAtivo(e.target.checked)} style={{ width: 16, height: 16 }} />
            Ativar alertas automáticos de mensalidade vencida
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={handleSavePhone} disabled={savingPhone} type="button">
              {savingPhone ? 'Salvando...' : 'Salvar'}
            </button>
            <button className="btn btn-secondary" onClick={handleTestarAlerta} disabled={testando || !adminPhone} type="button">
              {testando ? 'Enviando...' : 'Testar alerta agora'}
            </button>
            {phoneMsg && <span style={{ color: phoneMsg.startsWith('Erro') ? '#ef4444' : '#22c55e', fontSize: 14 }}>{phoneMsg}</span>}
            {testMsg && <span style={{ color: testMsg.startsWith('Erro') ? '#ef4444' : '#22c55e', fontSize: 14 }}>{testMsg}</span>}
          </div>
        </div>
      </div>

      {/* Status das empresas */}
      <div style={card}>
        <h3 style={{ margin: '0 0 16px' }}>Status WhatsApp por Empresa</h3>
        {loading ? <p style={{ color: 'var(--text-muted)' }}>Carregando...</p> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['EMPRESA', 'STATUS', 'VENCIMENTO', 'INSTÂNCIA', 'CONEXÃO WA', 'IA', 'CRÉDITOS'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {empresas.map(emp => {
                  const wc = Array.isArray(emp.whatsapp_config) ? emp.whatsapp_config[0] : emp.whatsapp_config
                  const creditos = emp.whatsapp_creditos ?? 0
                  const creditColor = creditos === 0 ? '#ef4444' : creditos < 10 ? '#f97316' : '#22c55e'
                  const vencido = emp.status === 'ativo' && emp.vencimento && emp.vencimento < hoje
                  return (
                    <tr key={emp.id} style={{ borderBottom: '1px solid var(--border)', background: vencido ? '#ef444410' : undefined }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500 }}>
                        {vencido && <span title="Mensalidade vencida" style={{ marginRight: 6 }}>🚨</span>}
                        {emp.nome}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: emp.status === 'ativo' ? '#16a34a22' : '#f9731622', color: emp.status === 'ativo' ? '#22c55e' : '#f97316', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600, textTransform: 'capitalize' }}>
                          {emp.status}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: 13, color: vencido ? '#ef4444' : 'var(--text-muted)', fontWeight: vencido ? 700 : 400 }}>
                        {emp.vencimento ?? '—'}
                      </td>
                      <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontSize: 12, fontFamily: 'monospace' }}>{wc?.instance_name || '—'}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {wc?.ativo
                          ? <span style={{ background: '#16a34a22', color: '#22c55e', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>Conectado</span>
                          : <span style={{ background: '#64748b22', color: '#94a3b8', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>Desconectado</span>}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {wc?.ia_ativo
                          ? <span style={{ background: '#7c3aed22', color: '#a78bfa', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>Ativa</span>
                          : <span style={{ background: '#64748b22', color: '#94a3b8', padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>Inativa</span>}
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: 700, color: creditColor }}>{creditos}</td>
                    </tr>
                  )
                })}
                {empresas.length === 0 && <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Nenhuma empresa encontrada</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Prompt padrão */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Prompt Padrão do Vendedor IA</h3>
          <button className="btn btn-secondary btn-sm" onClick={() => setPromptPadrao(DEFAULT_PROMPT)} type="button">Restaurar padrão</button>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
          Aplicado a <strong>todas as lojas automaticamente</strong>, antes do roteiro individual de cada empresa.
        </p>
        <textarea
          value={promptPadrao}
          onChange={e => setPromptPadrao(e.target.value)}
          rows={20}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 13, padding: 12, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', boxSizing: 'border-box' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn btn-primary" onClick={handleSavePrompt} disabled={saving} type="button">
            {saving ? 'Salvando...' : 'Salvar prompt padrão'}
          </button>
          {saveMsg && <span style={{ color: saveMsg.startsWith('Erro') ? '#ef4444' : '#22c55e', fontSize: 14 }}>{saveMsg}</span>}
        </div>
      </div>
    </div>
  )
}
