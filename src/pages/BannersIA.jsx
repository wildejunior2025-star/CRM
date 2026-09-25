import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, fetchAll, invocarEdge } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { useConfirmar } from '../hooks/useConfirmar'
import { desenharBanner, carregarImagem, carregarFontesBanner } from '../lib/bannerCompositor'
import '../components/Page.css'
import './BannersIA.css'

// BANNERS COM IA (mig 0270).
//
// A loja escolhe o produto, escreve o tema e a promoção. A IA recria a foto do
// produto numa cena de propaganda (sem letra nenhuma) e organiza os textos; o
// navegador escreve o banner com as fontes aprovadas. Qualquer texto dá pra
// ajustar e ver na hora sem gastar geração. Salvo, o banner vai pro topo da
// Loja Online e o clique abre o produto.

const ETAPAS = [
  'Lendo o produto e a promoção…',
  'Montando a cena da foto…',
  'Acertando a luz e o clima…',
  'Deixando com cara de propaganda…',
  'Caprichando nos detalhes…',
  'Quase pronto…',
]

const ESTILOS_SELO = [
  ['pequeno', 'Frase'],
  ['faixa', 'Faixa vermelha'],
  ['grande', 'Grande'],
  ['destaque', 'Destaque vermelho'],
]

const fmt = v => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function BannersIA() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const [confirmar, avisoConfirmar] = useConfirmar()

  const [produtos, setProdutos] = useState([])
  const [busca, setBusca] = useState('')
  const [produtoSel, setProdutoSel] = useState(null)
  const [tema, setTema] = useState('')
  const [promocao, setPromocao] = useState('')

  const [gerando, setGerando] = useState(false)
  const [etapa, setEtapa] = useState(0)
  const [progresso, setProgresso] = useState(0)
  const [erro, setErro] = useState(null)

  const [cena, setCena] = useState(null)          // { url, img }
  const [textos, setTextos] = useState(null)
  const [salvando, setSalvando] = useState(false)
  const [aviso, setAviso] = useState(null)

  const [biblioteca, setBiblioteca] = useState([])
  const [usados, setUsados] = useState(0)
  const [limite, setLimite] = useState(16)

  const canvasRef = useRef(null)

  const carregarBiblioteca = useCallback(async () => {
    if (!empresaId) return
    const inicioMes = new Date()
    inicioMes.setDate(1)
    inicioMes.setHours(0, 0, 0, 0)
    const [{ data: bans }, { count }] = await Promise.all([
      supabase.from('banners').select('id, produto_id, imagem_url, ativo, tema, promocao, criado_em')
        .eq('empresa_id', empresaId).order('criado_em', { ascending: false }),
      supabase.from('banner_geracoes').select('id', { count: 'exact', head: true })
        .eq('empresa_id', empresaId).gte('criado_em', inicioMes.toISOString()),
    ])
    setBiblioteca(bans ?? [])
    setUsados(count ?? 0)
  }, [empresaId])

  useEffect(() => {
    if (!empresaId) return
    carregarFontesBanner().catch(() => {})
    fetchAll(() => supabase.from('produtos')
      .select('id, nome, categoria, preco_venda, preco_promocional, foto_url')
      .eq('empresa_id', empresaId).eq('ativo', true).is('arquivado_em', null).order('nome'))
      .then(({ data }) => setProdutos(data ?? []))
    carregarBiblioteca()
  }, [empresaId, carregarBiblioteca])

  const filtrados = useMemo(() => {
    const t = busca.trim().toLowerCase()
    return t ? produtos.filter(p => p.nome.toLowerCase().includes(t) || (p.categoria ?? '').toLowerCase().includes(t)) : produtos
  }, [produtos, busca])

  // Redesenha o banner a cada ajuste de texto (é de graça: não chama a IA).
  useEffect(() => {
    if (!cena?.img || !textos || !canvasRef.current) return
    let cancelado = false
    const id = setTimeout(() => {
      if (!cancelado) desenharBanner(canvasRef.current, cena.img, textos).catch(e => setErro(String(e)))
    }, 120)
    return () => { cancelado = true; clearTimeout(id) }
  }, [cena, textos])

  async function gerar() {
    if (!produtoSel) { setErro('Escolha o produto.'); return }
    setErro(null)
    setAviso(null)
    setGerando(true)
    setEtapa(0)
    setProgresso(3)
    const inicio = Date.now()
    const timer = setInterval(() => {
      const s = (Date.now() - inicio) / 1000
      setEtapa(Math.min(ETAPAS.length - 1, Math.floor(s / 12)))
      setProgresso(Math.min(94, Math.round(3 + 91 * (1 - Math.exp(-s / 35)))))
    }, 500)
    try {
      const { data, error } = await invocarEdge('gerar-banner', { produto_id: produtoSel.id, tema, promocao })
      if (error || !data?.ok) {
        const msg = data?.error || (await error?.context?.json?.().catch(() => null))?.error || error?.message
        throw new Error(msg || 'Não foi possível gerar agora.')
      }
      const img = await carregarImagem(data.cena_url)
      setProgresso(100)
      setCena({ url: data.cena_url, img })
      setTextos(data.textos)
      if (data.usados != null) setUsados(data.usados)
      if (data.limite) setLimite(data.limite)
    } catch (e) {
      setErro(String(e.message ?? e))
    } finally {
      clearInterval(timer)
      setGerando(false)
    }
  }

  function mudarTexto(campo, valor) {
    setTextos(prev => ({ ...prev, [campo]: valor }))
  }
  function mudarSelo(i, campo, valor) {
    setTextos(prev => {
      const selo = [...(prev.selo ?? [])]
      while (selo.length <= i) selo.push({ texto: '', estilo: 'pequeno' })
      selo[i] = { ...selo[i], [campo]: valor }
      return { ...prev, selo }
    })
  }

  function blobDoCanvas() {
    return new Promise(resolve => canvasRef.current.toBlob(resolve, 'image/jpeg', 0.92))
  }

  async function baixar(url, nome) {
    const a = document.createElement('a')
    a.href = url
    a.download = nome
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  async function baixarAtual() {
    const blob = await blobDoCanvas()
    const url = URL.createObjectURL(blob)
    await baixar(url, `banner-${(textos?.titulo || 'produto').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  async function salvar() {
    if (!canvasRef.current || !empresaId) return
    setSalvando(true)
    setErro(null)
    try {
      const blob = await blobDoCanvas()
      const caminho = `${empresaId}/${crypto.randomUUID()}.jpg`
      const { error: upErr } = await supabase.storage.from('banners').upload(caminho, blob, { contentType: 'image/jpeg' })
      if (upErr) throw upErr
      const imagemUrl = supabase.storage.from('banners').getPublicUrl(caminho).data.publicUrl
      const { error: insErr } = await supabase.from('banners').insert({
        empresa_id: empresaId, produto_id: produtoSel?.id ?? null, tema, promocao,
        textos, cena_url: cena?.url ?? null, imagem_url: imagemUrl, ativo: true,
        criado_por: profile?.id ?? null,
      })
      if (insErr) throw insErr
      setAviso('✅ Banner salvo e publicado no topo da sua Loja Online.')
      setCena(null)
      setTextos(null)
      carregarBiblioteca()
    } catch (e) {
      setErro('Não consegui salvar: ' + (e.message ?? e))
    } finally {
      setSalvando(false)
    }
  }

  async function alternarAtivo(b) {
    setBiblioteca(prev => prev.map(x => x.id === b.id ? { ...x, ativo: !b.ativo } : x))
    const { error } = await supabase.from('banners').update({ ativo: !b.ativo }).eq('id', b.id)
    if (error) {
      setBiblioteca(prev => prev.map(x => x.id === b.id ? { ...x, ativo: b.ativo } : x))
      setErro(error.message)
    }
  }

  async function apagar(b) {
    const ok = await confirmar({
      titulo: 'Apagar este banner?',
      texto: 'Ele sai da Loja Online e da sua biblioteca — não dá pra desfazer.',
      aviso: 'Se é só por um tempo, desligue o "Na Loja Online" em vez de apagar.',
      textoOk: 'Sim, apagar',
    })
    if (!ok) return
    const { error } = await supabase.from('banners').delete().eq('id', b.id)
    if (error) { setErro(error.message); return }
    const caminho = String(b.imagem_url).split('/banners/')[1]
    if (caminho) supabase.storage.from('banners').remove([caminho]).catch(() => {})
    setBiblioteca(prev => prev.filter(x => x.id !== b.id))
  }

  const restantes = Math.max(0, limite - usados)
  const nomeProduto = id => produtos.find(p => p.id === id)?.nome ?? ''

  return (
    <div className="page bia">
      {avisoConfirmar}
      <div className="page-header">
        <h1>✨ Banners com IA</h1>
        <span className={`bia-cota ${restantes === 0 ? 'bia-cota-fim' : ''}`}>
          {usados}/{limite} gerados este mês
        </span>
      </div>
      <p className="bia-intro">
        Escolha o produto, diga o tema e a promoção. A IA cria a foto de propaganda e o sistema escreve o
        preço e os textos certinhos. Depois é só ajustar e publicar no topo da sua Loja Online.
      </p>

      {erro && <div className="bia-erro">⚠️ {erro}</div>}
      {aviso && <div className="bia-aviso">{aviso}</div>}

      <div className="bia-grade">
        {/* ── 1. formulário ── */}
        <section className="bia-card">
          <h2>1. Escolha o produto</h2>
          <input className="bia-input" placeholder="Buscar produto…" value={busca} onChange={e => setBusca(e.target.value)} />
          <div className="bia-produtos">
            {filtrados.map(p => (
              <button key={p.id} type="button"
                className={`bia-produto ${produtoSel?.id === p.id ? 'sel' : ''}`}
                onClick={() => setProdutoSel(p)}>
                {p.foto_url
                  ? <img src={p.foto_url} alt="" loading="lazy" />
                  : <span className="bia-sem-foto">sem foto</span>}
                <span className="bia-produto-nome">{p.nome}</span>
                <span className="bia-produto-preco">
                  {fmt(Number(p.preco_promocional) > 0 ? p.preco_promocional : p.preco_venda)}
                </span>
              </button>
            ))}
            {!filtrados.length && <p className="bia-vazio">Nenhum produto encontrado.</p>}
          </div>
          {produtoSel && !produtoSel.foto_url && (
            <p className="bia-dica">💡 Esse produto não tem foto. A IA cria uma do zero — com a foto real fica bem mais fiel.</p>
          )}

          <h2>2. Tema da promoção</h2>
          <input className="bia-input" maxLength={120} value={tema} onChange={e => setTema(e.target.value)}
            placeholder="Ex.: monte seu cuscuz, Dia dos Namorados, Festa Junina" />

          <h2>3. A promoção</h2>
          <input className="bia-input" maxLength={200} value={promocao} onChange={e => setPromocao(e.target.value)}
            placeholder="Ex.: na compra de um cuscuz ganhe um café grátis" />

          <button type="button" className="btn btn-primary bia-gerar" disabled={gerando || !produtoSel || restantes === 0} onClick={gerar}>
            {gerando ? 'Gerando…' : restantes === 0 ? 'Limite do mês atingido' : '✨ Gerar banner'}
          </button>
          {gerando && (
            <div className="bia-progresso">
              <div className="bia-barra"><div style={{ width: `${progresso}%` }} /></div>
              <span>{ETAPAS[etapa]} {progresso}%</span>
              <small>Leva cerca de 1 minuto.</small>
            </div>
          )}
        </section>

        {/* ── 2. prévia e ajustes ── */}
        <section className="bia-card">
          <h2>Prévia</h2>
          {!cena && !gerando && (
            <div className="bia-placeholder">O banner aparece aqui depois de gerar.</div>
          )}
          {gerando && !cena && <div className="bia-placeholder bia-pulsa">Criando a cena…</div>}
          <canvas ref={canvasRef} className="bia-canvas" style={{ display: cena ? 'block' : 'none' }} />

          {cena && textos && (
            <>
              <p className="bia-dica">Ajuste os textos à vontade — muda na hora e não gasta geração.</p>
              <div className="bia-campos">
                <label>Loja<input className="bia-input" value={textos.loja ?? ''} onChange={e => mudarTexto('loja', e.target.value)} /></label>
                <label>Tema (letra cursiva)<input className="bia-input" value={textos.tema ?? ''} onChange={e => mudarTexto('tema', e.target.value)} /></label>
                <label>Título<input className="bia-input" value={textos.titulo ?? ''} onChange={e => mudarTexto('titulo', e.target.value)} /></label>
                <label>Etiqueta<input className="bia-input" value={textos.subtitulo ?? ''} onChange={e => mudarTexto('subtitulo', e.target.value)} /></label>
                <label>Preço antigo, riscado (R$)<input className="bia-input" type="number" step="0.01" min="0" placeholder="vazio = sem preço riscado" value={textos.preco_de || ''} onChange={e => mudarTexto('preco_de', e.target.value)} /></label>
                <label>Preço (R$)<input className="bia-input" type="number" step="0.01" min="0" value={textos.preco ?? ''} onChange={e => mudarTexto('preco', e.target.value)} /></label>
                <label>Botão<input className="bia-input" value={textos.cta ?? ''} onChange={e => mudarTexto('cta', e.target.value)} /></label>
              </div>
              <h3 className="bia-sub">Selo da promoção</h3>
              {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="bia-selo-linha">
                  <input className="bia-input" placeholder={`Linha ${i + 1}`} value={textos.selo?.[i]?.texto ?? ''}
                    onChange={e => mudarSelo(i, 'texto', e.target.value)} />
                  <select className="bia-input" value={textos.selo?.[i]?.estilo ?? 'pequeno'}
                    onChange={e => mudarSelo(i, 'estilo', e.target.value)}>
                    {ESTILOS_SELO.map(([v, r]) => <option key={v} value={v}>{r}</option>)}
                  </select>
                </div>
              ))}
              <div className="bia-acoes">
                <button type="button" className="btn btn-primary" disabled={salvando} onClick={salvar}>
                  {salvando ? 'Salvando…' : '✅ Salvar e publicar na Loja Online'}
                </button>
                <button type="button" className="btn btn-secondary" onClick={baixarAtual}>⬇️ Baixar imagem</button>
                <button type="button" className="btn btn-secondary" disabled={gerando || restantes === 0} onClick={gerar}>
                  🔄 Gerar outra cena
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ── biblioteca ── */}
      <section className="bia-card bia-biblioteca">
        <h2>Seus banners</h2>
        {!biblioteca.length && <p className="bia-vazio">Nenhum banner salvo ainda.</p>}
        <div className="bia-lista">
          {biblioteca.map(b => (
            <div key={b.id} className={`bia-item ${b.ativo ? '' : 'off'}`}>
              <img src={b.imagem_url} alt="" loading="lazy" />
              <div className="bia-item-info">
                <strong>{nomeProduto(b.produto_id) || 'Produto removido'}</strong>
                {b.promocao && <small>{b.promocao}</small>}
              </div>
              <div className="bia-item-acoes">
                <label className="bia-switch" title="Aparece no topo da Loja Online">
                  <input type="checkbox" checked={b.ativo} onChange={() => alternarAtivo(b)} />
                  <span>Na Loja Online</span>
                </label>
                <button type="button" className="btn btn-secondary" onClick={() => baixar(b.imagem_url, 'banner.jpg')}>⬇️</button>
                <button type="button" className="btn btn-danger" onClick={() => apagar(b)}>🗑️</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
