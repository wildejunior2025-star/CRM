import { useEffect, useState, useCallback, useRef } from 'react'
import { Tree, TreeNode } from 'react-organizational-chart'
import { supabase } from '../lib/supabaseClient'
import '../components/Page.css'

const CORES = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6']

function cor(str = '') {
  let h = 0
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h)
  return CORES[Math.abs(h) % CORES.length]
}

function iniciais(nome = '') {
  return nome.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()
}

function CardNo({ nome, pontos, nivel, diretos, ref_token }) {
  const bg = cor(nome)
  const [copiado, setCopiado] = useState(false)
  const timerRef = useRef(null)

  const link = ref_token
    ? `${window.location.origin}/entrar?ref=${ref_token}`
    : null

  function copiarLink(e) {
    e.stopPropagation()
    if (!link) return
    navigator.clipboard.writeText(link)
    setCopiado(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopiado(false), 2000)
  }

  return (
    <div style={{
      display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
      gap: 6, padding: '10px 14px', minWidth: 100,
      background: 'var(--bg-card)', border: '1.5px solid var(--border)',
      borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,.10)',
      cursor: 'default', fontSize: 11,
    }}>
      {/* Avatar */}
      <div style={{
        width: 44, height: 44, borderRadius: '50%',
        background: bg, color: '#fff', fontWeight: 700, fontSize: 15,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `2.5px solid ${bg}33`,
        flexShrink: 0,
      }}>
        {iniciais(nome)}
      </div>
      {/* Nome */}
      <div style={{ fontWeight: 600, fontSize: 11, maxWidth: 96, textAlign: 'center', lineHeight: 1.3 }}>
        {nome.split(' ').slice(0, 2).join(' ')}
      </div>
      {/* Stats */}
      <div style={{ display: 'flex', gap: 6 }}>
        {diretos > 0 && (
          <span style={{
            background: 'var(--bg-secondary)', borderRadius: 20,
            padding: '1px 7px', fontSize: 10, color: 'var(--text-muted)',
          }}>
            {diretos}
          </span>
        )}
        {pontos > 0 && (
          <span style={{
            background: '#f59e0b22', borderRadius: 20,
            padding: '1px 7px', fontSize: 10, color: '#b45309',
          }}>
            {pontos.toLocaleString('pt-BR')}
          </span>
        )}
      </div>
      {nivel > 0 && (
        <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>N{nivel}</div>
      )}
      {/* Botão copiar link de indicação */}
      {link && (
        <button
          onClick={copiarLink}
          style={{
            marginTop: 2, padding: '4px 10px', borderRadius: 20,
            border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 700,
            background: copiado ? '#16a34a' : '#7c3aed',
            color: '#fff', transition: 'background 200ms', whiteSpace: 'nowrap',
          }}
        >
          {copiado ? '✔ Copiado!' : 'Copiar link'}
        </button>
      )}
    </div>
  )
}

function NoArvore({ node }) {
  const filhos = node.children ?? []
  if (filhos.length === 0) {
    return <TreeNode label={<CardNo {...node} />} />
  }
  return (
    <TreeNode label={<CardNo {...node} />}>
      {filhos.map(f => <NoArvore key={f.id} node={f} />)}
    </TreeNode>
  )
}

function buildTree(flat, rootId, nivel = 0) {
  const node = flat.find(p => p.id === rootId)
  if (!node) return null
  const children = flat
    .filter(p => p.indicado_por === rootId)
    .map(p => buildTree(flat, p.id, nivel + 1))
    .filter(Boolean)
  return { ...node, nivel, children }
}

export default function SuperAdminRedeMapa() {
  const [loading, setLoading]   = useState(true)
  const [arvore, setArvore]     = useState(null)
  const [rootId, setRootId]     = useState(null)
  const [totalNos, setTotalNos] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)

    // Busca o super_admin (raiz)
    const { data: root } = await supabase
      .from('profiles')
      .select('id, nome')
      .eq('perfil', 'super_admin')
      .single()

    if (!root) { setLoading(false); return }
    setRootId(root.id)

    // Busca todos os descendentes pela closure table
    const { data: desc } = await supabase
      .from('indicacao_arvore')
      .select('descendant_id')
      .eq('ancestor_id', root.id)
      .gt('depth', 0)

    const ids = (desc ?? []).map(d => d.descendant_id)

    // Busca os perfis de todos (root + descendentes)
    const allIds = [root.id, ...ids]

    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, nome, indicado_por, ref_token')
      .in('id', allIds)

    // Busca saldos de pontos
    const { data: saldos } = await supabase
      .from('saldo_pontos')
      .select('profile_id, pontos_acumulados')
      .in('profile_id', allIds)

    const saldoMap = {}
    for (const s of saldos ?? []) saldoMap[s.profile_id] = s.pontos_acumulados

    // Conta diretos de cada perfil
    const diretosMap = {}
    for (const p of profiles ?? []) {
      if (p.indicado_por) {
        diretosMap[p.indicado_por] = (diretosMap[p.indicado_por] ?? 0) + 1
      }
    }

    const flat = (profiles ?? []).map(p => ({
      ...p,
      pontos: saldoMap[p.id] ?? 0,
      diretos: diretosMap[p.id] ?? 0,
    }))

    setTotalNos(flat.length)
    setArvore(buildTree(flat, root.id))
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) return <div className="page-loading">Montando árvore...</div>
  if (!arvore)  return <div className="page-loading">Nenhum dado encontrado.</div>

  return (
    <div className="page-container">
      <div className="page-header" style={{ marginBottom: 8 }}>
        <h1 className="page-title">Mapa da Rede</h1>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          {totalNos} pessoa{totalNos !== 1 ? 's' : ''} na rede
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 20 }}>
        Indicados diretos · Pontos acumulados · N = nível na rede
      </div>

      {/* Ãrea scrollÃ¡vel */}
      <div style={{
        overflowX: 'auto', overflowY: 'auto',
        padding: '24px 16px 40px',
        background: 'var(--bg-secondary)',
        borderRadius: 16, border: '1.5px solid var(--border)',
        minHeight: 400,
      }}>
        <Tree
          label={<CardNo {...arvore} />}
          lineWidth="2px"
          lineColor="var(--border)"
          lineBorderRadius="8px"
          nodePadding="8px"
        >
          {(arvore.children ?? []).map(f => (
            <NoArvore key={f.id} node={f} />
          ))}
        </Tree>
      </div>
    </div>
  )
}
