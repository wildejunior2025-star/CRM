import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import {
  serialSuportado, portaLembrada, escolherPorta, abrir, portaAberta, fechar,
  pesarEstavel, pedirPeso, escutarPeso, enviarPrecoKg, trocarVelocidade, infoPorta, VELOCIDADES,
} from '../lib/balancaToledo'

// ============================================================================
// PESAR NA BALANÇA — almoço no peso (23/10/2026)
//
// Fluxo do balcão, na ordem em que a vida acontece: o cliente chega com o
// prato QUENTE na mão. Perguntar a mesa antes trava a fila — então pesa
// primeiro, congela o valor, e só depois o atendente escolhe pra qual mesa vai.
//
// Fica numa tela PRÓPRIA, fora do fluxo de lançar na mesa. Não é preciosismo:
// o lançamento da mesa é a tela mais usada da loja e a que mais já quebrou
// (comanda gêmea, item em dobro). Mexer nela pra encaixar balança seria pagar
// um risco grande por uma tela que o balcão usa de um jeito completamente
// diferente.
//
// O peso é CONGELADO no momento da pesagem. Entre pesar e escolher a mesa o
// cliente já tirou o prato da balança — se a tela fosse ler de novo na hora de
// confirmar, lançaria zero.
// ============================================================================

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const kg = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })

export default function PesarNaBalanca({
  empresaId, mesas = [], comandaPorMesa = {}, userId,
  exigeCaixa = false, caixaAberto = true,
  onFechar, onLancou,
}) {
  const [produtos, setProdutos] = useState([])
  const [produto, setProduto] = useState(null)
  const [conectada, setConectada] = useState(!!portaAberta())
  const [baud, setBaud] = useState(() => Number(localStorage.getItem('balanca_baud')) || 9600)
  const [pesando, setPesando] = useState(false)
  const [peso, setPeso] = useState(null)      // { kg, total } — congelado
  const [erro, setErro] = useState(null)
  const [digitado, setDigitado] = useState('')  // peso digitado à mão, em gramas
  const [lancando, setLancando] = useState(false)
  const [ok, setOk] = useState(null)
  const buscaMesa = useRef(null)
  const [filtroMesa, setFiltroMesa] = useState('')

  // OS DE PREÇO FIXO MORAM NO MESMO BOTÃO (23/10/2026)
  //
  // No sistema que o Agv usava, os cinco pratos do self-service ficavam juntos
  // na mesma tela: três por quilo e dois de preço fechado. O atendente aprendeu
  // esse lugar. Separar “o que pesa” de “o que não pesa” em duas telas seria
  // organizar pela nossa lógica e desarrumar a dele.
  //
  // Quais são os de preço fixo que entram aqui? Os que moram na MESMA CATEGORIA
  // de algum produto por quilo. É automático e não pede marcação nova: quem
  // monta o cardápio já põe o combo de self-service junto do self-service.
  useEffect(() => {
    if (!empresaId) return
    supabase.from('produtos')
      .select('id, nome, preco_venda, categoria, vendido_por_peso')
      .eq('empresa_id', empresaId).eq('ativo', true)
      .order('preco_venda', { ascending: false })
      .then(({ data }) => {
        const todos = data ?? []
        const cats = new Set(todos.filter(p => p.vendido_por_peso).map(p => p.categoria))
        const lista = todos.filter(p => cats.has(p.categoria))
        setProdutos(lista)
        // Loja com um prato só, e por quilo: nem pergunta, abre direto no pesar.
        if (lista.length === 1 && lista[0].vendido_por_peso) setProduto(lista[0])
      })
  }, [empresaId])

  const porQuilo = produtos.filter(p => p.vendido_por_peso)
  const precoFixo = produtos.filter(p => !p.vendido_por_peso)

  // Escolher o prato. O de preço fechado já “vale” na hora: não tem o que pesar,
  // então pula direto pra mesa — um toque a menos numa fila de almoço.
  function escolher(p) {
    setProduto(p)
    setErro(null); setOk(null)
    if (p.vendido_por_peso) { setPeso(null); return }
    setPeso({ kg: null, total: Number(p.preco_venda) })
    setTimeout(() => buscaMesa.current?.focus(), 50)
  }

  // Porta já autorizada antes: reconecta sozinha, sem pedir nada.
  useEffect(() => {
    if (!serialSuportado() || portaAberta()) return
    portaLembrada().then(p => { if (p) abrir(p, baud).then(() => setConectada(true)).catch(() => {}) })
  }, [baud])

  async function conectar() {
    setErro(null)
    try {
      const p = await escolherPorta()
      await abrir(p, baud)
      setConectada(true)
    } catch (e) {
      setErro(e?.name === 'NotFoundError' ? 'Nenhuma porta escolhida.' : String(e?.message ?? e))
    }
  }

  // A VELOCIDADE A GENTE DESCOBRE, NÃO PERGUNTA (23/10/2026)
  //
  // A balança só responde na velocidade em que foi programada (parâmetro C15:
  // 2400, 4800 ou 9600). Na primeira versão eu punha um seletor e mandava o
  // lojista descobrir no teclado da balança — e a tela parou exatamente aí,
  // com “não respondeu, confira o C15”, que não ajuda ninguém no meio do
  // almoço. São três opções: testar as três leva menos tempo do que ler o
  // manual, e a que funcionou fica guardada.
  async function descobrirVelocidade() {
    for (const v of [baud, ...VELOCIDADES.filter(x => x !== baud)]) {
      try { await trocarVelocidade(v) } catch { continue }
      const r = await pedirPeso()
      if (r.estado !== 'sem_resposta' && r.estado !== 'ruido') {
        if (v !== baud) { setBaud(v); localStorage.setItem('balanca_baud', String(v)) }
        return v
      }
    }
    return null
  }

  async function pesar() {
    if (!produto) { setErro('Escolha o produto primeiro.'); return }
    setErro(null); setOk(null); setPesando(true)
    // Manda o preço do quilo antes: no Prt5 o visor da balança passa a mostrar
    // Preço/kg e Preço Total, que é o que o cliente está acostumado a ver.
    // Nos outros protocolos a balança ignora, e tudo bem — por isso o erro
    // daqui não interrompe a pesagem.
    try { await enviarPrecoKg(produto.preco_venda) } catch { /* protocolo sem preço */ }
    let r = await pesarEstavel()
    if (r.estado === 'sem_resposta') {
      setErro('Procurando a velocidade da balança…')
      const achou = await descobrirVelocidade()
      r = achou ? await pesarEstavel() : r
    }
    // Ainda mudo depois de varrer tudo? Pode ser uma balança no Prt2, que não
    // responde a pergunta nenhuma — ela só fala quando apertam "Imprimir".
    // Então para de perguntar e passa a ouvir.
    if (r.estado === 'sem_resposta') {
      setErro('Ela não responde a comando. Aperte “Imprimir” no teclado da balança — estou ouvindo.')
      r = await escutarPeso(25000)
    }
    setPesando(false)
    if (!r.ok) {
      setErro(r.estado === 'sem_resposta'
        ? 'A balança não falou de jeito nenhum. Confira se o cabo está neste computador e se a porta escolhida é a dela (botão “Trocar balança”).'
        : r.erro)
      return
    }
    setErro(null)
    setPeso({ kg: r.kg, total: Math.round(r.kg * Number(produto.preco_venda) * 100) / 100 })
    setTimeout(() => buscaMesa.current?.focus(), 50)
  }

  // PESO DIGITADO (24/10/2026): computador sem balança ligada. O atendente lê o
  // peso no visor da balança de outro lugar e digita as gramas; o valor sai da
  // mesma conta da pesagem. Sem vírgula = gramas (450 → 0,450 kg); com vírgula
  // ou ponto = quilos (0,45 / 1,2).
  function usarDigitado() {
    if (!produto) { setErro('Escolha o produto primeiro.'); return }
    const s = digitado.trim().replace(/\s/g, '')
    const n = /[.,]/.test(s) ? Number(s.replace(',', '.')) : Number(s) / 1000
    if (!(n > 0)) { setErro('Digite o peso em gramas. Ex.: 450'); return }
    if (n > 20) { setErro('Esse peso está alto demais pra um prato. Digite em gramas (ex.: 450).'); return }
    const quilos = Math.round(n * 1000) / 1000
    setErro(null); setOk(null)
    setPeso({ kg: quilos, total: Math.round(quilos * Number(produto.preco_venda) * 100) / 100, digitado: true })
    setDigitado('')
    setTimeout(() => buscaMesa.current?.focus(), 50)
  }

  // Porta errada é tão provável quanto velocidade errada: este computador pode
  // ter outro aparelho serial autorizado antes (a catraca da academia roda no
  // mesmo endereço), e a Web Serial entrega a primeira da lista sem dizer qual é.
  async function trocarBalanca() {
    setErro(null); setPeso(null)
    try {
      await fechar()
      const p = await escolherPorta()
      await abrir(p, baud)
      setConectada(true)
    } catch (e) {
      setConectada(false)
      setErro(e?.name === 'NotFoundError' ? 'Nenhuma porta escolhida.' : String(e?.message ?? e))
    }
  }

  async function lancar(mesa) {
    if (!peso || lancando) return
    if (exigeCaixa && !caixaAberto) { setErro('Abra o caixa primeiro pra lançar na mesa.'); return }
    setLancando(true); setErro(null)

    // Mesa sem comanda aberta: abre agora. O 23505 é a trava do banco contra
    // comanda gêmea (mig 0244) — se bateu, é porque alguém abriu no mesmo
    // segundo, e seguir em frente é o certo.
    let comandaId = comandaPorMesa[mesa.id]?.id ?? null
    if (!comandaId) {
      const { error: errAbrir } = await supabase.from('comandas').insert({
        empresa_id: empresaId, mesa_id: mesa.id, numero_mesa: mesa.numero, garcom_id: userId ?? null,
      })
      if (errAbrir && errAbrir.code !== '23505') {
        setLancando(false); setErro('Não consegui abrir a mesa: ' + errAbrir.message); return
      }
      await supabase.from('mesas').update({ status: 'ocupada' }).eq('id', mesa.id)
      // 'aberta' e o vocabulario que o resto do sistema usa pra comanda viva
      // (a coluna de fechamento chama fechada_at, nao fechada_em - escrevi o
      // nome errado e a consulta voltava vazia, dando "nao achei a comanda
      // dessa mesa" com a mesa aberta na frente, no teste do Agv 23/10/2026).
      const { data: nova, error: errLer } = await supabase.from('comandas')
        .select('id').eq('empresa_id', empresaId).eq('mesa_id', mesa.id).eq('status', 'aberta')
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (errLer) { setLancando(false); setErro('Nao consegui ler a comanda: ' + errLer.message); return }
      comandaId = nova?.id ?? null
    }
    if (!comandaId) { setLancando(false); setErro('Não achei a comanda dessa mesa.'); return }

    // `quantidade` é o PESO e `preco_unitario` é o preço do QUILO: a conta da
    // comanda (preço × quantidade) já dá o valor certo sem caso especial.
    // Nasce ENTREGUE porque o prato já está na mão do cliente — não existe
    // cozinha pra esperar, e um item "preparando" pendurado faria a comanda
    // pedir um "marcar pronto" que ninguém vai apertar.
    // Por quilo: a quantidade é o PESO e o preço é o do quilo. Preço fechado:
    // uma unidade pelo preço dele, igual a qualquer item da mesa.
    const porPeso = peso.kg != null
    const { error } = await supabase.from('comanda_itens').insert({
      empresa_id: empresaId, comanda_id: comandaId, produto_id: produto.id,
      nome: produto.nome, preco_unitario: produto.preco_venda,
      quantidade: porPeso ? peso.kg : 1,
      status: 'entregue', lancado_por: userId ?? null,
      observacao: porPeso ? `${kg(peso.kg)} kg × ${brl(produto.preco_venda)}/kg${peso.digitado ? ' (peso digitado)' : ''}` : null,
    })
    setLancando(false)
    if (error) { setErro('Não consegui lançar: ' + error.message); return }

    setOk(peso.kg != null
      ? `Mesa ${mesa.numero}: ${kg(peso.kg)} kg — ${brl(peso.total)}`
      : `Mesa ${mesa.numero}: ${produto.nome} — ${brl(peso.total)}`)
    setPeso(null)
    // Preço fechado volta pra escolha: o próximo da fila pode querer outro.
    if (peso.kg == null) setProduto(null)
    setFiltroMesa('')
    onLancou?.()
  }

  // Sem leitura de balança (celular, iPad, outro navegador) a tela continua
  // servindo: dá pra digitar o peso. Só não existe o botão de pesar.
  const suportado = serialSuportado()

  const mesasFiltradas = filtroMesa.trim()
    ? mesas.filter(m => String(m.numero).includes(filtroMesa.trim()))
    : mesas

  return (
    <Moldura onFechar={onFechar}>
      {ok && (
        <div style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 12, fontWeight: 700,
          background: 'rgba(22,163,74,.12)', color: '#16a34a' }}>✅ {ok}</div>
      )}
      {erro && (
        <div style={{ padding: '10px 12px', borderRadius: 8, marginBottom: 12, fontWeight: 600,
          background: 'rgba(220,38,38,.12)', color: '#dc2626' }}>{erro}</div>
      )}

      {!suportado && (
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          Este aparelho não lê balança (isso só funciona no <strong>Chrome do computador</strong>).
          Escolha o prato e <strong>digite o peso</strong>.
        </p>
      )}

      {suportado && !conectada && (
        <div style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 14, margin: '0 0 8px' }}>
            A balança precisa ser escolhida uma vez neste computador. Depois o Chrome lembra.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={conectar} style={botao('#2563eb')}>Conectar a balança</button>
            <label style={{ fontSize: 13 }}>
              Velocidade (C15 da balança):{' '}
              <select
                value={baud}
                onChange={e => { setBaud(Number(e.target.value)); localStorage.setItem('balanca_baud', e.target.value) }}
                style={{ padding: '6px 8px', borderRadius: 6 }}
              >
                {VELOCIDADES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}

      {/* Qual porta e qual velocidade estao em uso. Sem isto, balanca muda nao
          tinha conserto pela tela: o Chrome entrega a primeira porta
          autorizada e o atendente nao tinha como dizer "essa nao e a minha". */}
      {suportado && conectada && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          <span>Balança: <strong>{infoPorta()}</strong> · {baud} bauds</span>
          <button type="button" onClick={trocarBalanca}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--primary, #7c3aed)', fontWeight: 700, fontSize: 12 }}>
            Trocar balança
          </button>
        </div>
      )}

      {/* 1. Qual prato. Os dois grupos juntos, como na tela que ele ja usava. */}
      {produtos.length !== 1 && (
        <div style={{ marginBottom: 16 }}>
          {produtos.length === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              Nenhum produto marcado como “vendido por quilo”. Marque em Catálogo → Produtos.
            </p>
          )}

          {porQuilo.length > 0 && (
            <>
              <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700 }}>Vendido por quilo</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
                {porQuilo.map(p => (
                  <button key={p.id} type="button" onClick={() => escolher(p)}
                    style={{
                      ...botao(produto?.id === p.id ? '#16a34a' : 'transparent'),
                      color: produto?.id === p.id ? '#fff' : 'var(--text)',
                      border: '1.5px solid ' + (produto?.id === p.id ? '#16a34a' : 'var(--border)'),
                    }}>
                    {p.nome} — {brl(p.preco_venda)}/kg
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Preço fechado: um toque e já vai pra mesa, sem passar pela balança. */}
          {precoFixo.length > 0 && (
            <>
              <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700 }}>Preço fechado — não pesa</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {precoFixo.map(p => (
                  <button key={p.id} type="button" onClick={() => escolher(p)}
                    style={{
                      ...botao(produto?.id === p.id ? '#2563eb' : 'transparent'),
                      color: produto?.id === p.id ? '#fff' : 'var(--text)',
                      border: '1.5px solid ' + (produto?.id === p.id ? '#2563eb' : 'var(--border)'),
                    }}>
                    {p.nome} — {brl(p.preco_venda)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* 2. Pesar — só pra quem é vendido por quilo. Dois jeitos lado a lado:
          ler da balança, ou digitar o peso (computador sem balança ligada). */}
      {!peso && produto?.vendido_por_peso !== false && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start',
          justifyContent: 'center', padding: '18px 0' }}>
          <div style={{ flex: '1 1 220px', textAlign: 'center' }}>
            <button type="button" onClick={pesar} disabled={!conectada || !produto || pesando}
              style={{ ...botao('#16a34a'), fontSize: 20, padding: '18px 24px', width: '100%',
                opacity: (!conectada || !produto || pesando) ? 0.5 : 1 }}>
              {pesando ? 'Lendo a balança…' : '⚖️ Pesar o prato'}
            </button>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>
              Coloque o prato na balança e toque aqui. Eu espero o peso parar sozinho.
            </p>
          </div>

          <div style={{ flex: '1 1 220px', textAlign: 'center' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={digitado}
                onChange={e => setDigitado(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); usarDigitado() } }}
                inputMode="numeric"
                placeholder="Peso em gramas"
                disabled={!produto}
                style={{ flex: 1, minWidth: 0, padding: '16px 12px', borderRadius: 10, fontSize: 20, fontWeight: 700,
                  textAlign: 'center', border: '1.5px solid var(--border)', color: 'var(--text)',
                  background: 'var(--input-bg, transparent)', opacity: produto ? 1 : 0.5 }}
              />
              <button type="button" onClick={usarDigitado} disabled={!produto || !digitado.trim()}
                style={{ ...botao('#2563eb'), fontSize: 18, padding: '0 18px',
                  opacity: (!produto || !digitado.trim()) ? 0.5 : 1 }}>
                OK
              </button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>
              Sem balança ligada? Digite as gramas (ex.: <strong>450</strong>) e aperte Enter.
            </p>
          </div>
        </div>
      )}

      {/* 3. Peso congelado + escolher a mesa */}
      {peso && (
        <div>
          <div style={{ textAlign: 'center', padding: '12px 0 16px' }}>
            {peso.kg != null && (
              <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.1 }}>{kg(peso.kg)} kg</div>
            )}
            <div style={{ fontSize: peso.kg != null ? 30 : 40, fontWeight: 800, color: '#16a34a' }}>{brl(peso.total)}</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
              {produto?.nome}{peso.kg != null ? ` · ${brl(produto?.preco_venda)}/kg` : ' · preço fechado'}
            </div>
            <button type="button" onClick={() => { setPeso(null); setErro(null); if (peso.kg == null) setProduto(null) }}
              style={{ ...botao('transparent'), border: '1px solid var(--border)', color: 'var(--text)', marginTop: 10 }}>
              {peso.kg != null ? 'Pesar de novo' : 'Trocar o prato'}
            </button>
          </div>

          <p style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700 }}>Para qual mesa?</p>
          <input
            ref={buscaMesa} value={filtroMesa} onChange={e => setFiltroMesa(e.target.value)}
            inputMode="numeric" placeholder="Digite o número da mesa"
            style={{ width: '100%', padding: '12px 14px', borderRadius: 10, fontSize: 18, marginBottom: 10,
              border: '1px solid var(--border)', background: 'var(--input-bg, transparent)', color: 'var(--text)' }}
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8,
            maxHeight: 280, overflowY: 'auto' }}>
            {mesasFiltradas.map(m => {
              const ocupada = !!comandaPorMesa[m.id]
              return (
                <button key={m.id} type="button" disabled={lancando} onClick={() => lancar(m)}
                  style={{
                    padding: '14px 6px', borderRadius: 10, cursor: 'pointer', fontWeight: 800, fontSize: 17,
                    border: '1.5px solid ' + (ocupada ? '#f59e0b' : 'var(--border)'),
                    background: ocupada ? 'rgba(245,158,11,.12)' : 'transparent', color: 'var(--text)',
                  }}>
                  {m.numero}
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)' }}>
                    {ocupada ? 'ocupada' : 'livre'}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </Moldura>
  )
}

const botao = (bg) => ({
  padding: '10px 18px', borderRadius: 10, border: 'none', background: bg, color: '#fff',
  fontWeight: 700, fontSize: 15, cursor: 'pointer',
})

function Moldura({ children, onFechar }) {
  return (
    <div
      onClick={onFechar}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--card, #fff)', color: 'var(--text)', borderRadius: 14, padding: 20,
          width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 18 }}>⚖️ Lançar produto no peso</h3>
          <button type="button" onClick={onFechar}
            style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 22, color: 'var(--text-muted)' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
