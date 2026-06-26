import { useEffect, useState, useCallback, useRef } from 'react'
import { Tree, TreeNode } from 'react-organizational-chart'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const STATUS_BADGE = {
  trial:     { bg: '#6366f122', color: '#6366f1', label: 'Trial' },
  ativo:     { bg: '#10b98122', color: '#10b981', label: 'Ativo' },
  atrasado:  { bg: '#f59e0b22', color: '#b45309', label: 'Atrasado' },
  suspenso:  { bg: '#ef444422', color: '#dc2626', label: 'Suspenso' },
  cancelado: { bg: '#88888822', color: '#888',    label: 'Cancelado' },
}

function iniciais(nome = '') {
  return nome.split(' ').slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase() || '?'
}

function fmt(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function CardEmpresa({ nome, status, valor_mensalidade, whatsapp_creditos, filhos, admin_ref_token, isRoot }) {
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.cancelado
  const [copiado, setCopiado] = useState(false)
  const timer = useRef(null)

  const link = admin_ref_token
    ? `${window.location.origin}/entrar?ref=${admin_ref_token}`
    : null

  function copiar(e) {
    e.stopPropagation()
    if (!link) return
    navigator.clipboard.writeText(link)
    setCopiado(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopiado(false), 2000)
  }

  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      padding: '10px 14px', minWidth: 120, maxWidth: 160,
      background: isRoot ? 'var(--primary)' : 'var(--card-bg, var(--bg))',
      border: `2px solid ${isRoot ? 'var(--primary)' : 'var(--border)'}`,
      borderRadius: 14, boxShadow: '0 2px 8px rgba(0,0,0,.12)',
      fontSize: 11,
    }}>
      {/* Avatar */}
      <div style={{
        width: 42, height: 42, borderRadius: '50%',
        background: isRoot ? 'rgba(255,255,255,.25)' : '#7c3aed22',
        color: isRoot ? '#fff' : '#7c3aed',
        fontWeight: 800, fontSize: 14,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        {isRoot ? '👑' : iniciais(nome)}
      </div>

      {/* Nome */}
      <div style={{
        fontWeight: 700, fontSize: 12, textAlign: 'center', lineHeight: 1.3,
        color: isRoot ? '#fff' : 'var(--text)',
        maxWidth: 130,
      }}>
        {nome}
      </div>

      {!isRoot && (
        <>
          {/* Status */}
          <div style={{
            padding: '1px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
            background: badge.bg, color: badge.color,
          }}>
            {badge.label}
          </div>

          {/* Stats */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'center' }}>
            {Number(valor_mensalidade) > 0 && (
              <span style={{ background: '#10b98122', borderRadius: 20, padding: '1px 7px', fontSize: 10, color: '#065f46' }}>
                {fmt(valor_mensalidade)}/mês
              </span>
            )}
            {filhos > 0 && (
              <span style={{ background: '#6366f122', borderRadius: 20, padding: '1px 7px', fontSize: 10, color: '#4338ca' }}>
                🏪 {filhos} loja{filhos !== 1 ? 's' : ''}
              </span>
            )}
            <span style={{
              borderRadius: 20, padding: '1px 7px', fontSize: 10, fontWeight: 700,
              background: (whatsapp_creditos ?? 0) === 0 ? '#ef444422' : '#10b98122',
              color: (whatsapp_creditos ?? 0) === 0 ? '#dc2626' : '#065f46',
            }}>
              💬 {whatsapp_creditos ?? 0}
            </span>
          </div>

          {/* Copiar link de indicação da loja */}
          {link && (
            <button
              onClick={copiar}
              style={{
                marginTop: 2, padding: '3px 10px', borderRadius: 20,
                border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 700,
                background: copiado ? '#16a34a' : '#7c3aed',
                color: '#fff', transition: 'background 200ms', whiteSpace: 'nowrap',
              }}
            >
              {copiado ? '✓ Copiado!' : '🔗 Link'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function NoArvore({ node }) {
  const filhos = node.children ?? []
  const card = <CardEmpresa {...node} filhos={filhos.length} />
  if (filhos.length === 0) return <TreeNode label={card} />
  return (
    <TreeNode label={card}>
      {filhos.map(f => <NoArvore key={f.id} node={f} />)}
    </TreeNode>
  )
}

function buildTree(empresas, adminMap, parentAdminId, depth = 0) {
  if (depth > 10) return []
  return empresas
    .filter(e => e.indicado_por === parentAdminId)
    .map(e => {
      const adminId = adminMap[e.id] // profile_id do admin desta empresa
      const children = adminId ? buildTree(empresas, adminMap, adminId, depth + 1) : []
      return { ...e, children }
    })
}

export default function SuperAdminEmpresaRede() {
  const [loading, setLoading] = useState(true)
  const [arvore, setArvore]   = useState(null)
  const [rootNome, setRootNome] = useState('')
  const [total, setTotal]     = useState(0)

  const load = useCallback(async () => {
    setLoading(true)

    // Busca super admin
    const { data: root } = await supabase
      .from('profiles')
      .select('id, nome')
      .eq('perfil', 'super_admin')
      .single()

    if (!root) { setLoading(false); return }
    setRootNome(root.nome)

    // Busca todas as empresas
    const { data: empresas } = await supabase
      .from('empresas')
      .select('id, nome, status, valor_mensalidade, whatsapp_creditos, indicado_por')

    // Busca profiles admin de cada empresa (para saber qual admin pertence a qual empresa)
    const { data: admins } = await supabase
      .from('profiles')
      .select('id, empresa_id, ref_token')
      .eq('perfil', 'admin')

    // adminMap: empresa_id → admin profile_id
    // refMap: empresa_id → admin ref_token
    const adminMap = {}
    const refMap   = {}
    for (const a of admins ?? []) {
      if (a.empresa_id) {
        adminMap[a.empresa_id] = a.id
        refMap[a.empresa_id]   = a.ref_token
      }
    }

    // Injeta ref_token do admin em cada empresa
    const empresasComRef = (empresas ?? []).map(e => ({
      ...e,
      admin_ref_token: refMap[e.id] ?? null,
    }))

    setTotal(empresasComRef.length)

    // Monta árvore a partir do super admin como raiz
    const children = buildTree(empresasComRef, adminMap, root.id)
    setArvore({ id: root.id, nome: root.nome, isRoot: true, children })
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="page-loading">Montando rede de lojas...</div>
  if (!arvore)  return <div className="page-loading">Nenhum dado encontrado.</div>

  const semIndicacao = arvore.children.length === 0
    ? 0
    : null

  return (
    <div className="page-container">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h1 className="page-title">Rede de Lojas</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {total} loja{total !== 1 ? 's' : ''} cadastrada{total !== 1 ? 's' : ''}
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span>🏪 = lojas indicadas abaixo</span>
        <span>💬 = créditos WhatsApp</span>
        <span>🔗 = copiar link de indicação da loja</span>
      </div>

      {arvore.children.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🏪</div>
          <p>Nenhuma loja indicada ainda.</p>
          <p style={{ fontSize: 13 }}>Compartilhe seu link de indicação para começar.</p>
        </div>
      ) : (
        <div style={{
          overflowX: 'auto', overflowY: 'auto',
          padding: '32px 16px 40px',
          background: 'var(--bg-secondary, var(--bg))',
          borderRadius: 16, border: '1.5px solid var(--border)',
          minHeight: 400,
        }}>
          <Tree
            label={<CardEmpresa nome={rootNome} isRoot={true} filhos={arvore.children.length} />}
            lineWidth="2px"
            lineColor="var(--border)"
            lineBorderRadius="8px"
            nodePadding="10px"
          >
            {arvore.children.map(f => <NoArvore key={f.id} node={f} />)}
          </Tree>
        </div>
      )}
    </div>
  )
}
