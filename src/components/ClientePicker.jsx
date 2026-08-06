import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Tira acento e deixa minúsculo: "jose" acha "José".
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

// Modal pra escolher um cliente já cadastrado OU cadastrar um novo na hora (nome +
// telefone). Usado no Salão (ligar cliente à mesa) e no histórico de contas fechadas.
// Chama onPick(cliente) ao escolher/criar e onPick(null) se clicar "Tirar cliente".
// `permitirSemCadastro` é pra comanda de balcão: o cliente que pede em pé quase
// nunca é cadastrado, e parar pra cadastrar todo mundo atrasa a fila (e enche a
// lista de clientes). Nesse modo dá pra usar só o nome digitado — chama
// onPick({ id: null, nome }), então quem recebe grava o nome sem ligar cliente.
export default function ClientePicker({ empresaId, titulo = 'Cliente da mesa', permitirTirar = false, permitirSemCadastro = false, onPick, onFechar }) {
  const [clientes, setClientes] = useState([])
  const [busca, setBusca] = useState('')
  const [novo, setNovo] = useState(false)
  const [telefone, setTelefone] = useState('')
  const [salvando, setSalvando] = useState(false)
  // Telefone de quem já está cadastrado SEM telefone: { id, valor }. No balcão o
  // cliente é cadastrado no aperto e o telefone fica pra depois — "depois" é aqui,
  // na próxima vez que alguém puxa o nome dele.
  const [telEdit, setTelEdit] = useState(null)
  const buscaRef = useRef(null)

  useEffect(() => {
    if (!empresaId) return
    supabase.from('clientes').select('id, nome, telefone').eq('empresa_id', empresaId).order('nome').limit(1000)
      .then(({ data }) => setClientes((data ?? []).filter(c => c.nome !== 'Consumidor (Mesa)')))
    setTimeout(() => buscaRef.current?.focus(), 50)
  }, [empresaId])

  const filtrados = busca.trim()
    ? clientes.filter(c => semAcento(c.nome).includes(semAcento(busca))).slice(0, 25)
    : []

  // Completa o cadastro de quem ficou sem telefone, sem sair daqui.
  async function salvarTelefone(cliente) {
    const tel = String(telEdit?.valor ?? '').trim()
    if (tel.replace(/\D/g, '').length < 10) { window.alert('Digite o telefone com DDD.'); return }
    setSalvando(true)
    const { error } = await supabase.from('clientes').update({ telefone: tel }).eq('id', cliente.id)
    setSalvando(false)
    if (error) { window.alert('Erro ao salvar o telefone: ' + error.message); return }
    setClientes(prev => prev.map(c => c.id === cliente.id ? { ...c, telefone: tel } : c))
    setTelEdit(null)
  }

  async function criar() {
    const nome = busca.trim()
    if (!nome) { window.alert('Digite o nome do cliente.'); return }
    setSalvando(true)
    const { data, error } = await supabase.from('clientes')
      .insert({ empresa_id: empresaId, nome, telefone: telefone.trim() || null })
      .select('id, nome, telefone').single()
    setSalvando(false)
    if (error) { window.alert('Erro ao cadastrar o cliente: ' + error.message); return }
    onPick(data)
  }

  return (
    <div onClick={onFechar}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 400, background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)', padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17 }}>👤 {titulo}</div>
          <button type="button" onClick={onFechar}
            style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
        </div>

        <input ref={buscaRef} value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar cliente pelo nome..."
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14.5, boxSizing: 'border-box' }} />

        {busca.trim() && !novo && (
          <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 8 }}>
            {filtrados.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '8px 2px' }}>
                Nenhum cliente com esse nome. Cadastre embaixo. 👇
              </div>
            ) : filtrados.map(c => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid var(--border)' }}>
                <button type="button" onClick={() => onPick(c)}
                  style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '10px 8px', cursor: 'pointer',
                    border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 14.5 }}>
                  {c.nome}
                  {c.telefone && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}> · {c.telefone}</span>}
                </button>
                {/* Cadastrado sem telefone da primeira vez? Põe agora, aqui mesmo. */}
                {!c.telefone && (
                  telEdit?.id === c.id ? (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '4px 0' }}>
                      <input value={telEdit.valor} type="tel" inputMode="tel" autoFocus placeholder="DDD + número"
                        onChange={e => setTelEdit(t => ({ ...t, valor: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') salvarTelefone(c) }}
                        style={{ width: 120, padding: '5px 7px', borderRadius: 6, border: '1px solid var(--border)',
                          background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 12.5 }} />
                      <button type="button" onClick={() => salvarTelefone(c)} disabled={salvando}
                        style={{ padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                          background: 'var(--primary)', color: '#fff', fontSize: 11.5, fontWeight: 800 }}>ok</button>
                      <button type="button" onClick={() => setTelEdit(null)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 15 }}>×</button>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setTelEdit({ id: c.id, valor: '' })}
                      title="Pôr o telefone deste cliente"
                      style={{ background: 'none', border: '1px dashed var(--border)', borderRadius: 6, padding: '4px 8px',
                        cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11.5, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      ➕ 📞
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        )}

        {permitirSemCadastro && busca.trim() && !novo && (
          <button type="button" onClick={() => onPick({ id: null, nome: busca.trim() })}
            style={{ width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 8, cursor: 'pointer',
              border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 13.5, fontWeight: 800 }}>
            Usar só o nome “{busca.trim()}”
          </button>
        )}

        {novo ? (
          <div style={{ marginTop: 10, padding: 12, borderRadius: 10, border: '1.5px solid var(--primary)', background: 'rgba(124,58,237,.05)' }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>Cadastrar cliente novo</div>
            <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Nome"
              style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' }} />
            <input value={telefone} onChange={e => setTelefone(e.target.value)} type="tel" inputMode="tel"
              placeholder="Telefone com DDD (opcional)"
              style={{ width: '100%', marginTop: 8, padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' }} />
            <button type="button" onClick={criar} disabled={salvando || !busca.trim()}
              style={{ width: '100%', marginTop: 10, padding: '10px 0', borderRadius: 8, border: 'none',
                background: 'var(--primary)', color: '#fff', fontSize: 13.5, fontWeight: 800,
                cursor: salvando ? 'wait' : 'pointer', opacity: (salvando || !busca.trim()) ? .5 : 1 }}>
              {salvando ? 'Cadastrando...' : `Cadastrar "${busca.trim() || '...'}" e usar`}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setNovo(true)}
            style={{ width: '100%', marginTop: 10, padding: '9px 0', borderRadius: 8, cursor: 'pointer',
              border: '1.5px dashed var(--primary)', background: 'transparent', color: 'var(--primary)', fontSize: 13.5, fontWeight: 700 }}>
            ➕ Cadastrar cliente novo (nome + telefone)
          </button>
        )}

        {permitirTirar && (
          <button type="button" onClick={() => onPick(null)}
            style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', fontSize: 13, fontWeight: 700 }}>
            Tirar cliente desta conta
          </button>
        )}
      </div>
    </div>
  )
}
