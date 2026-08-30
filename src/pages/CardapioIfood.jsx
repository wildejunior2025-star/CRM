import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useConfirmar } from '../hooks/useConfirmar'
import IfoodCatalogoManager from '../components/IfoodCatalogoManager'
import IfoodEnviarDaLoja from '../components/IfoodEnviarDaLoja'
import '../components/Page.css'

// ============================================================================
// Cardápio iFood — página própria, separada de Produtos.
//
// Por que separada: o cardápio do iFood NÃO é o cardápio da loja. O preço lá
// costuma ser mais alto pra cobrir a comissão, e os nomes raramente batem com
// os produtos daqui. Juntar as duas listas exigiria casar item por item, e todo
// casamento errado vira preço errado no ar. Tem loja em que os dois cardápios
// poderiam ser um só, e tem loja em que não — como não dá pra assumir nenhum
// dos dois casos, cada um fica no seu lugar.
//
// O "Importar" é a ponte, e vale principalmente pra cliente NOVO: quem já vende
// no iFood e ainda não cadastrou nada aqui traz o cardápio de lá de uma vez, em
// vez de digitar produto por produto.
// ============================================================================
const RED = '#ea1d2c'

export default function CardapioIfood() {
  const { empresa } = useAuth()
  const [confirmar, avisoConfirmar] = useConfirmar()
  const [cfg, setCfg] = useState(undefined)      // undefined = carregando, null = sem config
  const [importando, setImportando] = useState(false)
  const [msg, setMsg] = useState(null)           // { tipo, texto }
  // Muda depois de publicar: remonta a lista pra já mostrar o que subiu.
  const [recarregar, setRecarregar] = useState(0)
  // Escolha de quais categorias do iFood trazer pra cá.
  const [importar, setImportar] = useState(null)    // null = painel fechado; senão [{id,nome}]
  const [marcadas, setMarcadas] = useState(() => new Set())

  useEffect(() => {
    if (!empresa?.id) return
    supabase.from('ifood_config')
      .select('merchant_id, ambiente, ativo, ultimo_polling_em')
      .eq('empresa_id', empresa.id)
      .maybeSingle()
      .then(({ data }) => setCfg(data ?? null))
  }, [empresa?.id])

  async function abrirImportar() {
    setMsg(null)
    setImportar('carregando')
    const d = await chamarIfood({ acao: 'catalogo_categorias', empresa_id: empresa.id })
    if (d.ok) {
      setImportar(d.categorias ?? [])
      setMarcadas(new Set())
    } else {
      setImportar(null)
      setMsg({ tipo: 'erro', texto: d.error ?? 'Falha ao listar as categorias do iFood' })
    }
  }

  async function chamarIfood(payload) {
    const { data: { session } } = await supabase.auth.getSession()
    const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
      body: JSON.stringify(payload),
    })
    return res.json()
  }

  async function importarCardapio() {
    const nomes = (Array.isArray(importar) ? importar : []).filter(c => marcadas.has(c.id)).map(c => c.nome)
    const ok = await confirmar({
      titulo: nomes.length ? `Trazer ${nomes.length} categoria(s) pra cá?` : 'Trazer o cardápio inteiro pra cá?',
      texto: 'Copia os produtos da sua loja no iFood pro seu catálogo daqui. Produto que já existe não é duplicado — ele só passa a ficar ligado ao item do iFood.',
      itens: nomes.length ? nomes : undefined,
      aviso: 'Isso NÃO mexe no seu cardápio do iFood — só traz uma cópia pra cá.',
      textoOk: 'Sim, trazer',
      perigo: false,
    })
    if (!ok) return

    setImportando(true); setMsg(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://ycytrsqdvrviihkqfvno.supabase.co'}/functions/v1/ifood-integration`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ acao: 'catalogo', empresa_id: empresa.id, categoria_ids: [...marcadas] }),
      })
      const data = await res.json()
      if (data.ok) {
        setMsg({
          tipo: 'ok',
          texto: data.criados > 0
            ? `Cardápio importado! ${data.criados} produto(s) novo(s) (de ${data.total} encontrados). Veja em Catálogo → Produtos.`
            : `Nenhum produto novo pra importar (${data.total} já estavam no sistema).`,
        })
        setImportar(null); setMarcadas(new Set())
      } else setMsg({ tipo: 'erro', texto: data.error ?? 'Falha ao importar o cardápio' })
    } catch (err) {
      setMsg({ tipo: 'erro', texto: String(err.message ?? err) })
    }
    setImportando(false)
  }

  if (cfg === undefined) {
    return (
      <div>
        <div className="page-header"><h1>Cardápio iFood</h1></div>
        <p style={{ color: 'var(--text-muted)' }}>Carregando…</p>
      </div>
    )
  }

  // Sem loja conectada a página não tem o que mostrar — em vez de uma tela
  // vazia, aponta pro lugar onde se conecta.
  if (!cfg?.merchant_id) {
    return (
      <div>
        <div className="page-header"><h1>Cardápio iFood</h1></div>
        <div className="card" style={{ padding: 20, maxWidth: 620 }}>
          <strong style={{ fontSize: 15 }}>Sua loja do iFood ainda não está conectada</strong>
          <p style={{ fontSize: 13.5, color: 'var(--text-muted)', margin: '8px 0 14px' }}>
            Depois de conectar, você edita o cardápio do iFood por aqui — criar item, trocar preço,
            pausar o que esgotou — sem precisar entrar no Portal do Parceiro.
          </p>
          <Link to="/loja-integracoes" className="btn btn-primary" style={{ textDecoration: 'none' }}>
            Conectar minha loja do iFood
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div>
      {avisoConfirmar}
      <div className="page-header">
        <h1>
          <span style={{
            background: RED, color: '#fff', fontWeight: 800, fontSize: 12,
            padding: '3px 8px', borderRadius: 6, marginRight: 10, verticalAlign: 'middle',
          }}>iFood</span>
          Cardápio iFood
        </h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" disabled={importando} onClick={() => importar ? setImportar(null) : abrirImportar()}>
            {importando ? 'Trazendo…' : '📥 Trazer pro meu catálogo'}
          </button>
        </div>
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px', maxWidth: 720 }}>
        Este é o cardápio que está <strong>no ar no iFood</strong> — separado do seu cardápio da loja,
        porque os preços e os nomes costumam ser diferentes nos dois. O que você mudar aqui muda lá na hora.
        {cfg.ambiente === 'teste' && <strong style={{ color: RED }}> (Ambiente de teste.)</strong>}
      </p>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px', maxWidth: 720 }}>
        🔗 <strong>Produto publicado daqui fica ligado ao item de lá:</strong> quando você pausar no
        seu catálogo (acabou o frango), ele pausa no iFood na mesma hora — não precisa lembrar de
        pausar nos dois lugares. Vale pro que você enviou por aqui e pro que importou do iFood.
        Pausar direto no Portal do Parceiro não volta pra cá: aparece quando esta tela for aberta.
      </p>

      {msg && (
        <div style={{
          margin: '0 0 14px', padding: '10px 12px', borderRadius: 8, fontSize: 13,
          background: msg.tipo === 'ok' ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.12)',
          color: msg.tipo === 'ok' ? '#16a34a' : '#dc2626',
        }}>
          {msg.texto}
        </div>
      )}

      {importar && (
        <div className="card" style={{ padding: 16, marginBottom: 14, border: '1.5px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <strong style={{ fontSize: 14 }}>Trazer do iFood pro meu catálogo</strong>
            <button type="button" onClick={() => setImportar(null)}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 18 }}>✕</button>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            Marque as categorias que quer trazer. Sem marcar nenhuma, vem o cardápio inteiro.
            Produto que já existe aqui não é duplicado — ele só passa a ficar ligado ao item do iFood.
          </p>

          {importar === 'carregando' && <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>Carregando as categorias…</p>}

          {Array.isArray(importar) && (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {importar.map(c => {
                  const marcada = marcadas.has(c.id)
                  return (
                    <label key={c.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                      padding: '7px 12px', borderRadius: 8, fontSize: 13,
                      border: `1.5px solid ${marcada ? RED : 'var(--border)'}`,
                      background: marcada ? 'rgba(234,29,44,.08)' : 'transparent',
                    }}>
                      <input type='checkbox' checked={marcada} style={{ width: 15, height: 15, cursor: 'pointer' }}
                        onChange={() => setMarcadas(prev => {
                          const st = new Set(prev)
                          marcada ? st.delete(c.id) : st.add(c.id)
                          return st
                        })} />
                      {c.nome}
                    </label>
                  )
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" disabled={importando} onClick={importarCardapio}>
                  {importando ? 'Trazendo…'
                    : marcadas.size ? `Trazer ${marcadas.size} categoria${marcadas.size === 1 ? '' : 's'}`
                    : 'Trazer o cardápio inteiro'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="card" style={{ padding: 18 }}>
        <IfoodEnviarDaLoja empresaId={empresa?.id} onPronto={() => setRecarregar(n => n + 1)} />
        <IfoodCatalogoManager key={recarregar} empresaId={empresa?.id} merchantOk={!!cfg.merchant_id} autoCarregar />
      </div>
    </div>
  )
}
