import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, fetchAll } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { adicionalComplementos } from '../lib/complementos'
import { rotuloComanda } from '../lib/comanda'
import { calcularTaxa, itemIsento, MARCA_ISENTO } from '../lib/taxaServico'
import AvisoPix from '../components/AvisoPix'
import { useConfirmar } from '../hooks/useConfirmar'
import { clienteComMesmoNome } from '../lib/clientes'
import ClientePicker from '../components/ClientePicker'
import ClientesFiado from './ClientesFiado'
import ConsumoFuncionario from '../components/ConsumoFuncionario'
import { imprimirHtml, montarContaPresencialHtml, appFwcDisponivel } from '../utils/imprimirCupom'
import '../components/Page.css'
import './PresencialSalao.css'

// Crédito e débito são formas separadas porque a maquineta cobra taxa diferente
// em cada uma — é assim que o Caixa mostra quanto cai na conta de verdade.
const FORMAS = [
  { id: 'dinheiro', label: 'Dinheiro' },
  { id: 'pix',      label: 'PIX' },
  { id: 'credito',  label: 'Crédito' },
  { id: 'debito',   label: 'Débito' },
  // Fiado não gera linha em `pagamentos`: a dívida é a venda sem pagamento
  // (view clientes_saldo_fiado). Por isso exige cliente — ver 0114_fiado_mesa.sql.
  { id: 'fiado',    label: 'Fiado' },
]

// O crédito da loja (mig 0179) NÃO entra aqui de propósito. Ele nasceu como
// forma de pagamento e estava errado por dois motivos: ficava um segundo botão
// "Crédito" ao lado do cartão de crédito — indistinguíveis —, e obrigava o
// garçom a fazer conta de cabeça (conta 3,60, crédito 1,95, lança 1,65 na
// outra forma). Na prática o cliente SEMPRE paga a diferença em dinheiro, PIX
// ou cartão. Então virou uma caixinha de abatimento: marca, o total cai, e ele
// escolhe uma forma só pro que sobrou.

const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

// Sirene da comanda que chegou pelo link e ninguém viu (mig 0182).
//
// Toca em looping, de propósito: um bipe único no meio do movimento do balcão
// não é ouvido, e o pedido fica parado com o cliente esperando na frente. Para
// sozinha no instante em que alguém abre a comanda.
//
// O navegador só deixa tocar depois de um gesto do usuário — como o atendente
// clica o tempo todo nessa tela, na prática já está destravado.
let _ctxSalao = null
function tocarSirene() {
  try {
    if (!_ctxSalao) _ctxSalao = new (window.AudioContext || window.webkitAudioContext)()
    const ctx = _ctxSalao
    if (ctx.state === 'suspended') ctx.resume()
    // Dois tons alternados: chama mais atenção que um bipe só, e não se
    // confunde com o som de "pedido pronto" da cozinha.
    ;[[880, 0], [1174, 0.22]].forEach(([hz, atraso]) => {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.connect(g); g.connect(ctx.destination)
      o.type = 'square'
      o.frequency.setValueAtTime(hz, ctx.currentTime + atraso)
      g.gain.setValueAtTime(0.22, ctx.currentTime + atraso)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + atraso + 0.18)
      o.start(ctx.currentTime + atraso)
      o.stop(ctx.currentTime + atraso + 0.18)
    })
  } catch { /* sem áudio: o piscar já avisa */ }
}

// Tira acento e deixa minúsculo: assim "agua" acha "Água", "cafe" acha "Café" etc.
const semAcento = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

// Máscara de dinheiro estilo maquininha: digita só os números e os 2 últimos viram
// os centavos (a vírgula entra sozinha). "1250" -> "12,50"; "5" -> "0,05".
const soDigitos = (s) => String(s ?? '').replace(/\D/g, '')
const maskMoeda = (s) => (Number(soDigitos(s)) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const valorMoeda = (s) => Number(soDigitos(s)) / 100                 // string mascarada -> número
const numeroParaMoeda = (n) => maskMoeda(String(Math.round(Number(n || 0) * 100))) // número -> "12,50"

// Logo do WhatsApp. É SVG e não emoji porque emoji de zap não existe — o 📲 que
// estava ali antes é "celular com seta" e ninguém lia como WhatsApp. Herda a cor
// do botão (currentColor), então serve em qualquer tema.
function IconeZap() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
    </svg>
  )
}

export default function PresencialSalao() {
  const { profile, user } = useAuth()
  const empresaId = profile?.empresa_id
  // Só o ADM confere o pagamento e libera a mesa. Garçom fecha, mas não libera.
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'

  // Começa em 0, NUNCA em 10: chutar 10% enquanto a config da loja não chegou já
  // colocou taxa de serviço numa loja que cobra 0% e travou a mesa na hora de
  // liberar (mig 0144). Sem valor carregado, o certo é não cobrar nada.
  const [taxaPct, setTaxaPct] = useState(0)
  const [empresaNome, setEmpresaNome] = useState('')
  // Presencial sem obrigatórios (mig 0121): no salão e no QR da mesa o atendente
  // monta o prato junto com o cliente, então exigir os grupos só atrasa. Vale
  // aqui e no cardápio da mesa — a Loja Online e a Nova venda seguem exigindo.
  const [semObrigatorios, setSemObrigatorios] = useState(false)
  const [semCozinha, setSemCozinha] = useState(false)
  const [avisoImpressao, setAvisoImpressao] = useState(null) // remessa que nao saiu no papel
  const [reimprimindo, setReimprimindo] = useState(false)
  const [reimpAberto, setReimpAberto] = useState(false)   // escolher o que reimprimir
  const [reimpSel, setReimpSel] = useState(() => new Set())
  const [salvandoCoz, setSalvandoCoz] = useState(false)
  const [salvandoObrig, setSalvandoObrig] = useState(false)
  const [mesas, setMesas]     = useState([])
  const [comandas, setComandas] = useState([])
  // Comanda de balcão (mig 0143): comanda numerada que não é de mesa nenhuma —
  // pro cliente que pede em pé no balcão. Número zera todo dia. Ligado por loja.
  const [comandaBalcaoAtiva, setComandaBalcaoAtiva] = useState(false)
  const [abrindoComanda, setAbrindoComanda] = useState(false)
  const [produtos, setProdutos] = useState([])
  const [garcons, setGarcons] = useState({})   // { profile_id: nome }
  const [loading, setLoading] = useState(true)

  const [mesaSel, setMesaSel] = useState(null)   // mesa aberta no drawer
  const [destaque, setDestaque] = useState(0)   // produto marcado pelas setas
  const [qtdEdit, setQtdEdit] = useState({})    // quantidade sendo digitada, por item
  const listaProdRef = useRef(null)
  const [separando, setSeparando] = useState(false)   // drawer de separar a conta
  // Map id do item -> QUANTAS unidades daquela linha vão com ela. Era um Set
  // (item inteiro ou nada), mas "6 devassas, ele leva 3" não tinha como marcar.
  const [sepSel, setSepSel] = useState(() => new Map())
  const [sepNome, setSepNome] = useState('')
  const [sepErro, setSepErro] = useState('')
  const [sepBusy, setSepBusy] = useState(false)
  const [abrirComandaId, setAbrirComandaId] = useState(null) // comanda pra abrir assim que aparecer
  const [movendo, setMovendo] = useState(false)  // drawer de trocar de mesa
  const [moverNome, setMoverNome] = useState('')
  const [moverErro, setMoverErro] = useState('')
  const [moverBusy, setMoverBusy] = useState(false)
  const [busca, setBusca]     = useState('')
  const [categoriaSel, setCategoriaSel] = useState(null) // categoria aberta no menu de adicionar item
  // Mora AQUI, e não junto do useRef lá em cima: a lista de dependências é lida
  // durante o render, então um efeito que cita `busca` antes do useState dela
  // derruba a tela inteira com "Cannot access before initialization".
  useEffect(() => { setDestaque(0) }, [busca, categoriaSel])
  const [fechando, setFechando] = useState(false) // modal de fechamento
  const [forma, setForma]     = useState('dinheiro')
  const [aplicarTaxa, setAplicarTaxa] = useState(true)
  const [salvando, setSalvando] = useState(false)
  const [precoEdit, setPrecoEdit] = useState({})  // preço em edição por item (só admin)
  // Preço em edição no rascunho, por linha. Existe pra comida no peso: o atendente
  // pesa o prato e digita o valor ANTES de mandar pra cozinha (antes só dava depois).
  const [precoRascEdit, setPrecoRascEdit] = useState({})
  // Celular: a mesa mostra UMA coisa de cada vez — a comanda ou o cardápio.
  // No PC (1100px+) as duas colunas convivem e isto não muda nada.
  const [abaMesa, setAbaMesa] = useState('comanda')  // 'comanda' | 'add'
  const [modoPag, setModoPag] = useState('unico')   // 'unico' | 'dividir'
  // PIX online da mesa (mig 0193): a loja com Mercado Pago conectado cobra o QR
  // na tela e quem fecha a conta é o MP, quando o dinheiro cai.
  const [mpConectado, setMpConectado] = useState(false)
  // Os PIX esperando pagamento, de TODAS as mesas. É isto que deixa o garçom
  // gerar o QR, mostrar e ir embora atender outra mesa: a cobrança não vive numa
  // tela aberta, vive na mesa.
  const [pixPendentes, setPixPendentes] = useState([])   // [{ id, comanda_id, valor, qr_code, qr_base64 }]
  const [pixAmpliado, setPixAmpliado] = useState(null)   // QR em tela cheia pra mostrar pro cliente
  const [pixMsg, setPixMsg] = useState('')
  const [pixGerando, setPixGerando] = useState(false)
  // O aviso de "caiu o PIX". Era alert() do navegador — no celular, colado no
  // topo e com o valor perdido no meio da frase.
  const [avisoPix, setAvisoPix] = useState(null)  // { tipo, valor, texto }
  const [confirmar, avisoConfirmar] = useConfirmar()
  // [{ forma, valor(string), cliente }] no modo dividir. `cliente` só vale nas linhas
  // de fiado: cada pedaço fiado tem o SEU devedor (mig 0141) — é o que separa a
  // dívida da Maria da do João quando os dois racham a mesma mesa.
  const [pagamentos, setPagamentos] = useState([])
  const [pickerFiadoIdx, setPickerFiadoIdx] = useState(null) // linha escolhendo o devedor
  // Fiado: quem fica devendo. Obrigatório quando alguma linha do pagamento é fiado.
  const [clientes, setClientes] = useState([])
  const [clienteSel, setClienteSel] = useState(null)  // { id, nome }

  // Crédito da loja do cliente ligado à comanda (mig 0179). Zero quando a loja
  // não ligou o programa ou não há cliente — e é isso que esconde a forma de
  // pagamento "Crédito" das lojas que não usam.
  const [cashbackSaldo, setCashbackSaldo] = useState(0)
  const [usarCashbackConta, setUsarCashbackConta] = useState(false)
  const [buscaCliente, setBuscaCliente] = useState('')
  const [novoCliente, setNovoCliente] = useState(false)
  const [novoTelefone, setNovoTelefone] = useState('') // opcional no cadastro do fiado (o nome é que não repete)
  const [preContaMsg, setPreContaMsg] = useState('')   // aviso depois de mandar a pré-conta pra impressora
  const [confirmarCancelar, setConfirmarCancelar] = useState(false)
  const [cancelando, setCancelando] = useState(false)
  const [enviandoZap, setEnviandoZap] = useState(false) // pré-conta indo pro WhatsApp do cliente
  const [salvandoCliente, setSalvandoCliente] = useState(false)
  // Rascunho: itens que o garçom monta mas que só vão pra cozinha (e pra impressora)
  // quando ele clica "Enviar" — assim o pedido inteiro sai numa impressão só.
  const [rascunho, setRascunho] = useState([]) // [{ produto_id, nome, preco_venda, quantidade }]
  const [enviando, setEnviando] = useState(false)
  // Recado desta remessa (ex.: "sem cebola em tudo"). Vai colado na observação de CADA
  // item enviado: a observação do item é o único campo que a impressora da cozinha
  // imprime grande dentro do bloco do pedido.
  const [obsEnvio, setObsEnvio] = useState('')
  const [salvandoViagem, setSalvandoViagem] = useState(false)
  const buscaRef = useRef(null) // pra focar de volta o campo de busca ao limpar (X)
  // "Inventar produto": criar item na hora (só nesta venda) ou salvar no catálogo.
  const [invAberto, setInvAberto] = useState(false)
  const [invNome, setInvNome] = useState('')
  const [invPreco, setInvPreco] = useState('')
  const [invCatalogo, setInvCatalogo] = useState(false)
  const [invCategoria, setInvCategoria] = useState('')
  const [invSalvando, setInvSalvando] = useState(false)
  // Categoria vira lista de ESCOLHER: o <datalist> não abre no iPhone (o Safari
  // mostra no máximo uma barrinha em cima do teclado) e no Android virava uma
  // lista deslizando pro lado. O <select> abre a roda nativa nos dois.
  const [invCatNova, setInvCatNova] = useState(false)
  const [ordemCat, setOrdemCat] = useState({}) // { nomeCategoria(minusculo): ordem } — mesma ordem do catálogo
  const [caixaAberto, setCaixaAberto] = useState(false) // só lança na mesa com o caixa aberto
  // Complementos: { produto_id: [{ id, nome, min, max, opcoes:[{id,nome,preco_adicional}] }] }
  // Mesma fonte do cardápio do QR (MesaCardapio) — produto com grupo abre o modal de montagem.
  const [compMap, setCompMap] = useState({})
  const [montando, setMontando] = useState(null) // produto que está sendo montado no modal
  const [pickerCliente, setPickerCliente] = useState(false)
  const [verMovimentos, setVerMovimentos] = useState(false)  // trilha da mesa aberta (ADM) // modal "ligar cliente à mesa"
  const [ligandoCliente, setLigandoCliente] = useState(false)
  const [showFiado, setShowFiado] = useState(false) // modal "quem está devendo fiado"
  const [showConsumoFunc, setShowConsumoFunc] = useState(false) // modal "consumo de funcionários"
  // PIX de fiado que o cliente pagou sozinho pelo link dele (mig 0149). A baixa já
  // foi dada pelo webhook — isto aqui é só o aviso pra equipe ficar sabendo.
  const [pixRecebidos, setPixRecebidos] = useState([])
  const [pixVistos, setPixVistos] = useState(() => new Set())

  // ── Duas cargas, não uma ────────────────────────────────────────────────
  // Antes era um `loadAll` só, com NOVE consultas — cardápio, complementos de
  // todos os produtos, mil clientes, funcionários, categorias — e ele rodava
  // inteiro a cada ação e a cada aviso do tempo real. Fechar e abrir a mesa
  // recarregava o cardápio da loja de novo; no celular do garçom isso é uma
  // eternidade de espera por nada (Wilde, 23/08/2026).
  //
  // O cardápio não muda enquanto o garçom atende: carrega uma vez. O que muda a
  // toda hora é mesa e comanda — só isso volta ao banco.

  // A MESA QUE VOLTAVA A FICAR AZUL SOZINHA (Saidera, 06/09/2026).
  //
  // Cada aviso do tempo real dispara uma releitura. Numa noite cheia chegam
  // vários avisos juntos e duas leituras correm ao mesmo tempo: a que SAIU
  // ANTES pode CHEGAR DEPOIS e repintar a tela com o estado velho. A mesa que
  // a dona acabou de liberar reaparecia em "aguardando ADM" — azul de novo,
  // sem ninguém tocar nela. Com muitas mesas acontecia mais, porque a consulta
  // demora mais e a janela fica maior.
  //
  // Duas travas: a leitura só pinta a tela se for a MAIS NOVA, e nunca pinta
  // por cima de um fechamento que aconteceu enquanto ela estava no ar.
  const cargaSeq = useRef(0)
  const escritaEm = useRef(0)

  // Muda o tempo todo: mesas, comandas e o caixa deste usuário.
  const loadMesas = useCallback(async () => {
    if (!empresaId) return
    const minhaVez = ++cargaSeq.current
    const comecouEm = Date.now()
    const [ms, cs, cx, px] = await Promise.all([
      supabase.from('mesas').select('*').eq('empresa_id', empresaId).eq('ativa', true).order('numero'),
      supabase.from('comandas').select('*, comanda_itens(*), cliente:clientes(id, nome, telefone)').eq('empresa_id', empresaId).in('status', ['aberta', 'aguardando_conferencia']),
      supabase.from('caixas').select('id').eq('empresa_id', empresaId).eq('aberto_por', user?.id).eq('status', 'aberto').limit(1),
      // Pagos entram junto: numa conta rachada, a parte que ja caiu tem que
      // aparecer pro atendente ("PIX 1 pago, falta o outro") -- senao ele nao
      // sabe o que ainda tem pra receber.
      supabase.from('comanda_pix_cobrancas')
        .select('id, comanda_id, valor, qr_code, qr_base64, expira_em, status, parte')
        .eq('empresa_id', empresaId).in('status', ['pendente', 'pago']),
    ])
    // Sai do "Carregando salão..." mesmo quando a leitura for descartada abaixo:
    // a tela não pode ficar pendurada porque duas releituras se cruzaram.
    setLoading(false)
    // Chegou velha (outra leitura saiu depois desta) ou uma conta foi fechada
    // enquanto ela vinha: joga fora. Quem manda é a leitura mais nova.
    if (minhaVez !== cargaSeq.current || escritaEm.current > comecouEm) return
    setMesas(ms.data ?? [])
    setComandas(cs.data ?? [])
    setCaixaAberto(!!(cx.data && cx.data.length))
    // Só o que é de mesa AINDA ABERTA. Sem este filtro, a cobrança paga de uma
    // mesa já fechada ficava na lista pra sempre e o Salão anunciava "PIX
    // recebido!" de 15 em 15 segundos, pra um pagamento de uma hora atrás.
    const abertas = new Set((cs.data ?? []).map(c => c.id))
    setPixPendentes((px.data ?? []).filter(x => abertas.has(x.comanda_id)))
    setLoading(false)
  }, [empresaId, user?.id])

  // Quase nunca muda: cardápio, complementos, categorias, funcionários, clientes.
  const loadCatalogo = useCallback(async () => {
    if (!empresaId) return
    const [emp, mp, ps, gs, cat, cg, cl] = await Promise.all([
      supabase.from('empresas').select('taxa_servico_pct, nome, presencial_sem_obrigatorios, presencial_sem_cozinha, comanda_balcao_ativa').eq('id', empresaId).single(),
      // Pergunta "tem MP ligado?" pela funcao, e nao pela tabela: mercadopago_contas
      // guarda o token da loja e nao e (nem deve ser) legivel pelo navegador (mig 0194).
      supabase.rpc('mp_conectado_loja'),
      // Deposito tem milhares de itens: sem paginar o cardapio do salao parava nos
      // primeiros 500 nomes em ordem alfabetica e o resto sumia da tela.
      fetchAll(() => supabase.from('estoque_catalogo').select('produto_id, nome, preco_venda, categoria').eq('empresa_id', empresaId).order('nome')),
      supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
      supabase.from('categorias').select('nome, ordem').eq('empresa_id', empresaId),
      // Complementos por produto. A tabela de vínculo não tem empresa_id e é lida por
      // todos (policy le_publico_pcg), então o "!inner" é o que garante a separação:
      // vira INNER JOIN com complemento_grupos, que a RLS já filtra por empresa — os
      // vínculos de outras lojas não chegam nem a sair do banco.
      supabase.from('produto_complemento_grupos')
        .select('produto_id, ordem, min_override, max_override, complemento_grupos!inner(id, nome, min, max, disponivel, regra_preco, modo_quantidade, complemento_opcoes(id, nome, preco_adicional, ordem, disponivel))'),
      // Clientes: usados só no fiado (quem fica devendo).
      supabase.from('clientes').select('id, nome, telefone').eq('empresa_id', empresaId).order('nome').limit(1000),
    ])
    if (emp.data) {
      setTaxaPct(Number(emp.data.taxa_servico_pct ?? 0))
      setEmpresaNome(emp.data.nome || '')
      setSemObrigatorios(!!emp.data.presencial_sem_obrigatorios)
      setSemCozinha(!!emp.data.presencial_sem_cozinha)
      setComandaBalcaoAtiva(!!emp.data.comanda_balcao_ativa)
    }
    // Só quem conectou o Mercado Pago vê o botão de PIX online (mig 0193).
    setMpConectado(mp.data === true)
    setProdutos(ps.data ?? [])
    setGarcons(Object.fromEntries((gs.data ?? []).map(p => [p.id, p.nome])))
    const om = {}
    for (const c of (cat.data ?? [])) if (c?.nome != null) om[String(c.nome).trim().toLowerCase()] = c.ordem == null ? 9999 : c.ordem
    setOrdemCat(om)
    // Monta { produto_id: [grupos] }, pulando grupo/opção pausados. min/max do vínculo
    // (override) mandam mais que os do grupo, igual no cardápio do QR.
    const cm = {}
    for (const v of (cg.data ?? [])) {
      const g = v.complemento_grupos
      if (!g || g.disponivel === false) continue
      const opcoes = (g.complemento_opcoes ?? [])
        .filter(o => o.disponivel !== false)
        .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0))
      if (!opcoes.length) continue
      ;(cm[v.produto_id] ??= []).push({
        id: g.id, nome: g.nome,
        min: v.min_override ?? g.min ?? 0,
        max: v.max_override ?? g.max ?? 1,
        regra_preco: g.regra_preco ?? 'somar',
        // Atacado (mig 0200): o cliente diz QUANTO de cada sabor e o teto do
        // grupo não vale — o sentido do modo é justamente não ter limite.
        modo_quantidade: g.modo_quantidade === true,
        opcoes,
      })
    }
    setCompMap(cm)
    // "Consumidor (Mesa)" é o cliente genérico que a função usa nas mesas pagas —
    // não faz sentido oferecer como devedor no fiado.
    setClientes((cl.data ?? []).filter(c => c.nome !== 'Consumidor (Mesa)'))
  }, [empresaId])

  // Mantido pro punhado de lugares que precisam dos dois (ex.: acabou de inventar
  // um produto e ele tem que aparecer na busca).
  const loadAll = useCallback(async () => {
    await Promise.all([loadMesas(), loadCatalogo()])
  }, [loadMesas, loadCatalogo])

  // O tempo real avisa UM POR UM: um envio de 6 itens vira 6 avisos, e antes
  // eram 6 recargas completas em cima da outra. Junta os avisos que chegam
  // colados e recarrega uma vez só.
  const recargaTimer = useRef(null)
  const loadMesasEmBreve = useCallback(() => {
    clearTimeout(recargaTimer.current)
    recargaTimer.current = setTimeout(loadMesas, 350)
  }, [loadMesas])

  useEffect(() => { loadCatalogo() }, [loadCatalogo])
  useEffect(() => { loadMesas() }, [loadMesas])

  // Avisa quando cai um PIX de fiado pago pelo link do cliente (últimos 30 min).
  useEffect(() => {
    if (!empresaId) return
    let vivo = true
    async function checarPix() {
      const desde = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const { data } = await supabase.from('cliente_pix_cobrancas')
        .select('id, valor, pago_em, clientes(nome)')
        .eq('empresa_id', empresaId).eq('status', 'pago').gte('pago_em', desde)
        .order('pago_em', { ascending: false })
      if (vivo) setPixRecebidos(data ?? [])
    }
    checarPix()
    const t = setInterval(checarPix, 20000)
    return () => { vivo = false; clearInterval(t) }
  }, [empresaId])

  // Realtime: atualiza quando outro garçom mexe nas comandas
  useEffect(() => {
    if (!empresaId) return
    const ch = supabase.channel(`salao_${empresaId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comandas', filter: `empresa_id=eq.${empresaId}` }, loadMesasEmBreve)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_itens', filter: `empresa_id=eq.${empresaId}` }, loadMesasEmBreve)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'mesas', filter: `empresa_id=eq.${empresaId}` }, loadMesasEmBreve)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'comanda_pix_cobrancas', filter: `empresa_id=eq.${empresaId}` }, loadMesasEmBreve)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [empresaId])  // eslint-disable-line react-hooks/exhaustive-deps

  // O caixa costuma ser aberto em OUTRA aba (ou noutra janela do /caixa). Como o
  // loadAll só roda ao montar a tela, o Salão ficava dizendo "caixa fechado" até
  // alguém dar F5. Aqui ele reconfere sozinho toda vez que a aba volta pra frente.
  useEffect(() => {
    if (!empresaId || !user?.id) return
    let vivo = true
    async function checarCaixa() {
      const { data } = await supabase.from('caixas').select('id')
        .eq('empresa_id', empresaId).eq('aberto_por', user.id).eq('status', 'aberto').limit(1)
      if (vivo) setCaixaAberto(!!(data && data.length))
    }
    checarCaixa()
    const aoVoltar = () => { if (document.visibilityState === 'visible') checarCaixa() }
    document.addEventListener('visibilitychange', aoVoltar)
    window.addEventListener('focus', aoVoltar)
    return () => {
      vivo = false
      document.removeEventListener('visibilitychange', aoVoltar)
      window.removeEventListener('focus', aoVoltar)
    }
  }, [empresaId, user?.id])

  // ── Teclado do celular ────────────────────────────────────────────────
  // O CSS não enxerga o teclado: pra ele a tela continua inteira (100dvh), e
  // por isso a lista de produtos nascia POR BAIXO do teclado — o garçom
  // digitava "Itaipava", via o resultado aparecer e não conseguia tocar nele
  // sem antes fechar o teclado.
  //
  // O visualViewport sabe quanto de tela REALMENTE sobrou. A gente joga essa
  // altura numa variável e marca no <html> que o teclado está aberto; o CSS
  // encolhe a gaveta pro espaço livre e a lista volta a caber.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const raiz = document.documentElement
    const ajustar = () => {
      raiz.style.setProperty('--sal-altura', Math.round(vv.height) + 'px')
      // margem de 120px: barra do navegador entrando/saindo mexe uns poucos
      // pixels e isso NÃO é teclado. Teclado come bem mais que isso.
      raiz.dataset.teclado = (window.innerHeight - vv.height) > 120 ? 'aberto' : ''
    }
    ajustar()
    vv.addEventListener('resize', ajustar)
    vv.addEventListener('scroll', ajustar)
    return () => {
      vv.removeEventListener('resize', ajustar)
      vv.removeEventListener('scroll', ajustar)
      raiz.style.removeProperty('--sal-altura')
      delete raiz.dataset.teclado
    }
  }, [])

  // Comanda de balcão não tem mesa, então ela entra no mapa com uma chave própria
  // ('bal:<id>'). Assim TODO o resto da tela (drawer, fechamento, impressão) segue
  // funcionando igual, sem saber que aquilo não é mesa.
  const chaveComanda = (c) => 'bal:' + c.id
  const comandaPorMesa = useMemo(() => {
    const map = {}
    for (const c of comandas) map[c.tipo === 'balcao' ? chaveComanda(c) : c.mesa_id] = c
    return map
  }, [comandas])

  // Comandas de balcão abertas, na ordem do número.
  const comandasBalcao = useMemo(
    () => comandas.filter(c => c.tipo === 'balcao').sort((a, b) => (a.numero_mesa ?? 0) - (b.numero_mesa ?? 0)),
    [comandas]
  )

  // "Mesa de mentira" que representa uma comanda de balcão no drawer.
  const mesaDaComanda = (c) => ({
    id: chaveComanda(c), is_comanda: true, comanda_id: c.id,
    numero: c.numero_mesa, nome: c.nome_cliente || '', capacidade: 0,
  })

  // Rótulo curto: "Mesa 4" / "Comanda 07" (sem o nome — ele aparece do lado).
  const rotuloMesa = (mesa) => {
    if (!mesa) return ''
    if (mesa.is_comanda) return rotuloComanda({ tipo: 'balcao', numero_mesa: mesa.numero }, { comNome: false })
    return mesa.is_balcao ? 'Balcão' : `Mesa ${mesa.numero}`
  }

  // Só hora:minuto — o dia inteiro é o mesmo, mostrar a data só ocuparia espaço.
  const horaCurta = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

  function subtotalDe(comanda) {
    return (comanda?.comanda_itens ?? []).reduce((s, i) => s + Number(i.preco_unitario) * i.quantidade, 0)
  }

  // O que a mesa deve DE VERDADE, com o serviço por cima. O card do quadro
  // mostrava só a soma dos itens: a mesa dizia R$ 78,00 e a conta era R$ 85,80.
  // Quem passa pelo salão lê esse número pra saber quanto a mesa tem — e na
  // mesa azul é o valor que o ADM vai receber. Na azul vale a taxa que o garçom
  // gravou no fechamento, não o padrão.
  function totalDe(comanda) {
    if (!comanda) return 0
    const aplicar = comanda.status === 'aguardando_conferencia'
      ? comanda.fechamento_pendente?.aplicar_taxa !== false
      : true
    return subtotalDe(comanda) + calcularTaxa(comanda.comanda_itens ?? [], taxaPct, aplicar)
  }

  function prontosDe(comanda) {
    return (comanda?.comanda_itens ?? []).filter(i => i.status === 'pronto').length
  }

  // Mesa já servida: tem item e nenhum falta levar. Ela some do radar de
  // propósito (cor apagada) — o olho do garçom tem que cair no que falta fazer,
  // não em mesa que já está resolvida esperando a hora de fechar.
  function tudoEntregue(comanda) {
    const itens = comanda?.comanda_itens ?? []
    return itens.length > 0 && itens.every(i => i.status === 'entregue')
  }

  // O que ainda falta servir nesta mesa (pendente ou em preparo).
  function faltamDe(comanda) {
    return (comanda?.comanda_itens ?? []).filter(i => i.status !== 'entregue' && i.status !== 'pronto').length
  }

  // Bip quando a cozinha marca um item como pronto (avisa o garçom)
  const prevProntos = useRef(0)
  function bip() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain); gain.connect(ctx.destination)
      osc.type = 'sine'; osc.frequency.value = 880
      gain.gain.setValueAtTime(0.001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
      osc.start(); osc.stop(ctx.currentTime + 0.36)
    } catch { /* áudio bloqueado pelo navegador — ignora */ }
  }
  useEffect(() => {
    const total = comandas.reduce((s, c) => s + prontosDe(c), 0)
    if (total > prevProntos.current) bip()
    prevProntos.current = total
  }, [comandas])

  // A comanda separada só existe na tela depois do loadMesas(); quando ela
  // aparece, abre sozinha — quem separou vai fechar a conta agora, não depois.
  useEffect(() => {
    if (!abrirComandaId) return
    const c = comandas.find(x => x.id === abrirComandaId)
    if (!c) return
    setMesaSel(mesaDaComanda(c))
    setAbrirComandaId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abrirComandaId, comandas])

  const comandaSel = mesaSel ? comandaPorMesa[mesaSel.id] : null
  // Rascunho é por comanda e fica salvo no navegador (sobrevive a fechar sem querer).
  const rascunhoKey = comandaSel ? 'rasc_mesa_' + comandaSel.id : null
  useEffect(() => {
    if (!rascunhoKey) { setRascunho([]); setObsEnvio(''); return }
    try { setRascunho(JSON.parse(localStorage.getItem(rascunhoKey) || '[]')) } catch { setRascunho([]) }
    try { setObsEnvio(localStorage.getItem(rascunhoKey + '_obs') || '') } catch { setObsEnvio('') }
  }, [rascunhoKey])
  useEffect(() => {
    if (!rascunhoKey) return
    try { localStorage.setItem(rascunhoKey, JSON.stringify(rascunho)) } catch { /* ignora */ }
  }, [rascunho, rascunhoKey])
  useEffect(() => {
    if (!rascunhoKey) return
    try { localStorage.setItem(rascunhoKey + '_obs', obsEnvio) } catch { /* ignora */ }
  }, [obsEnvio, rascunhoKey])

  // Loja sem cozinha: o que cair no rascunho vira item da comanda na hora.
  //
  // O envio mora aqui e não dentro do addItem porque o rascunho é alimentado
  // por três caminhos (produto simples, produto com complemento e "inventar
  // produto") — resolvendo no estado, os três ficam cobertos de uma vez, e o
  // rascunho continua sendo o lugar onde a quantidade é somada antes de gravar.
  useEffect(() => {
    if (!semCozinha || !comandaSel || enviando || rascunho.length === 0) return
    enviarCozinha({ imprimir: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [semCozinha, rascunho, comandaSel, enviando])
  const subtotalRascunho = rascunho.reduce((s, r) => s + Number(r.preco_venda) * r.quantidade, 0)

  const subtotalSel = subtotalDe(comandaSel)


  // Busca o crédito sempre que muda o cliente da comanda aberta. A conta pode
  // ficar aberta por horas e ele pode ter gasto noutra mesa nesse meio-tempo —
  // por isso é consulta, e não algo guardado quando o cliente foi ligado.
  useEffect(() => {
    const cli = comandaSel?.cliente_id ?? clienteSel?.id ?? null
    // Já vem marcado quando o cliente pediu isso pelo link dele (mig 0181);
    // fora esse caso, desmarca ao trocar de cliente/comanda — marcado por
    // herança, o garçom abateria o crédito de outra pessoa sem perceber.
    setUsarCashbackConta(!!comandaSel?.usar_cashback)
    if (!cli) { setCashbackSaldo(0); return }
    let vivo = true
    supabase.rpc('cashback_do_cliente', { p_cliente_id: cli })
      .then(({ data }) => { if (vivo) setCashbackSaldo(Number(data?.saldo ?? 0)) })
    return () => { vivo = false }
  }, [comandaSel?.cliente_id, clienteSel?.id, fechando])
  // A taxa não pega tudo: item de categoria isenta (couvert) fica de fora da
  // base (mig 0192). Quem decide de verdade é o banco — aqui é só pra tela
  // mostrar o mesmo número que vai ser cobrado.
  const taxaSel = calcularTaxa(comandaSel?.comanda_itens ?? [], taxaPct, aplicarTaxa)
  const totalSel = subtotalSel + taxaSel

  // Mesa que o garçom já fechou: o interruptor da taxa começa como ELE deixou,
  // não no padrão ligado. Senão o ADM confere uma conta com serviço que não foi
  // cobrado — e é o valor gravado que o "Confirmar e liberar" usa de verdade.
  useEffect(() => {
    if (comandaSel?.status === 'aguardando_conferencia') {
      setAplicarTaxa(comandaSel?.fechamento_pendente?.aplicar_taxa !== false)
    }
  }, [comandaSel?.id, comandaSel?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Comandas que chegaram pelo link e ninguém abriu ainda (mig 0182).
  const naoVistas = useMemo(
    () => comandas.filter(c => c.status === 'aberta' && c.visto_em == null),
    [comandas])

  // Sirene a cada 4s enquanto tiver pedido esperando alguém olhar. Para
  // sozinha quando o atendente abre a comanda — não tem botão de silenciar de
  // propósito: silenciar sem atender é o buraco que isto veio tapar.
  useEffect(() => {
    if (naoVistas.length === 0) return
    tocarSirene()
    const t = setInterval(tocarSirene, 4000)
    return () => clearInterval(t)
  }, [naoVistas.length])

  // Quanto do crédito cabe nesta conta. Nunca cobre tudo: a loja precisa
  // receber alguma coisa, e o servidor recusa — melhor a tela já oferecer só o
  // que vai passar. Um centavo é o bastante pra conta não fechar em zero.
  const cashbackAplicado = usarCashbackConta
    ? Math.max(0, Math.min(cashbackSaldo, Math.round((totalSel - 0.01) * 100) / 100))
    : 0
  const totalAPagar = Math.max(0, Math.round((totalSel - cashbackAplicado) * 100) / 100)

  // Os PIX DESTA mesa (mig 0193/0195) — a cobrança mora na mesa, não numa tela.
  // Conta rachada tem um QR por pessoa, por isso é lista e não um só.
  const pixDaMesaTodos = pixPendentes.filter(x => x.comanda_id === comandaSel?.id)
  const pixAbertos = pixDaMesaTodos.filter(x => x.status !== 'pago')
  const pixPagos   = pixDaMesaTodos.filter(x => x.status === 'pago')
  const pixDaMesa  = pixAbertos[0] ?? null
  const pixJaPago  = pixPagos.reduce((soma, x) => soma + Number(x.valor || 0), 0)

  // Divisão da conta
  const somaPag = pagamentos.reduce((s, p) => s + (Number(p.valor) || 0), 0)
  const restante = Math.round((totalSel - somaPag) * 100) / 100
  // Fiado: no modo único é a forma escolhida; no dividir, as linhas marcadas como fiado.
  const valorFiado = modoPag === 'unico'
    ? (forma === 'fiado' ? totalSel : 0)
    : pagamentos.filter(p => p.forma === 'fiado').reduce((s, p) => s + (Number(p.valor) || 0), 0)
  const temFiadoNaTela = valorFiado > 0
  const clientesFiltrados = buscaCliente.trim()
    ? clientes.filter(c => semAcento(c.nome).includes(semAcento(buscaCliente))).slice(0, 20)
    : []
  // Todo pedaço de fiado precisa de dono (a função no banco também recusa). No modo
  // único é o cliente da tela; no dividir é o cliente de cada linha. As outras formas
  // (dinheiro/pix/cartão) não pedem cliente nenhum.
  const fiadoSemDono = modoPag === 'unico'
    ? (forma === 'fiado' && !clienteSel)
    : pagamentos.some(p => p.forma === 'fiado' && Number(p.valor) > 0 && !p.cliente)
  // Esperando PIX não é forma de recebimento: o dinheiro ainda não caiu, e quem
  // fecha essa conta é o Mercado Pago. Sem esta trava dava pra gerar o QR e, dois
  // toques depois, fechar a mesma mesa em dinheiro — conta fechada e PIX vivo.
  // `forma` é a escolha do modo ÚNICO. No "Dividir conta" ela não vale mais —
  // sem esta separação, quem clicava em PIX online e depois trocava pra dividir
  // ficava com o botão de receber travado sem entender por quê.
  const esperandoPix = (modoPag === 'unico' && forma === 'pix_online') || pixAbertos.length > 0
  const podeReceber = (modoPag === 'unico' || Math.abs(restante) < 0.05) && !fiadoSemDono && !esperandoPix

  // A trava do caixa existe pra a venda não escapar do caixa — e quem CRIA a
  // venda é quem libera a mesa no fim, sempre um ADM. O garçom só lança e manda
  // pra conferência; nenhuma ação dele vira venda.
  //
  // Cobrar caixa dele travava a operação por um motivo que não é dele: garçom
  // não abre caixa, e a RLS de `caixas` só deixa ele enxergar caixa que ELE
  // abriu — então a condição era impossível de satisfazer. A tela mandava
  // "abra o caixa" pra quem não tem esse botão (Wilde testou 23/08/2026).
  //
  // 02/09/2026: o ADM também deixou de precisar de caixa PRA LANÇAR. Na Saidera
  // quem abre a mesa é ele, e exigir caixa às 18h pra anotar uma cerveja que só
  // vira dinheiro às 23h só atrasava o salão. Sobra o vendedor, que tem caixa
  // próprio — a venda dele é imediata, no balcão.
  const exigeCaixa = profile?.perfil === 'vendedor'

  // FECHAR a conta é outra história: aí nasce a venda, e `vendas.caixa_id` vem
  // do caixa de quem está fechando. Sem caixa aberto a venda entra com caixa
  // NULO — o faturamento conta, mas o dinheiro não aparece em caixa nenhum e a
  // gaveta não fecha no fim da noite. Por isso a trava mudou de lugar, do
  // lançamento pro fechamento, em vez de simplesmente sumir.
  const exigeCaixaPraFechar = !caixaAberto

  // ── Ações ────────────────────────────────────────────────────────────────
  async function abrirMesa(mesa) {
    if (exigeCaixa && !caixaAberto) {
      window.alert('⚠️ Abra o caixa primeiro (aba 💵 Caixa) pra lançar na mesa.')
      return
    }
    const existente = comandaPorMesa[mesa.id]
    // Comanda de balcão já nasce criada (o banco é quem dá o número) — só abre.
    if (!existente && !mesa.is_comanda) {
      // O `existente` acima é a MEMÓRIA DESTA TELA. Com a internet do salão
      // engasgando, o garçom toca duas vezes: no segundo toque a resposta do
      // primeiro ainda não chegou, a tela ainda acha a mesa vazia e cria uma
      // comanda GÊMEA. Foi o que aconteceu na Saidera na madrugada de 05/09,
      // quatro vezes — e é de onde vem o "fecho a conta e a mesa volta": ela
      // fechava uma comanda e a outra continuava aberta.
      //
      // Agora quem recusa é o banco (índice único, mig 0244). O erro 23505 aqui
      // não é problema: significa que a mesa JÁ foi aberta — pela outra batida
      // do mesmo dedo, ou por outro garçom no mesmo segundo. Segue em frente.
      const { error: errAbrir } = await supabase.from('comandas').insert({
        empresa_id: empresaId, mesa_id: mesa.id, numero_mesa: mesa.numero, garcom_id: user?.id ?? null,
      })
      if (errAbrir && errAbrir.code !== '23505') {
        window.alert('Não consegui abrir a mesa: ' + errAbrir.message)
        return
      }
      await supabase.from('mesas').update({ status: 'ocupada' }).eq('id', mesa.id)
      await loadMesas()
    }
    // Abrir a comanda JÁ conta como "vi" (mig 0182): para a sirene e o piscar.
    // Não tem botão separado de confirmar de propósito — botão de silenciar sem
    // atender seria exatamente o buraco que isto veio tapar.
    const alvo = existente ?? comandaPorMesa[mesa.id]
    if (alvo && alvo.visto_em == null) {
      supabase.rpc('marcar_comanda_vista', { p_comanda_id: alvo.id }).then(loadMesas)
    }

    setMesaSel(mesa)
    setBusca(''); setCategoriaSel(null); setFechando(false); setForma('dinheiro'); setAplicarTaxa(true)
    // Mesa sem nada lançado cai direto no cardápio: foi pra isso que o
    // atendente abriu ela. Mesa com conta abre na conta.
    setAbaMesa((alvo?.comanda_itens ?? []).length > 0 ? 'comanda' : 'add')
    // Zera o fechamento anterior: linha de fiado com o devedor da OUTRA mesa ainda
    // na tela é o tipo de sobra que joga dívida no nome errado.
    setModoPag('unico'); setPagamentos([]); setPickerFiadoIdx(null); setClienteSel(null); setBuscaCliente('')
  }

  // Abre uma comanda de BALCÃO e já cai na tela de lançar o pedido, igual à mesa —
  // sem perguntar nada antes. Quem dá o número é o banco (abrir_comanda_balcao):
  // dois atendentes clicando junto não podem receber o mesmo número. O nome do
  // cliente entra depois, lá dentro, pelo mesmo "Ligar cliente" das mesas.
  async function criarComandaBalcao() {
    if (exigeCaixa && !caixaAberto) {
      window.alert('⚠️ Abra o caixa primeiro (aba 💵 Caixa) pra abrir comanda.')
      return
    }
    if (abrindoComanda) return
    setAbrindoComanda(true)
    const { data, error } = await supabase.rpc('abrir_comanda_balcao', { p_nome: null, p_cliente_id: null })
    setAbrindoComanda(false)
    if (error) { window.alert('Erro ao abrir a comanda: ' + error.message); return }
    // Recarrega e já abre o drawer da comanda nova (o atendente vai lançar agora).
    const { data: nova } = await supabase.from('comandas')
      .select('*, comanda_itens(*), cliente:clientes(id, nome, telefone)').eq('id', data).single()
    await loadMesas()
    if (nova) {
      setMesaSel(mesaDaComanda(nova))
      setBusca(''); setCategoriaSel(null); setFechando(false); setForma('dinheiro'); setAplicarTaxa(true); setAbaMesa('add')
      setModoPag('unico'); setPagamentos([]); setPickerFiadoIdx(null); setClienteSel(null); setBuscaCliente('')
    }
  }

  // Liga (ou tira) o cliente da comanda desta mesa. cliente = null tira.
  async function ligarClienteComanda(cliente) {
    if (!comandaSel) return
    setLigandoCliente(true)
    const { error } = await supabase.rpc('vincular_cliente_comanda', {
      p_comanda_id: comandaSel.id, p_cliente_id: cliente?.id ?? null,
    })
    // O nome também é gravado na própria comanda: é ele que sai escrito na
    // comanda da cozinha, no cupom e no histórico ("Mesa 4 · Maria").
    // Vale pra MESA também, não só pro balcão — sem isto, o nome digitado sem
    // cadastro não tinha onde morar e o atendente clicava e não acontecia nada.
    if (!error) {
      await supabase.from('comandas')
        .update({ nome_cliente: cliente?.nome ?? null }).eq('id', comandaSel.id)
    }
    setLigandoCliente(false)
    setPickerCliente(false)
    if (error) { window.alert('Erro ao ligar o cliente: ' + error.message); return }
    await loadMesas()
  }

  // Fecha o drawer da mesa. Se a mesa foi só ABERTA e não tem NADA (nenhum item
  // lançado e nenhum rascunho), desocupa: apaga a comanda vazia e libera a mesa —
  // assim "olhar" a mesa não deixa ela ocupada com R$ 0,00.
  async function sairDaMesa() {
    const c = comandaSel
    if (c && c.status === 'aberta' && (c.comanda_itens ?? []).length === 0 && rascunho.length === 0) {
      await supabase.from('comandas').delete().eq('id', c.id)
      // Comanda de balcão não tem mesa pra liberar — some sozinha ao ser apagada.
      if (c.mesa_id) await supabase.from('mesas').update({ status: 'livre' }).eq('id', c.mesa_id)
      if (rascunhoKey) { try { localStorage.removeItem(rascunhoKey) } catch { /* ignora */ } }
      setMesaSel(null)
      await loadMesas()
      return
    }
    setMesaSel(null)
  }

  // Adicionar item agora vai pro RASCUNHO (não vai pra cozinha ainda). Só quando o
  // garçom clica "Enviar para a cozinha" é que os itens são gravados e impressos.
  function addItem(produto) {
    if (!comandaSel) return
    if (comandaSel.status === 'aguardando_conferencia') { window.alert('Conta já fechada, aguardando o ADM liberar a mesa.'); return }
    // Produto com complemento abre o modal de montagem em vez de cair direto no rascunho.
    if (compMap[produto.produto_id]?.length) { setMontando(produto); return }
    empilhar({
      produto_id: produto.produto_id, linha: String(produto.produto_id),
      nome: produto.nome, preco_venda: Number(produto.preco_venda),
      complementos: [], quantidade: 1, observacao: '',
    })
  }

  // Soma na linha igual se já existir; senão cria uma nova. Duas montagens diferentes do
  // mesmo produto têm `linha` diferente, então ficam em linhas separadas (cada uma com
  // seu preço) — é o que permite lançar marmitex de valores diferentes na mesma comanda.
  function empilhar(novo) {
    setRascunho(prev => {
      const i = prev.findIndex(r => (r.linha ?? String(r.produto_id)) === novo.linha)
      if (i >= 0) {
        const c = prev.slice(); c[i] = { ...c[i], quantidade: c[i].quantidade + novo.quantidade }; return c
      }
      return [...prev, novo]
    })
  }

  // Depósito de bebida, conveniência, adega: não existe preparo. Ligado isto, o
  // item cai direto na comanda ao ser escolhido — sem rascunho, sem botão de
  // enviar e sem papel de uma cozinha que não existe.
  async function alternarCozinha() {
    if (!empresaId || salvandoCoz) return
    const novo = !semCozinha
    setSemCozinha(novo)
    setSalvandoCoz(true)
    const { error } = await supabase.from('empresas')
      .update({ presencial_sem_cozinha: novo })
      .eq('id', empresaId)
    setSalvandoCoz(false)
    if (error) {
      setSemCozinha(!novo)
      alert(`Não consegui salvar: ${error.message}`)
    }
  }

  // Liga/desliga a exigência dos complementos no presencial. Atualiza a tela na
  // hora e só depois grava — se o banco recusar, volta como estava.
  async function alternarObrigatorios() {
    if (!empresaId || salvandoObrig) return
    const novo = !semObrigatorios
    setSemObrigatorios(novo)
    setSalvandoObrig(true)
    const { error } = await supabase.from('empresas')
      .update({ presencial_sem_obrigatorios: novo })
      .eq('id', empresaId)
    setSalvandoObrig(false)
    if (error) {
      setSemObrigatorios(!novo)
      alert(`Não consegui salvar: ${error.message}`)
    }
  }

  // Fecha o modal de complementos criando a linha montada.
  function addMontado(produto, escolhas, qtdItem = 1) {
    const adicional = adicionalComplementos(
      compMap[produto.produto_id] ?? [],
      escolhas.map(e => ({ grupoId: e.grupoId, preco: e.preco_adicional, qtd: e.qtd })),
    )
    // No atacado a linha nasce com a soma dos sabores (45 picolés), não com 1.
    const qtd = Math.max(1, Number(qtdItem) || 1)
    // "2× Marmitex Grande, Feijão" — o nome carrega a montagem, porque comanda_itens
    // não tem coluna de complemento (mesmo jeito do cardápio do QR).
    const resumo = escolhas.map(e => (e.qtd > 1 ? `${e.qtd}× ${e.nome}` : e.nome)).join(', ')
    empilhar({
      produto_id: produto.produto_id,
      linha: `${produto.produto_id}::${resumo}`,
      nome: resumo ? `${produto.nome} (${resumo})` : produto.nome,
      preco_venda: Number(produto.preco_venda) + adicional / qtd,
      complementos: escolhas,
      quantidade: qtd, observacao: '',
    })
    setMontando(null)
  }

  function mudarQtdRascunho(linha, delta) {
    setRascunho(prev => prev.flatMap(r => {
      if ((r.linha ?? String(r.produto_id)) !== linha) return [r]
      const q = r.quantidade + delta
      return q <= 0 ? [] : [{ ...r, quantidade: q }]
    }))
  }
  // Observação do item AINDA no rascunho (antes de ir pra cozinha) — vai junto no envio.
  function mudarObsRascunho(linha, texto) {
    setRascunho(prev => prev.map(r => (r.linha ?? String(r.produto_id)) === linha ? { ...r, observacao: texto } : r))
  }

  // Preço do item ainda no rascunho. É assim que a loja que vende no peso trabalha:
  // pesa o prato, digita o valor que deu e SÓ ENTÃO manda pra cozinha.
  function salvarPrecoRascunho(linha) {
    const txt = precoRascEdit[linha]
    setPrecoRascEdit(prev => { const n = { ...prev }; delete n[linha]; return n })
    if (txt === undefined) return
    const preco = valorMoeda(txt)
    if (!Number.isFinite(preco) || preco < 0) return
    setRascunho(prev => prev.map(r => {
      const k = r.linha ?? String(r.produto_id)
      if (k !== linha || Number(r.preco_venda) === preco) return r
      // Preço digitado na mão vira uma linha ÚNICA: senão o próximo prato igual
      // empilhava em cima desta e herdava o peso do prato anterior.
      return { ...r, preco_venda: preco, linha: `${k}::p${Date.now()}` }
    }))
  }

  // "Inventar produto": adiciona um item que não está no catálogo. Marcando
  // "adicionar ao catálogo", cria o produto de verdade (pra próximas vendas); senão o
  // item existe só nesta venda (produto_id "avulso:", que vira null no comanda_itens).
  // Garçom também cria — a regra do banco ("Garcom cria produto pelo salao") deixa ele
  // INSERIR produto da própria loja, mas não mexer nem apagar os que já existem.
  async function adicionarInventado() {
    if (!comandaSel) return
    if (comandaSel.status === 'aguardando_conferencia') { window.alert('Conta já fechada, aguardando o ADM liberar a mesa.'); return }
    const nome = invNome.trim()
    const preco = valorMoeda(invPreco)
    if (!nome) { window.alert('Digite o nome do produto.'); return }
    if (preco <= 0) { window.alert('Digite um preço válido.'); return }

    let produtoId = 'avulso:' + Date.now() + '-' + Math.floor(Math.random() * 1000)
    if (invCatalogo) {
      setInvSalvando(true)
      const { data, error } = await supabase.from('produtos')
        .insert({ empresa_id: empresaId, nome, preco_venda: preco, categoria: (invCategoria.trim() || 'outros'), controla_estoque: false })
        .select('id').single()
      setInvSalvando(false)
      if (error) { window.alert('Erro ao salvar no catálogo: ' + error.message); return }
      produtoId = data.id
      await loadAll()  // aqui SIM o pesado: o produto novo tem que entrar na busca
    }
    setRascunho(prev => [...prev, { produto_id: produtoId, linha: String(produtoId), nome, preco_venda: preco, complementos: [], quantidade: 1, observacao: '' }])
    setInvNome(''); setInvPreco(''); setInvCatalogo(false); setInvCategoria(''); setInvCatNova(false); setInvAberto(false)
  }
  // Nome já existe no catálogo? (ignora acento/maiúsculas) — pra avisar sem bloquear.
  const invNomeExiste = invNome.trim() && produtos.some(p => semAcento(p.nome) === semAcento(invNome))
  // A comanda da cozinha sai AQUI, na hora do envio, quando a térmica está NESTE
  // aparelho. Antes ela dependia de duas coisas invisíveis pra quem opera só pelo
  // celular: o Painel de Pedidos estar montado (é lá que mora o ouvinte de
  // comanda_itens) E o interruptor "Auto-imprimir" estar ligado. Resultado: a
  // conta e a pré-conta saíam (são ação direta) e a comanda do pedido não —
  // exatamente o que o Wilde viu em 23/08/2026.
  //
  // Quem NÃO tem térmica aqui (garçom no celular dele, gestor no PC) continua
  // como antes: o ouvinte do Painel de Pedidos imprime.
  // Devolve se o papel REALMENTE saiu. Antes não devolvia nada e ainda saía
  // calada quando a Bluetooth estava fora do ar — o garçom apertava "enviar",
  // via a tela limpar e ia embora achando que a cozinha tinha recebido.
  async function imprimirComandaAgora(itens) {
    if (!itens.length) return false
    // Marca como impresso ANTES de mandar pra ganhar a corrida do ouvinte do
    // Painel de Pedidos, que imprimiria os mesmos itens 1,5s depois (duas vias).
    // Se a impressão falhar, a marca é desfeita logo abaixo.
    const jaSaiu = (window.__fwcMesaImpressa ||= new Set())
    for (const i of itens) jaSaiu.add(i.id)
    const dadosComanda = {
      numeroMesa: mesaSel?.numero,
      rotulo: mesaSel?.is_comanda
        ? `${rotuloMesa(mesaSel)}${comandaSel?.nome_cliente ? ' · ' + comandaSel.nome_cliente : ''}`
        : '',
      nomeLoja: empresaNome,
      atendente: (comandaSel?.garcom_id && garcons[comandaSel.garcom_id])
        ? String(garcons[comandaSel.garcom_id]).split(' ')[0] : '',
      pessoas: comandaSel?.num_pessoas || 0,
      // `setor` vem do gatilho do banco (mig 0184) — é o que diz se este item
      // é da cozinha ou do salão. Sem ele aqui, o filtro por impressora não teria
      // como separar.
      itens: itens.map(i => ({ nome: i.nome, quantidade: i.quantidade, observacao: i.observacao, setor: i.setor })),
    }
    let ok = await viaBluetooth('comanda', dadosComanda)
    if (ok) return ok

    // Uma segunda chance antes de gritar. A térmica BLE cai sozinha quando a
    // tela apaga, e a religação nem sempre pega de primeira — na prática o
    // papel saía na segunda tentativa (a do Painel, 1,5s depois) e o garçom já
    // tinha levado o susto do aviso vermelho.
    await new Promise(r => setTimeout(r, 1200))
    ok = await viaBluetooth('comanda', dadosComanda)
    if (ok) return ok

    // Sem Bluetooth NESTE aparelho não quer dizer que não saiu papel: no PC da
    // loja quem imprime é o app Impressora FWC, que recebe o item pelo tempo
    // real e nem passa por aqui. Avisar nesse caso é alarme falso a cada
    // pedido — foi o que aconteceu na Saidera assim que o papel voltou a sair.
    try {
      const mod = await import('../utils/imprimirCupom')
      if (await mod.appFwcDisponivel()) return 'app'
    } catch { /* sem app neste aparelho */ }

    // Aí sim não saiu em lugar nenhum: desfaz a marca, senão o item fica "já
    // impresso" pra sempre e nem o caminho de reserva do Painel tentaria.
    for (const i of itens) jaSaiu.delete(i.id)
    return false
  }

  // Este aparelho imprime só um setor e a remessa não tinha nada dele. É o caso
  // do espetinho na Saidera: a categoria está marcada como SALÃO, o celular está
  // marcado como COZINHA, e o papel não sai em lugar nenhum — sem erro, sem
  // aviso, porque tecnicamente "não era pra sair aqui".
  function motivoFiltro(itens) {
    const papel = papelImpressora()
    if (papel === 'tudo') return null
    const doPapel = (itens ?? []).filter(i => (i.setor === 'cozinha' ? 'cozinha' : 'frente') === papel)
    if (doPapel.length) return null
    const outro = papel === 'cozinha' ? 'salão' : 'cozinha'
    return `Este aparelho está marcado como impressora da ${papel === 'cozinha' ? 'COZINHA' : 'FRENTE/SALÃO'}, `
      + `e estes ${(itens ?? []).length} item(ns) são da ${outro}. `
      + `Imprima na outra impressora — ou, se a loja tem uma só, mude o papel deste aparelho para "tudo" na tela da Impressora.`
  }

  // Reimprimir o que já foi enviado. A térmica Bluetooth cai sozinha de vez em
  // quando (celular longe, tela apagada) e antes não havia saída nenhuma: o
  // jeito era cancelar a comanda e refazer, ou gritar o pedido pra cozinha.
  async function reimprimir(itens) {
    if (!itens?.length || reimprimindo) return
    setReimprimindo(true)
    let ok = await viaBluetooth('comanda', {
      numeroMesa: mesaSel?.numero,
      rotulo: mesaSel?.is_comanda
        ? `${rotuloMesa(mesaSel)}${comandaSel?.nome_cliente ? ' · ' + comandaSel.nome_cliente : ''}`
        : '',
      nomeLoja: empresaNome,
      atendente: (comandaSel?.garcom_id && garcons[comandaSel.garcom_id])
        ? String(garcons[comandaSel.garcom_id]).split(' ')[0] : '',
      pessoas: comandaSel?.num_pessoas || 0,
      itens: itens.map(i => ({ nome: i.nome, quantidade: i.quantidade, observacao: i.observacao, setor: i.setor })),
    })
    // Sem Bluetooth: manda pelo app FWC do PC. Aqui a chamada é DIRETA (rota
    // manual do app) porque reimpressão é pedido explícito — o tempo real, que
    // é quem imprime sozinho, já passou faz tempo.
    if (!ok) {
      try {
        const mod = await import('../utils/imprimirCupom')
        if (await mod.appFwcDisponivel()) {
          await mod.imprimirComandaMesaApp({
            numeroMesa: mesaSel?.numero,
            rotulo: mesaSel?.is_comanda ? rotuloMesa(mesaSel) : '',
            comandaId: comandaSel?.id,
            nomeLoja: empresaNome,
            itens: itens.map(i => ({ nome: i.nome, quantidade: i.quantidade, preco_unitario: i.preco_unitario, observacao: i.observacao })),
          })
          ok = 'app'
        }
      } catch { /* sem app neste aparelho */ }
    }
    setReimprimindo(false)
    const filtro = ok === 'filtrado' ? motivoFiltro(itens) : null
    setAvisoImpressao(filtro ? { itens, motivo: filtro, quando: Date.now() } : ok ? null : { itens, quando: Date.now() })
    if (ok && !filtro) setPreContaMsg('🖨️ Comanda reimpressa.')
  }

  // Envia o pedido montado pra cozinha: insere TODOS os itens de uma vez → sai numa
  // impressão só (o gestor e o app FWC juntam os inserts que chegam juntos).
  async function enviarCozinha({ imprimir = true } = {}) {
    if (!comandaSel || !rascunho.length || enviando) return
    setEnviando(true)
    // "PARA VIAGEM" e o recado da remessa vão na observação de cada item: é o único
    // campo que sai impresso na comanda da cozinha (grande e em negrito, dentro do
    // bloco do item). Observação escrita DEPOIS do envio não imprime — por isso ela é
    // montada aqui, na hora de gravar.
    const recado = obsEnvio.trim()
    const rows = rascunho.map(r => ({
      empresa_id: empresaId, comanda_id: comandaSel.id,
      produto_id: (r.produto_id && !String(r.produto_id).startsWith('avulso:')) ? r.produto_id : null,
      nome: r.nome,
      preco_unitario: Number(r.preco_venda), quantidade: r.quantidade,
      // Sem cozinha o produto sai da prateleira pra mão do cliente: nasce
      // entregue, senão a comanda fica cheia de "preparando" esperando um
      // "Marcar pronto" que ninguém vai apertar.
      ...(semCozinha ? { status: 'entregue' } : {}),
      observacao: [
        comandaSel.para_viagem ? 'PARA VIAGEM' : '',
        recado,
        (r.observacao ?? '').trim(),
      ].filter(Boolean).join(' · ') || null,
    }))
    const { data: inseridos, error } = await supabase.from('comanda_itens').insert(rows).select()
    setEnviando(false)
    if (error) { window.alert('Erro ao lançar o item: ' + error.message); return }

    // LIMPA O RASCUNHO AQUI, antes de imprimir. Estava lá embaixo, depois da
    // impressão — e a impressão demora (Bluetooth, app do celular, papel). Nessa
    // janela o botão já estava liberado e a lista ainda cheia na tela: o garçom
    // achava que não tinha ido, tocava de novo, e os MESMOS itens entravam duas
    // vezes. É o "entrou um bocado" da Saidera: 3× Couvert lançado às 05:14:26 e
    // de novo às 05:14:28, junto com os espetinhos.
    //
    // A impressão não precisa do rascunho: ela imprime `inseridos`, que veio do
    // banco. E se falhar, o aviso de reimpressão também usa `inseridos`.
    const paraImprimir = inseridos ?? []
    setRascunho([])
    setObsEnvio('')
    if (rascunhoKey) {
      try { localStorage.removeItem(rascunhoKey); localStorage.removeItem(rascunhoKey + '_obs') } catch { /* ignora */ }
    }
    // Loja sem cozinha não tem quem leia a comanda de preparo — o papel só
    // gastaria bobina.
    if (imprimir) {
      const saiu = await imprimirComandaAgora(paraImprimir)
      // Falhou: guarda ESTES itens pra reimpressão e avisa na tela. Limpar o
      // rascunho sem dizer nada era o que fazia o pedido sumir no caminho.
      // O aviso vermelho é só pra quando dá pra AFIRMAR que não saiu papel
      // (`false` = impressora não conectada, nada foi enviado). 'parcial' — erro
      // no meio do envio, com a impressora conectada — não entra aqui: a térmica
      // imprime o que recebe, e gritar em toda comanda tira o valor do aviso.
      const filtro = saiu === 'filtrado' ? motivoFiltro(paraImprimir) : null
      setAvisoImpressao(
        filtro ? { itens: paraImprimir, motivo: filtro, quando: Date.now() }
        : saiu ? null
        : { itens: paraImprimir, quando: Date.now() },
      )
    }
    await loadMesas()
  }

  // Liga/desliga "para viagem" na comanda inteira. Fica gravado no banco: os outros
  // garçons veem o selo na mesa e todo item enviado dali pra frente sai avisando.
  async function alternarViagem() {
    if (!comandaSel || salvandoViagem) return
    const novo = !comandaSel.para_viagem
    setSalvandoViagem(true)
    const { error } = await supabase.from('comandas').update({ para_viagem: novo }).eq('id', comandaSel.id)
    setSalvandoViagem(false)
    if (error) { window.alert('Não consegui salvar: ' + error.message); return }
    await loadMesas()
  }

  // Digitar a quantidade em vez de clicar no + vinte vezes. O campo fica vazio
  // enquanto o garçom apaga pra redigitar; só grava quando ele sai do campo,
  // senão apagar o "1" pra escrever "12" apagaria o item no meio do caminho.
  async function definirQtd(item, valor) {
    if (comandaSel?.status === 'aguardando_conferencia') {
      window.alert('Conta já fechada, aguardando o ADM liberar a mesa. Não dá pra mexer nos itens.')
      return
    }
    const n = Math.max(0, Math.floor(Number(valor) || 0))
    if (n === Number(item.quantidade)) return
    if (n <= 0) await supabase.from('comanda_itens').delete().eq('id', item.id)
    else await supabase.from('comanda_itens').update({ quantidade: n }).eq('id', item.id)
    await loadMesas()
  }

  function definirQtdRascunho(linha, valor) {
    const n = Math.max(0, Math.floor(Number(valor) || 0))
    setRascunho(prev => prev.flatMap(r => {
      if ((r.linha ?? String(r.produto_id)) !== linha) return [r]
      return n <= 0 ? [] : [{ ...r, quantidade: n }]
    }))
  }

  async function mudarQtd(item, delta) {
    if (comandaSel?.status === 'aguardando_conferencia') {
      window.alert('Conta já fechada, aguardando o ADM liberar a mesa. Não dá pra mexer nos itens.')
      return
    }
    const nova = item.quantidade + delta
    if (nova <= 0) await supabase.from('comanda_itens').delete().eq('id', item.id)
    else await supabase.from('comanda_itens').update({ quantidade: nova }).eq('id', item.id)
    await loadMesas()
  }

  // Dar o "pronto" sem depender do app da cozinha. Loja que não usa a tela da
  // cozinha (é o caso da Estação) tinha que abrir o Painel só pra isso.
  async function marcarItemPronto(item) {
    const { error } = await supabase.from('comanda_itens').update({ status: 'pronto' }).eq('id', item.id)
    if (error) { window.alert('Erro ao marcar pronto: ' + error.message); return }
    await loadMesas()
  }
  async function marcarTudoPronto() {
    const ids = (comandaSel?.comanda_itens ?? [])
      .filter(it => it.status !== 'pronto' && it.status !== 'entregue').map(it => it.id)
    if (!ids.length) return
    const { error } = await supabase.from('comanda_itens').update({ status: 'pronto' }).in('id', ids)
    if (error) { window.alert('Erro ao marcar pronto: ' + error.message); return }
    await loadMesas()
  }

  async function entregarItem(item) {
    // registra QUEM entregou (quem clicou) — atribuição por entrega
    await supabase.from('comanda_itens')
      .update({ status: 'entregue', entregue_por: user?.id ?? null, entregue_at: new Date().toISOString() })
      .eq('id', item.id)
    await loadMesas()
  }

  // Edita o preço unitário de um item já lançado (só admin) — ex.: prato por peso.
  async function salvarPreco(item) {
    const texto = precoEdit[item.id]
    setPrecoEdit(prev => { const n = { ...prev }; delete n[item.id]; return n })
    if (texto === undefined) return
    const preco = Math.max(0, valorMoeda(texto))
    if (!Number.isFinite(preco) || preco === Number(item.preco_unitario)) return
    const { error } = await supabase.from('comanda_itens').update({ preco_unitario: preco }).eq('id', item.id)
    if (error) { window.alert('Erro ao salvar o preço: ' + error.message); return }
    await loadMesas()
  }

  // Cancelar joga fora TUDO que já foi lançado — e não tem desfazer. O aviso
  // do navegador dizia isso numa linha cinza que ninguém lê; agora é uma tela
  // que mostra quantos itens e quanto dinheiro estão sendo descartados, com o
  // botão perigoso separado do de voltar.
  function cancelarMesa() {
    if (!comandaSel) return
    setConfirmarCancelar(true)
  }

  async function cancelarMesaDeVerdade() {
    if (!comandaSel) return
    setCancelando(true)
    await supabase.from('comandas').update({ status: 'cancelada' }).eq('id', comandaSel.id)
    if (comandaSel.mesa_id) await supabase.from('mesas').update({ status: 'livre' }).eq('id', comandaSel.mesa_id)
    setCancelando(false)
    setConfirmarCancelar(false)
    setMesaSel(null)
    await loadMesas()
  }

  // ── Trocar de mesa ───────────────────────────────────────────────────────
  // O cliente muda de lugar no meio do consumo (mesa perto do palco, mesa na
  // sombra). A comanda vai junto com tudo dentro dela — a conta do que ele já
  // consumiu não pode recomeçar do zero só porque ele levantou.
  //
  // Só mesa LIVRE recebe. Pra quem senta junto de um amigo, a comanda sai da
  // mesa e passa a ser chamada pelo NOME dele: as duas contas dividem a mesa
  // física mas fecham separadas, que é como o salão realmente trabalha.
  const mesasLivres = useMemo(
    () => mesas.filter(m => !m.is_balcao && m.id !== comandaSel?.mesa_id && !comandaPorMesa[m.id]),
    [mesas, comandaSel, comandaPorMesa]
  )

  // ── Separar a conta de quem vai embora ───────────────────────────────────
  // Os itens marcados saem da mesa e viram uma comanda no NOME da pessoa. Ela
  // fecha essa conta e vai; a mesa continua com o resto. Ver mig 0205.
  //
  // Agora vai a QUANTIDADE de cada linha (mig 0229): a mesa pediu 6 litrinhos
  // numa linha só e um dos dois vai embora levando 3 — a linha se parte em duas,
  // 3 na conta dele e 3 continuam na mesa.
  async function separar() {
    if (!comandaSel || sepBusy) return
    setSepErro('')
    if (sepSel.size === 0) { setSepErro('Marque o que é dela.'); return }
    if (!sepNome.trim()) { setSepErro('Escreva o nome de quem vai levar a conta.'); return }
    setSepBusy(true)
    const { data, error } = await supabase.rpc('separar_comanda', {
      p_comanda_id: comandaSel.id,
      p_partes: [...sepSel].map(([id, qtd]) => ({ id, qtd })),
      p_nome: sepNome.trim(),
    })
    setSepBusy(false)
    if (error) { setSepErro(error.message); return }
    setSeparando(false)
    setSepSel(new Map())
    setSepNome('')
    // Já abre a conta separada: quem separou vai fechar ela agora, não depois.
    setAbrirComandaId(data?.comanda_id ?? null)
    setMesaSel(null)
    await loadMesas()
  }

  async function mover(mesaDestinoId) {
    if (!comandaSel || moverBusy) return
    setMoverErro('')
    if (!mesaDestinoId && !moverNome.trim()) {
      setMoverErro('Escreva o nome do cliente pra comanda não ficar sem dono.')
      return
    }
    setMoverBusy(true)
    const { error } = await supabase.rpc('mover_comanda', {
      p_comanda_id: comandaSel.id,
      p_mesa_destino: mesaDestinoId ?? null,
      p_nome: mesaDestinoId ? null : moverNome.trim(),
    })
    setMoverBusy(false)
    if (error) { setMoverErro(error.message); return }
    setMovendo(false)
    setMoverNome('')
    // Fecha o drawer: a comanda mudou de chave (outra mesa, ou virou de nome),
    // então o `mesaSel` que está na mão não aponta mais pra ela.
    setMesaSel(null)
    await loadMesas()
  }

  // Salva a divisão a cada mexida — não adianta guardar só ao sair, porque o
  // caso que dói é justamente a tela sumir sem aviso (app atualizando).
  useEffect(() => {
    const id = comandaSel?.id
    if (!id || !fechando) return
    if (modoPag === 'dividir' && pagamentos.length > 0) {
      guardarRascunho(id, { modoPag, pagamentos, aplicarTaxa })
    } else if (modoPag === 'unico') {
      limparRascunho(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comandaSel?.id, fechando, modoPag, pagamentos, aplicarTaxa])

  // ── Rascunho da divisão da conta ─────────────────────────────────────────
  // Montar o rachado leva tempo: quem paga quanto, em qual forma, quem fica no
  // fiado. Isso vivia só na memória da tela — fechar a janela, trocar de mesa ou
  // o app se atualizar sozinho jogava tudo fora e o garçom refazia na frente do
  // cliente. Fica guardado neste aparelho, por comanda, até a conta ser fechada.
  function guardarRascunho(id, dados) {
    if (!id) return
    try { localStorage.setItem(`salao_fechamento_${id}`, JSON.stringify(dados)) } catch { /* cota cheia: é só conforto */ }
  }
  function lerRascunho(id) {
    if (!id) return null
    try { const raw = localStorage.getItem(`salao_fechamento_${id}`); return raw ? JSON.parse(raw) : null } catch { return null }
  }
  function limparRascunho(id) {
    if (!id) return
    try { localStorage.removeItem(`salao_fechamento_${id}`) } catch { /* nada a fazer */ }
  }

  function abrirFechamento() {
    // Volta a divisão que estava montada nesta comanda, se houver.
    const salvo = lerRascunho(comandaSel?.id)
    if (salvo?.modoPag === 'dividir' && Array.isArray(salvo.pagamentos) && salvo.pagamentos.length) {
      setModoPag('dividir')
      setPagamentos(salvo.pagamentos)
      if (typeof salvo.aplicarTaxa === 'boolean') setAplicarTaxa(salvo.aplicarTaxa)
      setForma('dinheiro')
      setClienteSel(comandaSel?.cliente ?? null); setBuscaCliente(''); setNovoCliente(false); setNovoTelefone('')
      setFechando(true)
      return
    }
    setModoPag('unico')
    setForma('dinheiro')
    setPagamentos([])
    // Já vem o cliente ligado à mesa (se houver) — assim a venda sai no nome dele.
    setClienteSel(comandaSel?.cliente ?? null); setBuscaCliente(''); setNovoCliente(false); setNovoTelefone('')
    setFechando(true)
  }

  // Cadastra na hora quem ainda não está na base (o fiado precisa de um cliente real).
  // O telefone é opcional — o que não pode é nome repetido: é o nome que diz de
  // quem é a dívida. Se já existe um xará, o sistema usa o que já está cadastrado.
  async function criarClienteFiado() {
    const nome = buscaCliente.trim()
    if (!nome) { window.alert('Digite o nome do cliente.'); return }
    setSalvandoCliente(true)
    const jaExiste = await clienteComMesmoNome(empresaId, nome, clientes)
    if (jaExiste) {
      setSalvandoCliente(false)
      const usar = window.confirm(`Já tem um cliente chamado "${jaExiste.nome}"${jaExiste.telefone ? ` (${jaExiste.telefone})` : ''}.\n\nÉ essa mesma pessoa? OK usa ela.\n\nSe for outra, cancele e mude o nome (ex.: "${jaExiste.nome} da esquina") — dois nomes iguais ninguém sabe depois de quem é a dívida.`)
      if (usar) { setClienteSel(jaExiste); setNovoCliente(false); setBuscaCliente(''); setNovoTelefone('') }
      return
    }
    const { data, error } = await supabase.from('clientes')
      .insert({ empresa_id: empresaId, nome, telefone: novoTelefone.trim() || null })
      .select('id, nome, telefone').single()
    setSalvandoCliente(false)
    if (error) { window.alert('Erro ao cadastrar o cliente: ' + error.message); return }
    setClientes(prev => [...prev, data].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')))
    setClienteSel(data); setNovoCliente(false); setBuscaCliente(''); setNovoTelefone('')
  }

  // Rachar igual entre n pessoas (ajusta a última linha p/ fechar o total)
  function dividirIgual(n) {
    const cada = Math.floor((totalSel / n) * 100) / 100
    const arr = Array.from({ length: n }, () => ({ forma: 'dinheiro', valor: cada.toFixed(2), cliente: null }))
    const resto = Math.round((totalSel - cada * n) * 100) / 100
    if (arr.length) arr[arr.length - 1].valor = (cada + resto).toFixed(2)
    setPagamentos(arr)
  }
  function addPagamento() {
    const falta = Math.max(0, Math.round((totalSel - somaPag) * 100) / 100)
    setPagamentos(prev => [...prev, { forma: 'dinheiro', valor: falta > 0 ? falta.toFixed(2) : '', cliente: null }])
  }
  function updatePagamento(i, campo, val) {
    setPagamentos(prev => prev.map((p, idx) => {
      if (idx !== i) return p
      const novo = { ...p, [campo]: val }
      // Virou fiado: já sugere o cliente ligado à mesa (dá pra trocar). Saiu do fiado:
      // limpa o dono, senão sobraria um devedor numa linha que foi paga.
      if (campo === 'forma') novo.cliente = val === 'fiado' ? (p.cliente ?? comandaSel?.cliente ?? null) : null
      return novo
    }))
  }
  // Quem fica devendo NESTA linha do fiado.
  function setClienteLinha(i, cliente) {
    setPagamentos(prev => prev.map((p, idx) => idx === i ? { ...p, cliente } : p))
    setPickerFiadoIdx(null)
  }
  function removePagamento(i) {
    setPagamentos(prev => prev.filter((_, idx) => idx !== i))
  }

  // Térmica Bluetooth ligada neste aparelho? Então é ela quem imprime. É o que
  // faz a MESMA tela servir no PC da loja (app FWC) e no celular do dono (BLE),
  // sem dois códigos diferentes. Devolve false quando não tem — aí segue o
  // caminho de sempre.
  // Papel da impressora DESTE aparelho (mig 0184). Lido do navegador na hora
  // porque o dono pode trocar no painel da Impressora com esta tela aberta.
  // Quem define é `definirSetorDaImpressora` em utils/imprimirBluetooth.js.
  const papelImpressora = () => {
    try {
      const v = localStorage.getItem('impressora_setor')
      return v === 'cozinha' || v === 'frente' ? v : 'tudo'
    } catch { return 'tudo' }
  }

  async function viaBluetooth(tipo, dados) {
    try {
      const mod = await import('../utils/imprimirBluetooth')
      return await mod.imprimirMesaSeConectada(tipo, dados)
    } catch { return false }   // sem Bluetooth neste aparelho
  }

  // PRÉ-CONTA: sai antes de escolher a forma de pagamento, pra mesa conferir o
  // que consumiu e quanto deu. Sem isso o atendente era obrigado a entrar no
  // fechamento (que já pede a forma) só pra mostrar o valor ao cliente.
  // Não mexe em nada da conta: só imprime.
  async function imprimirPreConta() {
    if (!comandaSel) return
    setPreContaMsg('')
    // Cobrar é papel do caixa. Neste aparelho só sai comanda de cozinha — dizer
    // "enviada" e não sair papel nenhum seria pior do que avisar.
    if (papelImpressora() === 'cozinha') {
      setPreContaMsg('🍳 Esta impressora é a da cozinha. A pré-conta sai na impressora da frente.')
      setTimeout(() => setPreContaMsg(''), 6000)
      return
    }
    const dados = {
      numeroMesa: mesaSel?.numero,
      rotulo: mesaSel?.is_comanda
        ? `${rotuloMesa(mesaSel)}${comandaSel?.nome_cliente ? ' · ' + comandaSel.nome_cliente : ''}`
        : null,
      itens: comandaSel?.comanda_itens ?? [],
      subtotal: subtotalSel, taxa: taxaSel, total: totalSel,
      empresa: { nome: empresaNome },
      preConta: true,
      // A pré-conta não fala em pagamento: ele ainda vai ser escolhido.
      formaPagamento: '', pagamentos: [],
    }
    // 1) Impressora aqui mesmo (térmica pareada neste aparelho, ou app FWC no PC).
    const ok = await viaBluetooth('conta', dados)
      || await imprimirHtml(montarContaPresencialHtml(dados), empresaNome, { soApp: ehCelular, origem: 'mesa' })
    if (ok) {
      setPreContaMsg('🧾 Pré-conta enviada pra impressora.')
      setTimeout(() => setPreContaMsg(''), 6000)
      return
    }

    // 2) Sem impressora AQUI (é o caso do garçom, que lança do celular dele):
    // carimba o pedido na comanda e quem tira o papel é a estação da loja — o
    // celular do balcão com a térmica, ou o PC com o app FWC. Ele só vai buscar.
    const { error } = await supabase
      .from('comandas')
      .update({ preconta_pedida_em: new Date().toISOString() })
      .eq('id', comandaSel.id)
    setPreContaMsg(error
      ? '⚠️ Não consegui pedir a pré-conta. Tente de novo.'
      : '🧾 Pedi a pré-conta na impressora da loja — pode ir buscar o papel.')
    setTimeout(() => setPreContaMsg(''), 6000)
  }

  // SEGUNDA VIA DA CONTA FECHADA.
  //
  // A conta sai UMA vez, no fechamento. Se a térmica tinha caído do Bluetooth
  // naquele instante, o papel não saía e não havia mais como tirar: a mesa já
  // estava azul, esperando o ADM, e nesse estado a tela só oferecia liberar ou
  // cancelar. O jeito era cancelar a mesa e lançar tudo de novo. Aconteceu na
  // Saidera em 27/08/2026.
  //
  // Agora dá pra pedir de novo quantas vezes precisar, enquanto a mesa está
  // azul — e o caminho é o mesmo da pré-conta: tenta a impressora deste
  // aparelho e, se não houver, manda a estação da loja tirar o papel.
  async function reimprimirConta() {
    if (!comandaSel) return
    setPreContaMsg('')
    if (papelImpressora() === 'cozinha') {
      setPreContaMsg('🍳 Esta impressora é a da cozinha. A conta sai na impressora da frente.')
      setTimeout(() => setPreContaMsg(''), 6000)
      return
    }
    // A forma de pagamento vem da comanda, não do formulário: ele foi zerado
    // quando a tela reabriu, e sairia "dinheiro" numa conta paga no cartão.
    const ok = await imprimirConta({
      soApp: ehCelular,
      formaPagamento: comandaSel.forma_pagamento || null,
    })
    if (ok) {
      setPreContaMsg('🧾 Segunda via enviada pra impressora.')
      setTimeout(() => setPreContaMsg(''), 6000)
      return
    }
    const { error } = await supabase
      .from('comandas')
      .update({ preconta_pedida_em: new Date().toISOString() })
      .eq('id', comandaSel.id)
    setPreContaMsg(error
      ? '⚠️ Não consegui pedir a impressão. Tente de novo.'
      : '🧾 Pedi na impressora da loja — pode ir buscar o papel.')
    setTimeout(() => setPreContaMsg(''), 6000)
  }

  // PRÉ-CONTA NO WHATSAPP: mesma conferência da pré-conta impressa, só que no
  // zap do cliente. Nasceu de loja sem impressora — o cliente confere no próprio
  // celular. O número é o do cliente ligado à comanda; sem ele não tem pra onde
  // mandar, então o botão pede pra ligar o cliente antes.
  async function mandarPreContaZap() {
    if (!comandaSel) return
    const tel = String(comandaSel.cliente?.telefone ?? '').replace(/\D/g, '')
    if (tel.length < 10) {
      setPreContaMsg('⚠️ Essa comanda não tem cliente com telefone. Toque no nome do cliente lá em cima pra ligar um.')
      setTimeout(() => setPreContaMsg(''), 8000)
      return
    }

    const linhas = (comandaSel.comanda_itens ?? [])
      .slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(i => {
        const qtd = Number(i.quantidade) || 1
        const total = Number(i.preco_unitario) * qtd
        return `${qtd}x ${i.nome}${itemIsento(i) ? ` ${MARCA_ISENTO}` : ''} — ${fmt(total)}`
      })

    const texto = [
      `*${empresaNome}*`,
      `Conferência da sua conta — ${mesaSel?.is_comanda ? rotuloMesa(mesaSel) : `Mesa ${mesaSel?.numero}`}`,
      '',
      ...linhas,
      '',
      `Subtotal: ${fmt(subtotalSel)}`,
      ...(taxaSel > 0 ? [`Serviço (${taxaPct}%): ${fmt(taxaSel)}`] : []),
      `*Total: ${fmt(totalSel)}*`,
      '',
      'Confere pra mim? Qualquer coisa é só falar com a gente.',
    ].join('\n')

    setEnviandoZap(true)
    setPreContaMsg('')
    try {
      const { data, error } = await supabase.functions.invoke('send-whatsapp', {
        body: { phone: tel, message: texto, empresa_id: empresaId, assunto: 'pre-conta' },
      })
      // A edge function devolve o motivo no corpo mesmo quando dá erro HTTP —
      // sem ler isso, a tela mostrava "erro" e o atendente não sabia o porquê.
      const motivo = data?.error ?? (error ? (await error.context?.json?.().catch(() => null))?.error : null)
      if (motivo) setPreContaMsg(`⚠️ ${motivo}`)
      else if (error) setPreContaMsg('⚠️ Não consegui mandar. Tente de novo.')
      else setPreContaMsg(`✅ Conta enviada no WhatsApp de ${comandaSel.cliente?.nome || 'cliente'}.`)
    } catch {
      setPreContaMsg('⚠️ Não consegui mandar. Tente de novo.')
    } finally {
      setEnviandoZap(false)
      setTimeout(() => setPreContaMsg(''), 9000)
    }
  }

  async function imprimirConta({ soApp = true, formaPagamento = null } = {}) {
    const pags = modoPag === 'dividir'
      ? pagamentos
        // nome do devedor sai impresso na conta: o cliente confere de quem é a dívida
        .map(p => ({ forma: p.forma, valor: Number(p.valor) || 0, nome: p.cliente?.nome || '' }))
        .filter(p => p.valor > 0)
      : []
    // soApp: a conta do salão só sai na térmica da loja (app FWC). Se quem fechou está
    // no CELULAR (sem app), NÃO imprime no navegador do aparelho — retorna sem imprimir.
    const dados = {
      numeroMesa: mesaSel?.numero,
      // Comanda de balcão sai como "COMANDA 07 · MARIA" no lugar de "MESA 7".
      rotulo: mesaSel?.is_comanda
        ? `${rotuloMesa(mesaSel)}${comandaSel?.nome_cliente ? ' · ' + comandaSel.nome_cliente : ''}`
        : null,
      itens: comandaSel?.comanda_itens ?? [],
      subtotal: subtotalSel, taxa: taxaSel, total: totalSel,
      formaPagamento: formaPagamento ?? (modoPag === 'unico' ? forma : 'Dividido'),
      pagamentos: pags,
      empresa: { nome: empresaNome },
    }
    if (await viaBluetooth('conta', dados)) return true
    return imprimirHtml(montarContaPresencialHtml(dados), empresaNome, { soApp, origem: 'mesa' }) // app filtra por origem (PC não-mesa não imprime)
  }

  // Celular/tablet não tem impressora: nesses a conta só sai pelo app FWC (soApp).
  // Num PC a gente deixa cair no navegador — antes o PC ficava sem conta nenhuma
  // quando o app não era alcançado, e ninguém percebia que nada foi enviado.
  const ehCelular = typeof navigator !== 'undefined' && (
    navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '')
  )

  async function confirmarFechamento() {
    if (!comandaSel) return
    // A linha do crédito é montada AQUI, não escolhida pelo garçom: ele marca a
    // caixinha e a tela compõe o pagamento. Vai primeiro na lista pra a linha
    // seguinte poder vir sem valor e o servidor jogar o resto nela.
    const linhaCashback = cashbackAplicado > 0
      ? [{ forma: 'cashback', valor: Math.round(cashbackAplicado * 100) / 100 }]
      : []

    let lista
    if (modoPag === 'unico') {
      lista = [...linhaCashback, { forma, valor: Math.round(totalAPagar * 100) / 100 }]
    } else {
      lista = pagamentos
        .map(p => ({
          forma: p.forma,
          valor: Math.round((Number(p.valor) || 0) * 100) / 100,
          // Só a linha de fiado leva dono. Dinheiro/pix/cartão vão sem cliente —
          // a função no banco só exige cliente onde a dívida vai ficar.
          ...(p.forma === 'fiado' && p.cliente ? { cliente_id: p.cliente.id } : {}),
        }))
        .filter(p => p.valor > 0)
      const soma = lista.reduce((s, p) => s + p.valor, 0)
      if (lista.length === 0) { window.alert('Adicione ao menos um pagamento.'); return }
      // Dividindo a conta, as linhas cobrem só o que sobrou depois do crédito.
      if (Math.abs(soma - totalAPagar) > 0.05) {
        window.alert(`A soma (R$ ${soma.toFixed(2)}) não bate com o total a receber (R$ ${totalAPagar.toFixed(2)}).`)
        return
      }
      lista = [...linhaCashback, ...lista]
    }
    // Pagamento único: quem diz QUANTO é o servidor (ele reconta os itens da mesa na
    // hora). O valor calculado aqui vai só pro papel e pro gestor conferir — se os
    // dois divergirem, vale a conta do servidor e a mesa não trava mais (mig 0144).
    // 'pix_online' e nome de TELA, nao forma de pagamento: no banco ele e PIX
    // igual aos outros. Sem esta traducao o fechamento gravava a parte do QR
    // como DINHEIRO e a gaveta fechava sobrando no fim do dia.
    const formaReal = f => (f === 'pix_online' ? 'pix' : f)
    const listaRpc = (modoPag === 'unico'
      ? [...linhaCashback, { forma, valor: null }]
      : lista
    ).map(l => ({ ...l, forma: formaReal(l.forma) }))
    // Fiado sem cliente não fecha: a dívida cairia no "Consumidor (Mesa)" e ninguém
    // saberia de quem cobrar. A função no banco barra também, isto é só o aviso amigável.
    const temFiado = lista.some(p => p.forma === 'fiado' && (p.valor ?? 1) > 0)
    if (temFiado && modoPag === 'unico' && !clienteSel) {
      window.alert('Escolha o cliente que vai ficar devendo.')
      return
    }
    if (temFiado && modoPag === 'dividir' && lista.some(p => p.forma === 'fiado' && !p.cliente_id)) {
      window.alert('Escolha quem fica devendo em cada linha do fiado.')
      return
    }
    // Cinto de segurança do PIX: o botão já fica travado, mas fechar a conta com
    // um PIX vivo deixaria a mesa fechada e o QR pagável — dinheiro entrando sem
    // conta pra receber.
    if (esperandoPix) {
      window.alert('Esta mesa está esperando um PIX. Quando o pagamento cair a conta fecha sozinha — ou cancele o PIX na comanda pra receber de outro jeito.')
      return
    }
    // Aqui a venda nasce de verdade. Sem caixa aberto ela entraria com caixa
    // NULO: o faturamento contaria e o dinheiro não apareceria em caixa nenhum.
    if (ehAdmin && exigeCaixaPraFechar) {
      window.alert('⚠️ Abra o caixa (aba 💵 Caixa) pra receber esta conta.\n\nLançar na mesa não precisa de caixa — receber precisa, senão o dinheiro não entra em caixa nenhum e a gaveta não fecha no fim da noite.')
      return
    }
    setSalvando(true)
    // Só fecha DIRETO (gera a venda + libera a mesa + imprime) quem é ADM e está no
    // PC da loja (com o app FWC/térmica). ADM no CELULAR (sem impressora) NÃO fecha
    // direto — senão a conta não sairia em lugar nenhum. Vai pro gestor, igual garçom.
    const temImpressoraLocal = ehAdmin ? await appFwcDisponivel() : false
    if (ehAdmin && temImpressoraLocal) {
      // Quem fechou a conta, pro ranking (mig 0187). Carimba ANTES do RPC: ele
      // mexe em status/total e não encosta nestes campos.
      await supabase.from('comandas')
        .update({ fechada_por: user?.id ?? null, fechada_por_em: new Date().toISOString() })
        .eq('id', comandaSel.id)
      // ADM no PC da loja: fecha de vez (gera a venda e libera a mesa) e imprime aqui.
      const { error } = await supabase.rpc('fechar_conta_presencial', {
        p_comanda_id: comandaSel.id,
        p_pagamentos: listaRpc,
        p_aplicar_taxa: aplicarTaxa,
        // No dividir, cada linha de fiado já leva o seu cliente_id; aqui vai só o
        // cliente da conta (o que fica na comanda e paga a parte à vista).
        p_cliente_id: (modoPag === 'unico' ? clienteSel?.id : null) ?? comandaSel.cliente_id ?? null,
      })
      setSalvando(false)
      if (error) { window.alert('Erro ao fechar a conta: ' + error.message); return }
      escritaEm.current = Date.now()
      imprimirConta().catch(() => { /* best-effort */ })
    } else {
      // Garçom, OU ADM no celular (sem impressora): NÃO libera a mesa. Marca
      // "aguardando_conferencia" e guarda o pagamento; depois o ADM confere e libera.
      //
      // A conta é impressa AQUI, por quem fechou. Antes dependia do Painel de Pedidos
      // estar aberto pra perceber a mesa em "aguardando" e mandar imprimir — se a
      // loja fechava a conta pela tela do Salão com o painel fechado, o comando nunca
      // era criado: não dava erro, não ia pra fila, e ninguém entendia por que só a
      // conta não saía (Estação, 07/08/2026). No celular continua sem imprimir.
      // Celular COM térmica Bluetooth imprime aqui igual a um PC — era essa a
      // premissa velha ("celular não tem impressora") que deixava a loja que só
      // usa o celular sem a conta da mesa.
      const vaiImprimirAqui = (!ehCelular || window.__fwcBtConectada === true)
        && papelImpressora() !== 'cozinha'   // a da cozinha não tira conta
      const { data: mudou, error } = await supabase.from('comandas').update({
        status: 'aguardando_conferencia',
        // Quem fechou, pro ranking (mig 0187). É o garçom que mandou pra
        // conferência — não o ADM que libera a mesa depois.
        fechada_por: user?.id ?? null,
        fechada_por_em: new Date().toISOString(),
        // cliente_id vai junto: quem libera a mesa depois é o ADM, e sem isso o
        // fiado perderia o dono no caminho.
        // `lista` já carrega o cliente_id de cada linha de fiado; o cliente_id de fora
        // é o dono da conta (usado no modo único e como reserva).
        fechamento_pendente: {
          pagamentos: lista,
          aplicar_taxa: aplicarTaxa,
          cliente_id: (modoPag === 'unico' ? clienteSel?.id : null) ?? comandaSel.cliente_id ?? null,
          // Avisa o Painel de Pedidos que a conta já saiu aqui — senão, com o painel
          // aberto noutra aba, sairiam duas vias da mesma conta.
          conta_impressa: vaiImprimirAqui,
        },
      // `.eq('status','aberta')`: se a conta JÁ foi fechada (outro aparelho, ou
      // esta tela está velha), este update sem trava a puxava de volta pra
      // "aguardando ADM" — a mesa voltava a ficar azul depois de liberada, e
      // dessa vez de verdade, no banco.
      }).eq('id', comandaSel.id).eq('status', 'aberta').select('id')
      setSalvando(false)
      if (error) { window.alert('Erro ao enviar pro caixa: ' + error.message); return }
      if (!mudou || mudou.length === 0) {
        window.alert('Esta conta já tinha sido fechada por outro aparelho. Nada foi alterado.')
        setFechando(false); setMesaSel(null); await loadMesas(); return
      }
      escritaEm.current = Date.now()
      // soApp: false num PC — se o app FWC não responder, sai pelo navegador em vez
      // de a conta simplesmente não existir.
      if (vaiImprimirAqui) imprimirConta({ soApp: false }).catch(() => { /* best-effort */ })
    }
    limparRascunho(comandaSel.id)
    setFechando(false)
    setMesaSel(null)
    await loadMesas()
  }

  // ── PIX online da mesa (mig 0193) ────────────────────────────────────────
  // Gera a cobrança na conta do Mercado Pago DA LOJA. Ninguém marca "recebido"
  // aqui: quem fecha a conta é o webhook do MP, quando o dinheiro cai.
  //
  // O QR NÃO prende a tela de propósito. O garçom gera, mostra pro cliente e vai
  // atender outra mesa — a cobrança fica morando na mesa (card na comanda e selo
  // no quadro). Quando o PIX cai, a mesa fecha e some do salão sozinha.
  // Uma linha da conta dividida vira o SEU QR (mig 0195). O resto do fluxo é
  // igual: o QR fica na mesa e a conta só fecha quando o pago cobre o total.
  async function cobrarPixDaLinha(i) {
    const linha = pagamentos[i]
    const valor = Number(String(linha?.valor ?? '').replace(',', '.'))
    if (!(valor > 0)) { window.alert('Digite o valor desta parte antes de gerar o QR.'); return }
    // Manda QUAL parte é: duas pessoas dividindo meio a meio têm o mesmo valor,
    // e sem o número a segunda recebia o QR da primeira.
    await cobrarPixOnline(valor, i)
  }

  async function cobrarPixOnline(valorParcial = null, parte = null) {
    // Se vier qualquer coisa que não seja número (um evento de clique, por
    // exemplo), trata como conta inteira. Sem isso, o valor ia pro corpo da
    // requisição e a cobrança morria antes de sair do navegador.
    if (typeof valorParcial !== 'number') valorParcial = null
    if (!comandaSel) return
    setPixMsg('')
    // Marca a escolha ANTES de sair chamando o Mercado Pago: enquanto o QR não
    // chega, quem olha a tela tem que ver que o PIX foi o escolhido — senão fica
    // "Dinheiro" aceso e ninguém sabe no que clicou. (No rachado a marcação é
    // por linha, então não mexe na forma da conta inteira.)
    if (valorParcial == null) setForma('pix_online')
    setPixGerando(true)
    try {
      const { data, error } = await supabase.functions.invoke('comanda-pix', {
        body: {
          acao: 'criar',
          comanda_id: comandaSel.id,
          aplicar_taxa: aplicarTaxa,
          valor: valorParcial ?? null,
          parte: Number.isInteger(parte) ? parte : null,
          criada_por: user?.id ?? null,
          cliente_id: clienteSel?.id ?? comandaSel.cliente_id ?? null,
        },
      })
      const motivo = data?.error ?? (error ? (await error.context?.json?.().catch(() => null))?.error : null)
      if (motivo) { if (valorParcial == null) setForma('dinheiro'); setPixMsg(`⚠️ ${motivo}`); return }
      if (error || !data?.cobranca_id) { if (valorParcial == null) setForma('dinheiro'); setPixMsg('⚠️ Não consegui gerar o PIX. Tente de novo.'); return }
      // Conta inteira: sai do fechamento, o assunto acabou aqui. Rachada: o modal
      // fica aberto, porque ainda tem as outras partes pra resolver.
      if (valorParcial == null) setFechando(false)
      setPixAmpliado(data)
      await loadMesas()
    } catch {
      setPixMsg('⚠️ Não consegui gerar o PIX. Tente de novo.')
    } finally {
      setPixGerando(false)
    }
  }

  // O cliente desistiu do PIX: cancela no MP também, senão o QR continua vivo e
  // alguém paga meia hora depois, sem conta aberta pra receber.
  async function cancelarPixOnline(cobrancaId) {
    if (!cobrancaId) return
    const ok = await confirmar({
      titulo: 'Cancelar o PIX desta mesa?',
      texto: 'O QR para de valer na hora. Se o cliente já leu o código, avise antes de cancelar.',
      textoOk: 'Sim, cancelar o PIX',
      textoCancelar: 'Deixa o QR',
      icone: '⚡',
    })
    if (!ok) return
    setPixAmpliado(null)
    setForma('dinheiro')
    await supabase.functions.invoke('comanda-pix', { body: { acao: 'cancelar', cobranca_id: cobrancaId } })
      .catch(() => { /* expira sozinho em 30 min */ })
    await loadMesas()
  }

  // A conta de uma mesa que fechou sozinha (o PIX caiu com o garçom longe daqui).
  // Recebe a comanda de fora porque nesse momento ela já não é a mesa aberta.
  async function imprimirContaDoPix(comanda) {
    if (!comanda) return
    if (papelImpressora() === 'cozinha') return          // a da cozinha não tira conta
    if (ehCelular && window.__fwcBtConectada !== true) return  // celular sem térmica não tem onde sair
    const mesa = mesas.find(m => m.id === comanda.mesa_id) ?? null
    const itens = comanda.comanda_itens ?? []
    const subtotal = subtotalDe(comanda)
    const taxa = calcularTaxa(itens, taxaPct, true)
    const dados = {
      numeroMesa: mesa?.numero,
      rotulo: mesa ? null : rotuloComanda(comanda),
      itens, subtotal, taxa, total: subtotal + taxa,
      formaPagamento: 'pix', pagamentos: [],
      empresa: { nome: empresaNome },
    }
    if (await viaBluetooth('conta', dados)) return
    imprimirHtml(montarContaPresencialHtml(dados), empresaNome, { soApp: false, origem: 'mesa' })
  }

  // Vigia os PIX abertos enquanto o Salão estiver na tela. O caminho normal é o
  // webhook do MP fechar a conta sozinho; isto aqui é o cinto de segurança pra
  // quando ele atrasa — e é quem manda imprimir a conta da mesa que fechou
  // enquanto o garçom estava noutro canto.
  // Quem já estava pago quando esta tela carregou não é novidade — anunciar
  // pagamento velho como se tivesse acabado de cair é pior que não anunciar.
  const pixJaAnunciados = useRef(new Set())

  // O QR EM TELA CHEIA SOME QUANDO A COBRANÇA MORRE — venha a notícia de onde
  // vier. Antes só o laço de conferência abaixo fechava esse QR; quando quem
  // confirmava era o webhook do Mercado Pago (que é o caminho normal, e o mais
  // rápido), a tela recarregava a mesa por baixo e o QR continuava lá, aberto,
  // já pago. O garçom ficava mostrando pro cliente um código que não valia mais.
  useEffect(() => {
    if (!pixAmpliado?.cobranca_id) return
    const aindaAberta = pixPendentes.some(
      x => x.id === pixAmpliado.cobranca_id && x.status !== 'pago',
    )
    if (!aindaAberta) setPixAmpliado(null)
  }, [pixPendentes, pixAmpliado?.cobranca_id])

  useEffect(() => {
    const aConferir = pixPendentes.filter(x => x.status !== 'pago')
    if (aConferir.length === 0) return
    let vivo = true

    const t = setInterval(async () => {
      if (!vivo) return
      // No máximo 3 por rodada: 10 mesas esperando não viram 10 chamadas de uma vez.
      for (const pix of aConferir.slice(0, 3)) {
        if (pixJaAnunciados.current.has(pix.id)) continue
        const { data } = await supabase.functions.invoke('comanda-pix', {
          body: { acao: 'conferir', cobranca_id: pix.id },
        }).catch(() => ({ data: null }))
        if (!vivo) return
        // 'liquidado' é o mesmo dinheiro: o webhook confirmou entre uma volta e
        // outra. Aqui só chega cobrança que estava PENDENTE quando a tela
        // carregou, então nos dois casos a notícia é nova.
        if (data?.status === 'pago' || data?.status === 'liquidado') {
          pixJaAnunciados.current.add(pix.id)
          const c = comandas.find(x => x.id === pix.comanda_id)
          // O que aconteceu com a MESA quem responde é o banco, não a resposta
          // da chamada: o webhook pode ter fechado a conta antes desta volta, e
          // aí a resposta vem sem detalhe nenhum.
          const [{ data: cm }, { data: cb }] = await Promise.all([
            supabase.from('comandas').select('status').eq('id', pix.comanda_id).maybeSingle(),
            supabase.from('comanda_pix_cobrancas').select('venda_id').eq('id', pix.id).maybeSingle(),
          ])
          const fechou = cm?.status === 'fechada' && !!cb?.venda_id
          const emMesaFechada = cm?.status === 'fechada' && !cb?.venda_id
          setPixAmpliado(a => (a?.cobranca_id === pix.id ? null : a))
          setPixMsg('')

          if (emMesaFechada) {
            // Dinheiro que caiu numa mesa que já tinha sido fechada por outro
            // caminho. Não dá pra "desfechar": quem resolve é a loja, olhando.
            setAvisoPix({
              tipo: 'alerta', valor: Number(pix.valor),
              texto: 'Caiu numa mesa que já estava fechada. O dinheiro está na conta do Mercado Pago — confira se a conta foi cobrada duas vezes e, se foi, estorne pelo app.',
            })
            await loadMesas()
            continue
          }

          if (fechou) {
            await imprimirContaDoPix(c).catch(() => { /* best-effort */ })
            if (comandaSel?.id === pix.comanda_id) { setFechando(false); setMesaSel(null) }
            await loadMesas()
            setAvisoPix({
              tipo: 'pago', valor: Number(pix.valor),
              texto: 'A conta fechou sozinha e a mesa já está livre.',
            })
          } else {
            // Conta rachada: caiu uma parte. A mesa continua aberta esperando o resto.
            await loadMesas()
            setAvisoPix({
              tipo: 'parcial', valor: Number(pix.valor),
              titulo: 'Uma parte caiu',
              texto: 'Esta é a parte de quem já pagou. A mesa continua aberta até o resto da conta entrar.',
            })
          }
        }
      }
    }, 15000)

    return () => { vivo = false; clearInterval(t) }
  }, [pixPendentes, comandas, comandaSel?.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // ADM confere o pagamento e libera a mesa de vez (a partir do que o garçom fechou).
  async function confirmarLiberarAdm() {
    if (!comandaSel) return
    // Liberar a mesa é o que CRIA a venda do que o garçom fechou — mesma regra do
    // receber: sem caixa aberto o dinheiro não cai em caixa nenhum. Conta zerada
    // passa: ali não nasce venda, a comanda é só cancelada.
    if (subtotalSel > 0 && exigeCaixaPraFechar) {
      window.alert('⚠️ Abra o caixa (aba 💵 Caixa) pra liberar esta mesa.\n\nÉ agora que a venda é criada — sem caixa aberto ela entra sem caixa e a gaveta não fecha no fim da noite.')
      return
    }
    // Conta sem itens (ex.: todos removidos): não gera venda R$ 0 — cancela e libera a mesa.
    if (subtotalSel <= 0) {
      setSalvando(true)
      await supabase.from('comandas').update({ status: 'cancelada' }).eq('id', comandaSel.id)
      await supabase.from('mesas').update({ status: 'livre' }).eq('id', mesaSel.id)
      setSalvando(false)
      setMesaSel(null)
      await loadMesas()
      return
    }
    const pend = comandaSel.fechamento_pendente || {}
    const pags = Array.isArray(pend.pagamentos) && pend.pagamentos.length
      ? pend.pagamentos
      : [{ forma: 'dinheiro' }]
    // Pagamento único: manda SEM valor e deixa o servidor recontar a mesa. É o que
    // impede a mesa de travar quando o valor guardado no fechamento ficou velho
    // (item removido, preço corrigido, taxa diferente) — mig 0144.
    const lista = pags.length === 1 ? [{ ...pags[0], valor: null }] : pags
    const aplicar = pend.aplicar_taxa ?? true
    setSalvando(true)
    const { error } = await supabase.rpc('fechar_conta_presencial', {
      p_comanda_id: comandaSel.id,
      p_pagamentos: lista,
      p_aplicar_taxa: aplicar,
      p_cliente_id: pend.cliente_id ?? null,
    })
    setSalvando(false)
    if (error) { window.alert('Erro ao liberar a mesa: ' + error.message); return }
    escritaEm.current = Date.now()
    setMesaSel(null)
    await loadMesas()
  }

  // Só produtos que TÊM categoria entram no menu (os "sem categoria" somem).
  const produtosComCategoria = produtos.filter(p => (p.categoria ?? '').trim() !== '')

  // Lista de categorias (distintas) na MESMA ordem do catálogo (categorias.ordem).
  // Categoria sem ordem definida vai pro fim; empate desempata por nome.
  const categorias = useMemo(() => {
    const set = new Set(produtosComCategoria.map(p => p.categoria.trim()))
    const ord = (n) => { const v = ordemCat[n.toLowerCase()]; return v == null ? 9999 : v }
    return [...set].sort((a, b) => (ord(a) - ord(b)) || a.localeCompare(b, 'pt-BR'))
  }, [produtos, ordemCat]) // eslint-disable-line react-hooks/exhaustive-deps

  // Quantos produtos cada categoria tem — vai no fim da linha, pra pessoa saber
  // o que espera lá dentro antes de tocar.
  const qtdPorCategoria = useMemo(() => {
    const m = {}
    for (const p of produtosComCategoria) {
      const c = p.categoria.trim()
      m[c] = (m[c] || 0) + 1
    }
    return m
  }, [produtos]) // eslint-disable-line react-hooks/exhaustive-deps

  // O que a lista mostra:
  //  - Digitou algo → busca em TODAS as categorias, ignorando acento.
  //  - Sem busca + categoria escolhida → produtos daquela categoria.
  //  - Sem busca + nenhuma categoria → mostra as categorias (não os produtos).
  const buscaNorm = semAcento(busca)
  const produtosFiltrados = buscaNorm
    ? produtosComCategoria.filter(p => semAcento(p.nome).includes(buscaNorm)).slice(0, 40)
    : categoriaSel
      ? produtosComCategoria.filter(p => p.categoria.trim() === categoriaSel)
      : []

  // ── Teclado na busca de produto ─────────────────────────────────────────
  // Digita, desce na seta e confirma no Enter, igual à Nova venda. Sem isso o
  // garçom digita, tira a mão do teclado e vai mirar o produto com o mouse.
  // Volta o cursor pra busca com o texto JÁ marcado: a próxima letra que o
  // garçom digitar substitui o que estava escrito, sem ele precisar apagar
  // nem clicar de novo no campo. É o que faz lançar item atrás de item virar
  // "digita, seta, enter, digita" sem tirar a mão do teclado.
  function voltarPraBusca() {
    const el = buscaRef.current
    if (!el) return
    el.focus()
    el.select()
  }

  function teclaBusca(e) {
    if (e.key === 'ArrowUp' && destaque === 0) { voltarPraBusca(); return }
    if (!produtosFiltrados.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setDestaque(d => {
        const i = Math.max(0, Math.min(produtosFiltrados.length - 1, e.key === 'ArrowDown' ? d + 1 : d - 1))
        const el = listaProdRef.current?.children?.[i]
        if (el?.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
        return i
      })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const p = produtosFiltrados[destaque]
      if (!p) return
      addItem(p)
      // Produto com complemento abre a montagem: o foco tem que ir pra lá, não
      // voltar pra busca por baixo do modal.
      if (!compMap[p.produto_id]?.length) voltarPraBusca()
    }
  }

  if (loading) return <div className="page"><p>Carregando salão...</p></div>

  // A cor é o mapa do salão: quanto mais forte, mais precisa de você agora.
  //   verde forte + 🔔 → tem prato pronto esperando pra levar (feito no card)
  //   vermelho         → tem item pra sair da cozinha / servir
  //   cinza apagado    → tudo entregue, só falta fechar
  //   azul             → fechada, esperando o ADM liberar
  //   verde claro      → livre
  const corStatus = (mesa) => {
    const c = comandaPorMesa[mesa.id]
    if (!c) return { bg: 'rgba(34,197,94,.12)', border: '#22c55e', label: 'Livre' }
    if (c.status === 'aguardando_conferencia') return { bg: 'rgba(59,130,246,.16)', border: '#3b82f6', label: 'Aguard. ADM' }
    if (tudoEntregue(c)) return { bg: 'rgba(100,116,139,.10)', border: '#64748b', label: 'Servida' }
    const faltam = faltamDe(c)
    return { bg: 'rgba(239,68,68,.12)', border: '#ef4444', label: faltam > 0 ? `Faltam ${faltam}` : 'Ocupada' }
  }

  return (
    <div className="page">
      {/* PIX de fiado que caiu sozinho — a dívida já foi abatida, é só pra saber. */}
      {pixRecebidos.filter(p => !pixVistos.has(p.id)).map(p => (
        <div key={p.id} style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10,
          padding: '12px 14px', borderRadius: 12,
          border: '1.5px solid #16a34a', background: 'rgba(22,163,74,.12)',
        }}>
          <span style={{ fontSize: 22 }}>💰</span>
          <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>
            <strong>{p.clientes?.nome ?? 'Cliente'}</strong> pagou{' '}
            <strong>{fmt(p.valor)}</strong> do fiado pelo PIX do link.
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              A dívida já foi abatida sozinha — não precisa lançar nada.
            </div>
          </div>
          <button type="button" onClick={() => setPixVistos(s => new Set(s).add(p.id))}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-muted)', lineHeight: 1 }}
            title="Já vi">×</button>
        </div>
      ))}

      <div className="page-header">
        <div>
          {/* O garçom não entra em /presencial (é tela de ADM): pra ele o voltar
              não leva a lugar nenhum, então nem aparece. */}
          {ehAdmin && (
            <p style={{ margin: 0, fontSize: 13 }}>
              <Link to="/presencial" style={{ color: 'var(--primary)' }}>← Serviço Presencial</Link>
            </p>
          )}
          <h1>Salão</h1>
          <p className="page-subtitle">Toque numa mesa para abrir/gerenciar a comanda.</p>
          {/* Atalhos rápidos sem sair do salão: fiado (quem deve) e consumo de funcionários. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => setShowFiado(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
                border: '1.5px solid #d97706', background: 'rgba(217,119,6,.1)',
                color: '#b45309', fontSize: 13.5, fontWeight: 700,
              }}
            >
              💳 Fiado — quem está devendo
            </button>
            <button
              type="button"
              onClick={() => setShowConsumoFunc(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 10, cursor: 'pointer',
                border: '1.5px solid #16a34a', background: 'rgba(22,163,74,.1)',
                color: '#15803d', fontSize: 13.5, fontWeight: 700,
              }}
            >
              🍽️ Consumo de funcionários
            </button>
            {/* O garçom praticamente não sai desta tela — o menu lateral ele nem
                abre. O atalho pras mesas dele tem que estar aqui. */}
            {!ehAdmin && (
              <Link
                to="/presencial/historico"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 14px', borderRadius: 10, textDecoration: 'none',
                  border: '1.5px solid var(--primary)', background: 'rgba(124,58,237,.1)',
                  color: 'var(--primary)', fontSize: 13.5, fontWeight: 700,
                }}
              >
                🧾 Minhas mesas fechadas
              </Link>
            )}
          </div>
        </div>

        {/* Só o ADM liga/desliga — muda como TODO garçom lança o pedido. */}
        {ehAdmin && (
          <button
            type="button"
            onClick={alternarCozinha}
            disabled={salvandoCoz}
            title="Depósito, conveniência, adega: sem preparo, o item vai direto pra comanda."
            style={{
              alignSelf: 'flex-start', padding: '9px 14px', borderRadius: 10, cursor: salvandoCoz ? 'wait' : 'pointer',
              border: `1.5px solid ${semCozinha ? '#0ea5e9' : 'var(--border)'}`,
              background: semCozinha ? 'rgba(14,165,233,.12)' : 'transparent',
              color: semCozinha ? '#0ea5e9' : 'var(--text-muted)',
              fontSize: 13, fontWeight: 700, textAlign: 'left', lineHeight: 1.35,
            }}
          >
            {semCozinha ? '🥤 Sem cozinha' : '🍳 Tem cozinha'}
            <span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .85 }}>
              {salvandoCoz
                ? 'salvando...'
                : semCozinha
                  ? 'o item cai direto na comanda'
                  : 'o item passa pelo "enviar pra cozinha"'}
            </span>
          </button>
        )}
        {ehAdmin && (
          <button
            type="button"
            onClick={alternarObrigatorios}
            disabled={salvandoObrig}
            title="Vale no Salão e no cardápio do QR da mesa. A Loja Online e a Nova venda continuam exigindo."
            style={{
              alignSelf: 'flex-start', padding: '9px 14px', borderRadius: 10, cursor: salvandoObrig ? 'wait' : 'pointer',
              border: `1.5px solid ${semObrigatorios ? '#f59e0b' : 'var(--border)'}`,
              background: semObrigatorios ? 'rgba(245,158,11,.12)' : 'transparent',
              color: semObrigatorios ? '#f59e0b' : 'var(--text-muted)',
              fontSize: 13, fontWeight: 700, textAlign: 'left', lineHeight: 1.35,
            }}
          >
            {semObrigatorios ? '🔓 Complementos livres' : '🔒 Complementos obrigatórios'}
            <span style={{ display: 'block', fontSize: 11, fontWeight: 600, opacity: .85 }}>
              {salvandoObrig
                ? 'salvando...'
                : semObrigatorios
                  ? 'no salão e no QR dá pra lançar sem escolher'
                  : 'no salão e no QR precisa escolher os grupos'}
            </span>
          </button>
        )}
      </div>

      {/* O ADM lança sem caixa, mas não RECEBE sem caixa. O aviso continua na
          tela pra ele não descobrir isso só às 23h, com o cliente na frente
          esperando pra pagar — só que agora avisa a coisa certa. */}
      {(exigeCaixa || ehAdmin) && !caixaAberto && (
        <div style={{
          margin: '0 0 12px', padding: '12px 14px', borderRadius: 10,
          border: '1px solid #f59e0b', background: 'rgba(245,158,11,.12)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          fontSize: 13.5, fontWeight: 600, color: 'var(--text)',
        }}>
          <span>⚠️ <b>Caixa fechado.</b> {exigeCaixa
            ? <>Abra o caixa (aba <b>💵 Caixa</b>) pra poder lançar nas mesas/balcão.</>
            : <>Pode lançar nas mesas normalmente — mas pra <b>receber</b> uma conta precisa abrir o caixa (aba <b>💵 Caixa</b>).</>}</span>
        </div>
      )}

      {mesas.length === 0 && !comandaBalcaoAtiva ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
          Você ainda não cadastrou mesas. <Link to="/presencial/mesas" style={{ color: 'var(--primary)' }}>Cadastrar mesas →</Link>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 7 }}>
          {/* Comandas de balcão: nascem no botão, vêm antes das mesas e somem ao fechar. */}
          {comandaBalcaoAtiva && (
            <div role="button" tabIndex={0} onClick={criarComandaBalcao}
              onKeyDown={ev => { if (ev.key === 'Enter') criarComandaBalcao() }}
              style={{
                borderRadius: 9, padding: '7px 8px', cursor: abrindoComanda ? 'wait' : 'pointer', textAlign: 'center',
                border: '1.5px dashed var(--primary)', background: 'rgba(124,58,237,.08)',
                color: 'var(--primary)', display: 'flex', flexDirection: 'column', justifyContent: 'center',
              }}>
              <div style={{ fontSize: 18, fontWeight: 800, lineHeight: 1 }}>＋</div>
              <div style={{ fontSize: 10.5, fontWeight: 800, marginTop: 3 }}>
                {abrindoComanda ? 'Abrindo...' : 'Nova comanda'}
              </div>
            </div>
          )}
          {comandasBalcao.map(c => {
            const pseudo = mesaDaComanda(c)
            const sub = subtotalDe(c)
            const prontos = prontosDe(c)
            const naoVisto = c.visto_em == null && c.status === 'aberta'
            // Mesmo semáforo da mesa (corStatus). Antes a comanda tinha cor
            // própria e só sabia três estados — nunca ficava CINZA quando tudo
            // já tinha sido entregue, e a que faltava servir era laranja
            // "Aberta" em vez de vermelha "Faltam N". Quem olhava o quadro
            // precisava ler cor de dois jeitos: um pras mesas, outro pras
            // comandas. `comandaPorMesa` já indexa a comanda de balcão pela
            // chave da pseudo-mesa, então corStatus acha ela sozinho.
            const cor = corStatus(pseudo)
            const borda = prontos > 0 ? '#22c55e' : cor.border
            return (
              <div key={c.id} role="button" tabIndex={0} onClick={() => abrirMesa(pseudo)}
                onKeyDown={ev => { if (ev.key === 'Enter') abrirMesa(pseudo) }}
                className={naoVisto ? 'sal-comanda-nova' : undefined}
                style={{
                  borderRadius: 9, padding: '7px 8px', cursor: 'pointer', textAlign: 'left', position: 'relative',
                  border: `1.5px solid ${borda}`,
                  background: prontos > 0 ? 'rgba(34,197,94,.14)' : cor.bg,
                  color: 'var(--text)',
                  boxShadow: prontos > 0 ? '0 0 0 2px rgba(34,197,94,.25)' : 'none',
                }}>
                {prontos > 0 && (
                  <span style={{
                    position: 'absolute', top: 4, right: 4, fontSize: 9, fontWeight: 800,
                    background: '#22c55e', color: '#fff', borderRadius: 999, padding: '1px 5px',
                  }}>🔔{prontos}</span>
                )}
                {naoVisto && <span className="sal-selo-novo">NOVO</span>}
                {/* Na comanda de nome quem manda é o NOME, não o número: o
                    "Comanda 01" não existe em lugar nenhum do salão, é só um
                    contador interno. O garçom acha o pedido pelo nome do
                    cliente, então é ele que fica grande. Sem nome (comanda
                    aberta às pressas), o número volta a ser o título. */}
                {(c.nome_cliente || c.cliente?.nome) ? (
                  <>
                    <div title={c.nome_cliente || c.cliente?.nome}
                      style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.15, marginTop: naoVisto ? 10 : 0,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden', wordBreak: 'break-word' }}>
                      🧑 {c.nome_cliente || c.cliente?.nome}
                    </div>
                    <div style={{ fontSize: 9.5, marginTop: 1, fontWeight: 700, color: 'var(--text-muted)' }}>
                      🧾 {rotuloMesa(pseudo)}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.1, marginTop: naoVisto ? 10 : 0 }}>🧾 {rotuloMesa(pseudo)}</div>
                )}
                <div style={{ fontSize: 9.5, marginTop: 2, color: cor.border, fontWeight: 700 }}>
                  {cor.label}
                </div>
                {c.para_viagem && (
                  <div style={{ fontSize: 10, marginTop: 1, fontWeight: 800, color: '#d97706' }}>📦 VIAGEM</div>
                )}
                <div style={{ fontSize: 11.5, marginTop: 1, fontWeight: 800 }}>
                  {fmt(totalDe(c))}
                  {totalDe(c) > sub && <span style={{ fontWeight: 600, opacity: .75 }}> c/ serv.</span>}
                </div>
              </div>
            )
          })}
          {mesas.map(mesa => {
            const c = comandaPorMesa[mesa.id]
            const cor = corStatus(mesa)
            const sub = subtotalDe(c)
            const prontos = c ? prontosDe(c) : 0
            return (
              <div key={mesa.id} role="button" tabIndex={0} onClick={() => abrirMesa(mesa)}
                onKeyDown={ev => { if (ev.key === 'Enter') abrirMesa(mesa) }}
                style={{
                  borderRadius: 9, padding: '7px 8px', cursor: 'pointer', textAlign: 'left', position: 'relative',
                  border: `1.5px solid ${prontos > 0 ? '#22c55e' : cor.border}`,
                  background: prontos > 0 ? 'rgba(34,197,94,.14)' : cor.bg,
                  color: 'var(--text)',
                  boxShadow: prontos > 0 ? '0 0 0 2px rgba(34,197,94,.25)' : 'none',
                }}>
                {prontos > 0 && (
                  <span style={{
                    position: 'absolute', top: 4, right: 4, fontSize: 9, fontWeight: 800,
                    background: '#22c55e', color: '#fff', borderRadius: 999, padding: '1px 5px',
                  }}>🔔{prontos}</span>
                )}
                {/* Mesa esperando PIX: quem passar pelo quadro já sabe, sem abrir. */}
                {c && pixPendentes.some(x => x.comanda_id === c.id) && (
                  <span style={{
                    position: 'absolute', top: 4, left: 4, fontSize: 9, fontWeight: 800,
                    background: '#16a34a', color: '#fff', borderRadius: 999, padding: '1px 5px',
                  }}>⚡PIX</span>
                )}
                <div style={{ fontSize: 14.5, fontWeight: 800, lineHeight: 1.1 }}>{mesa.is_balcao ? '🛎️ Balcão' : `Mesa ${mesa.numero}`}</div>
                <div style={{ fontSize: 9.5, marginTop: 2, color: cor.border, fontWeight: 700 }}>{cor.label}</div>
                {c?.para_viagem && (
                  <div style={{ fontSize: 10, marginTop: 1, fontWeight: 800, color: '#d97706' }}>📦 VIAGEM</div>
                )}
                {/* Nome do cliente ligado à mesa (quando cadastrado) — ajuda a saber de quem é a mesa. */}
                {c?.cliente?.nome && (
                  <div style={{ fontSize: 10.5, marginTop: 1, fontWeight: 700, color: 'var(--primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    🧑 {c.cliente.nome}
                  </div>
                )}
                {/* Quem está atendendo. Estava só dentro da mesa aberta — o dono
                    tinha que abrir uma por uma pra saber de quem era cada uma.
                    Só o primeiro nome: no card não cabe mais que isso. */}
                {c?.garcom_id && garcons[c.garcom_id] && (
                  <div style={{ fontSize: 10, marginTop: 1, color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    👤 {String(garcons[c.garcom_id]).split(' ')[0]}
                  </div>
                )}
                {c && (
                  <div style={{ fontSize: 11.5, marginTop: 1, fontWeight: 800 }}>
                    {fmt(totalDe(c))}
                    {totalDe(c) > sub && <span style={{ fontWeight: 600, opacity: .75 }}> c/ serv.</span>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Drawer da comanda ── */}
      {mesaSel && comandaSel && (
        <div onClick={sairDaMesa} className="sal-overlay">
          <div onClick={e => e.stopPropagation()} className="sal-drawer">
            {/* header */}
            <div className="sal-header" style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 18 }}>
                  {mesaSel.is_comanda
                    ? (comandaSel?.nome_cliente || comandaSel?.cliente?.nome
                        ? `🧑 ${comandaSel.nome_cliente || comandaSel.cliente?.nome}`
                        : `🧾 ${rotuloMesa(mesaSel)}`)
                    : mesaSel.is_balcao ? '🛎️ Balcão' : `Mesa ${mesaSel.numero}`}
                </div>
                {mesaSel.is_comanda ? (
                  // O número vira legenda: é o nome que identifica o cliente no
                  // salão, o "Comanda 01" só serve pra ordenar a fila.
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>🧾 {rotuloMesa(mesaSel)} · comanda de balcão</div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{mesaSel.nome || `${mesaSel.capacidade} lugares`}</div>
                )}
                {comandaSel?.garcom_id && garcons[comandaSel.garcom_id] ? (
                  <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600, marginTop: 2 }}>
                    👤 Atendido por {garcons[comandaSel.garcom_id]}
                  </div>
                ) : comandaSel && !comandaSel.garcom_id ? (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, marginTop: 2 }}>
                    📱 Pedido pelo QR (autoatendimento)
                  </div>
                ) : null}
                {/* Conferir a mesa ANTES de fechar. Depois de fechada nao adianta:
                    se um item tem que sair da conta, tem que sair antes. A trilha
                    ja existia no banco desde o primeiro item lancado — faltava
                    poder olhar enquanto a mesa ainda esta aberta. */}
              </div>

              {/* Os chips ficam NA LINHA do título, não embaixo dele: no celular
                  eles eram uma quarta linha de cabeçalho, e cabeçalho alto come
                  a altura da comanda, que é o que o garçom precisa ver. */}
              <div className="sal-chips">
                {ehAdmin && comandaSel && (comandaSel.comanda_itens ?? []).length > 0 && (
                  <button type="button" onClick={() => setVerMovimentos(true)}
                    className="sal-chip" title="Quem lançou e quem entregou cada item"
                    aria-label="Quem fez o quê"
                    style={{ border: '1.5px solid var(--border)', background: 'transparent',
                      color: 'var(--text-muted)' }}>
                    🕑<span className="sal-chip-txt">Quem fez o quê</span>
                  </button>
                )}
                {/* Cliente da mesa: liga um cliente a esta comanda (ou troca/tira). */}
                {comandaSel && comandaSel.status !== 'fechada' && (
                  (comandaSel.cliente || comandaSel.nome_cliente) ? (
                    <button type="button" onClick={() => setPickerCliente(true)} disabled={ligandoCliente}
                      className="sal-chip" title="Trocar ou tirar o cliente"
                      style={{ border: '1.5px solid var(--primary)',
                        background: 'rgba(124,58,237,.1)', color: 'var(--primary)' }}>
                      🧑<span className="sal-chip-txt">
                        {comandaSel.cliente?.nome || comandaSel.nome_cliente}
                        {comandaSel.cliente?.telefone ? ` · ${comandaSel.cliente.telefone}` : ''} ✎
                      </span>
                    </button>
                  ) : (
                    <button type="button" onClick={() => setPickerCliente(true)} disabled={ligandoCliente}
                      className="sal-chip" title="Pôr o nome do cliente nesta conta"
                      aria-label="Pôr o nome do cliente"
                      style={{ border: '1.5px dashed var(--border)',
                        background: 'transparent', color: 'var(--text-muted)' }}>
                      {/* 🧑 e não ➕: no celular o chip é só o ícone, e um "+"
                          sozinho não diz de quê. Como este e o de cliente já
                          ligado nunca aparecem juntos, o rosto serve pros dois —
                          o que muda é a borda (tracejada = ainda sem nome). */}
                      🧑<span className="sal-chip-txt">Pôr o nome do cliente</span>
                    </button>
                  )
                )}
                {/* Fica aqui em cima, com os outros chips de gerenciar a mesa, e
                    não na barra de baixo: lá são cinco botões numa linha só e no
                    celular ele empurrava o "Fechar conta" pra fora da tela.
                    Precisa de 2+ UNIDADES, não de 2+ linhas: uma linha só de "6
                    litrinhos" também se divide, e antes o botão nem aparecia. */}
                {(comandaSel?.comanda_itens ?? []).reduce((s, i) => s + Number(i.quantidade || 0), 0) > 1 && (
                  <button type="button"
                    onClick={() => { setSepErro(''); setSepSel(new Map()); setSepNome(''); setSeparando(true) }}
                    className="sal-chip" title="Alguém vai embora antes e paga só o que consumiu"
                    aria-label="Separar conta"
                    style={{ border: '1.5px solid var(--border)', background: 'transparent',
                      color: 'var(--text-muted)' }}>
                    🧍<span className="sal-chip-txt">Separar conta</span>
                  </button>
                )}
              </div>
              <button type="button" onClick={sairDaMesa} style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
            </div>

            {/* corpo — no PC vira 2 colunas (ver PresencialSalao.css) */}
            <div className="sal-corpo" data-aba={abaMesa}>
            <div className="sal-col sal-col--comanda">
              {/* itens lançados */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                <div className="sal-titulo-col" style={{ fontSize: 15, fontWeight: 700 }}>Comanda</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {!semCozinha && (comandaSel.comanda_itens ?? []).length > 0 && (
                  <button type="button" disabled={reimprimindo}
                    onClick={() => {
                      // Já vem tudo marcado: reimprimir a comanda inteira é o
                      // caso comum. Quem quer só um item desmarca o resto.
                      setReimpSel(new Set((comandaSel.comanda_itens ?? []).map(i => i.id)))
                      setReimpAberto(true)
                    }}
                    title="Escolher o que sai de novo no papel da cozinha"
                    style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', borderRadius: 999,
                      cursor: reimprimindo ? 'wait' : 'pointer',
                      border: '1.5px solid var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>
                    {reimprimindo ? '🖨️ ...' : '🖨️ Reimprimir'}
                  </button>
                )}
                {!semCozinha && (comandaSel.comanda_itens ?? []).some(i => i.status !== 'pronto' && i.status !== 'entregue') && (
                  <button type="button" onClick={marcarTudoPronto}
                    style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                      border: '1.5px solid #3b82f6', background: 'rgba(59,130,246,.12)', color: '#2563eb' }}>
                    🔔 Marcar tudo pronto
                  </button>
                )}
                </div>
              </div>

              {/* A térmica Bluetooth cai sozinha (celular longe, tela apagada).
                  Antes a tela limpava igual e o garçom ia embora achando que a
                  cozinha tinha recebido — o pedido sumia no caminho. */}
              {avisoImpressao && (
                <div style={{
                  marginBottom: 10, padding: '10px 12px', borderRadius: 10,
                  border: '1.5px solid #ef4444', background: 'rgba(239,68,68,.12)',
                }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: '#ef4444', lineHeight: 1.35 }}>
                    ⚠️ {avisoImpressao.motivo ? 'O papel não saiu NESTE aparelho' : 'O papel NÃO saiu na cozinha'}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '3px 0 8px', lineHeight: 1.4 }}>
                    {avisoImpressao.motivo
                      ? avisoImpressao.motivo
                      : `Os ${avisoImpressao.itens.length} item(ns) foram lançados na comanda, mas a impressora não respondeu. Confira se ela está ligada e pareada.`}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => reimprimir(avisoImpressao.itens)} disabled={reimprimindo}
                      style={{ padding: '7px 14px', borderRadius: 8, cursor: reimprimindo ? 'wait' : 'pointer',
                        border: 'none', background: '#ef4444', color: '#fff', fontWeight: 800, fontSize: 13 }}>
                      {reimprimindo ? 'Tentando...' : '🖨️ Tentar de novo'}
                    </button>
                    <button type="button" onClick={() => setAvisoImpressao(null)}
                      style={{ padding: '7px 14px', borderRadius: 8, cursor: 'pointer',
                        border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 13 }}>
                      Já avisei a cozinha
                    </button>
                  </div>
                </div>
              )}
              {/* PIX esperando nesta mesa (mig 0193). Fica aqui, e não numa tela
                  por cima de tudo, porque o garçom mostra o QR e SAI — vai
                  atender outra mesa enquanto o cliente paga. Quando cair, a
                  conta fecha sozinha e a mesa some do salão. */}
              {pixJaPago > 0 && pixAbertos.length > 0 && (
                <div style={{ marginBottom: 8, padding: '8px 12px', borderRadius: 10, fontSize: 13, fontWeight: 700,
                  border: '1px solid #22c55e', background: 'rgba(34,197,94,.12)', color: '#16a34a' }}>
                  ✅ Já caiu {fmt(pixJaPago)} em PIX nesta mesa — falta o resto pra fechar.
                </div>
              )}
              {pixAbertos.map(pixDaMesa => (
                <div key={pixDaMesa.id} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, padding: 10,
                  borderRadius: 12, border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.10)' }}>
                  {pixDaMesa.qr_base64 && (
                    <button type="button" onClick={() => setPixAmpliado({ ...pixDaMesa, cobranca_id: pixDaMesa.id })}
                      title="Mostrar grande pro cliente"
                      style={{ border: 'none', padding: 0, borderRadius: 8, cursor: 'pointer', background: '#fff', flexShrink: 0 }}>
                      {/* Grande o bastante pra escanear AQUI. Miniatura de indicador
                          não serve: o cliente aponta a câmera e não lê. */}
                      <img src={`data:image/png;base64,${pixDaMesa.qr_base64}`} alt="QR do PIX"
                        style={{ width: 'clamp(150px, 42vw, 200px)', height: 'auto', display: 'block', borderRadius: 8, padding: 6 }} />
                    </button>
                  )}
                  <div style={{ flex: '1 1 190px', minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 15 }}>
                      ⚡ PIX de {fmt(Number(pixDaMesa.valor))} esperando
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2 }}>
                      {pixDaMesaTodos.length > 1
                        ? 'Parte da conta rachada. A mesa fecha sozinha quando todas as partes caírem.'
                        : 'Pode fechar a mesa e ir atender outra. Quando o pagamento cair, a conta fecha sozinha e a mesa fica livre.'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 7 }}>
                      <button type="button" onClick={() => setPixAmpliado({ ...pixDaMesa, cobranca_id: pixDaMesa.id })}
                        style={{ fontSize: 12, fontWeight: 800, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                          border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.15)', color: '#16a34a' }}>
                        🔍 Mostrar pro cliente
                      </button>
                      <button type="button" onClick={() => cancelarPixOnline(pixDaMesa.id)}
                        style={{ fontSize: 12, fontWeight: 700, padding: '5px 12px', borderRadius: 999, cursor: 'pointer',
                          border: '1.5px solid var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>
                        Cancelar PIX
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {(comandaSel.comanda_itens ?? []).length === 0 ? (
                <p className="sal-vazio" style={{ fontSize: 14, color: 'var(--text-muted)' }}>Nenhum item ainda — lance o primeiro produto.</p>
              ) : (
                (comandaSel.comanda_itens ?? [])
                  .slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                  .map(item => (
                    <div key={item.id} className="sal-item" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div className="sal-item-nome" style={{ fontSize: 15.5, fontWeight: 700 }}>{item.nome}</div>
                          <div className="sal-item-sub" style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <span>
                              {fmt(item.preco_unitario)} · {
                                item.status === 'pronto' ? '🔔 pronto'
                                : item.status === 'entregue'
                                  ? `🍽️ entregue${item.entregue_por && garcons[item.entregue_por] ? ' por ' + garcons[item.entregue_por].split(' ')[0] : ''}`
                                : '⏳ preparando'
                              }
                            </span>
                            {item.status !== 'pronto' && item.status !== 'entregue' && (
                              <button type="button" onClick={() => marcarItemPronto(item)}
                                style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                                  border: '1.5px solid #3b82f6', background: 'rgba(59,130,246,.15)', color: '#2563eb' }}>
                                🔔 Marcar pronto
                              </button>
                            )}
                            {item.status === 'pronto' && (
                              <button type="button" onClick={() => entregarItem(item)}
                                style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                                  border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.15)', color: '#16a34a' }}>
                                Marcar entregue
                              </button>
                            )}
                          </div>
                        </div>
                        <button type="button" onClick={() => mudarQtd(item, -1)} style={qtdBtn}>−</button>
                        <input type="number" min="0" inputMode="numeric"
                          className="sal-item-qtd sal-item-qtd-inp"
                          aria-label={`Quantidade de ${item.nome}`}
                          value={qtdEdit[item.id] ?? item.quantidade}
                          onFocus={e => e.target.select()}
                          onChange={e => setQtdEdit(prev => ({ ...prev, [item.id]: e.target.value }))}
                          onBlur={e => { definirQtd(item, e.target.value); setQtdEdit(prev => { const n = { ...prev }; delete n[item.id]; return n }) }}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} />
                        <button type="button" onClick={() => mudarQtd(item, +1)} style={qtdBtn}>+</button>
                        {precoEdit[item.id] !== undefined ? (
                          <input
                            autoFocus type="text" inputMode="decimal"
                            value={precoEdit[item.id]}
                            onChange={e => setPrecoEdit(prev => ({ ...prev, [item.id]: maskMoeda(e.target.value) }))}
                            onBlur={() => salvarPreco(item)}
                            onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); else if (e.key === 'Escape') setPrecoEdit(prev => { const n = { ...prev }; delete n[item.id]; return n }) }}
                            placeholder="0,00"
                            style={{ minWidth: 70, width: 70, padding: '4px 6px', fontSize: 13, borderRadius: 6, textAlign: 'right',
                              border: '1.5px solid var(--primary)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }}
                          />
                        ) : ehAdmin ? (
                          <button type="button" title="Editar preço deste item"
                            onClick={() => setPrecoEdit(prev => ({ ...prev, [item.id]: Number(item.preco_unitario) > 0 ? numeroParaMoeda(item.preco_unitario) : '' }))}
                            style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
                              border: '1px dashed var(--border)', borderRadius: 6, padding: '3px 6px', background: 'transparent', color: 'var(--text)' }}>
                            {fmt(item.preco_unitario * item.quantidade)} ✎
                          </button>
                        ) : (
                          <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                            {fmt(item.preco_unitario * item.quantidade)}
                          </span>
                        )}
                      </div>
                      {/* Item já enviado NÃO tem campo de observação: o papel da
                          cozinha já saiu e nada escrito aqui chega em quem está
                          cozinhando. Era um campo que só dava a impressão de estar
                          avisando alguém. O recado se escreve ANTES de enviar, na
                          linha do rascunho.
                          O que já foi escrito continua à vista, só que como texto. */}
                      {item.observacao && (
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-muted)', marginTop: 5 }}>
                          📝 {item.observacao}
                        </div>
                      )}
                    </div>
                  ))
              )}

              {/* A enviar (rascunho) — ainda não foi pra cozinha */}
              {rascunho.length > 0 && (
                <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: '1.5px dashed var(--primary)', background: 'rgba(124,58,237,.06)' }}>
                  <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8, color: 'var(--primary)' }}>
                    🧾 A enviar — ainda não foi pra cozinha
                  </div>
                  {rascunho.map(r => (
                    <div key={r.linha ?? r.produto_id} style={{ padding: '5px 0' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 15.5, fontWeight: 700 }}>{r.nome}</div>
                          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{fmt(r.preco_venda)}</div>
                        </div>
                        <button type="button" onClick={() => mudarQtdRascunho(r.linha ?? String(r.produto_id), -1)} style={qtdBtn}>−</button>
                        <input type="number" min="0" inputMode="numeric"
                          className="sal-item-qtd-inp"
                          aria-label={`Quantidade de ${r.nome}`}
                          value={qtdEdit[r.linha ?? String(r.produto_id)] ?? r.quantidade}
                          onFocus={e => e.target.select()}
                          onChange={e => setQtdEdit(prev => ({ ...prev, [r.linha ?? String(r.produto_id)]: e.target.value }))}
                          onBlur={e => { definirQtdRascunho(r.linha ?? String(r.produto_id), e.target.value); setQtdEdit(prev => { const n = { ...prev }; delete n[r.linha ?? String(r.produto_id)]; return n }) }}
                          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }} />
                        <button type="button" onClick={() => mudarQtdRascunho(r.linha ?? String(r.produto_id), +1)} style={qtdBtn}>+</button>
                        {precoRascEdit[r.linha ?? String(r.produto_id)] !== undefined ? (
                          <input
                            autoFocus type="text" inputMode="decimal"
                            value={precoRascEdit[r.linha ?? String(r.produto_id)]}
                            onChange={e => setPrecoRascEdit(prev => ({ ...prev, [r.linha ?? String(r.produto_id)]: maskMoeda(e.target.value) }))}
                            onBlur={() => salvarPrecoRascunho(r.linha ?? String(r.produto_id))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') e.target.blur()
                              else if (e.key === 'Escape') setPrecoRascEdit(prev => { const n = { ...prev }; delete n[r.linha ?? String(r.produto_id)]; return n })
                            }}
                            placeholder="0,00"
                            style={{ minWidth: 70, width: 70, padding: '4px 6px', fontSize: 13, borderRadius: 6, textAlign: 'right',
                              border: '1.5px solid var(--primary)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)' }}
                          />
                        ) : ehAdmin ? (
                          <button type="button" title="Digitar o preço deste item (ex: o valor que deu no peso)"
                            onClick={() => setPrecoRascEdit(prev => ({ ...prev, [r.linha ?? String(r.produto_id)]: Number(r.preco_venda) > 0 ? numeroParaMoeda(r.preco_venda) : '' }))}
                            style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
                              border: '1px dashed var(--border)', borderRadius: 6, padding: '3px 6px', background: 'transparent', color: 'var(--text)' }}>
                            {fmt(r.preco_venda * r.quantidade)} ✎
                          </button>
                        ) : (
                          // Garçom vê o valor, não mexe — mesma regra do item já enviado.
                          <span style={{ minWidth: 70, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>
                            {fmt(r.preco_venda * r.quantidade)}
                          </span>
                        )}
                      </div>
                      <input
                        value={r.observacao ?? ''}
                        onChange={e => mudarObsRascunho(r.linha ?? String(r.produto_id), e.target.value)}
                        placeholder="📝 Observação (ex: sem cebola, ponto da carne...)"
                        style={{
                          width: '100%', marginTop: 6, padding: '8px 10px', fontSize: 14.5, fontWeight: 600, boxSizing: 'border-box',
                          borderRadius: 8, border: '1px solid var(--border)',
                          background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}

              {comandaSel.status !== 'aguardando_conferencia' && (
                <button type="button" className="sal-btn-lancar sal-so-mobile" onClick={() => setAbaMesa('add')}>
                  ➕ Lançar produtos
                </button>
              )}

            </div>

            <div className="sal-col sal-col--add">
              {/* No celular esta coluna É a tela: o caminho de volta pra comanda
                  fica grudado no topo, com o que já está no rascunho à vista. */}
              <button type="button" className="sal-btn-voltar sal-so-mobile" onClick={() => setAbaMesa('comanda')}>
                ← Ver a comanda{rascunho.length > 0 ? ` · ${rascunho.reduce((n, r) => n + r.quantidade, 0)} a enviar` : ''}
              </button>
              {/* adicionar item */}
              <div className="sal-titulo-add sal-titulo-col" style={{ fontSize: 15, fontWeight: 700, margin: '18px 0 8px' }}>Adicionar item</div>

              {/* ── Inventar produto (item fora do catálogo) ── */}
              {!invAberto ? (
                <button type="button" className="sal-inv-abrir" onClick={() => setInvAberto(true)}
                  style={{ width: '100%', padding: '9px 0', borderRadius: 8, marginBottom: 8, cursor: 'pointer',
                    border: '1.5px dashed var(--primary)', background: 'rgba(124,58,237,.06)', color: 'var(--primary)', fontSize: 14.5, fontWeight: 700 }}>
                  ➕ Inventar produto
                </button>
              ) : (
                <div className="sal-inv">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--primary)' }}>➕ Inventar produto</span>
                    <button type="button" onClick={() => { setInvAberto(false); setInvNome(''); setInvPreco(''); setInvCatalogo(false); setInvCategoria(''); setInvCatNova(false) }}
                      style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
                  </div>
                  <input value={invNome} onChange={e => setInvNome(e.target.value)} placeholder="Nome do produto"
                    style={{ width: '100%', padding: '11px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 16, boxSizing: 'border-box' }} />
                  {invNomeExiste && (
                    <div style={{ fontSize: 12, color: '#d97706', fontWeight: 700, marginTop: 5 }}>
                      ⚠️ Já existe um produto com esse nome.
                    </div>
                  )}
                  <input value={invPreco} onChange={e => setInvPreco(maskMoeda(e.target.value))} type="text" inputMode="decimal" placeholder="Preço (ex: 12,00)"
                    style={{ width: '100%', marginTop: 8, padding: '11px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 16, boxSizing: 'border-box' }} />

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12.5, color: 'var(--text)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={invCatalogo} onChange={e => setInvCatalogo(e.target.checked)} style={{ width: 16, height: 16 }} />
                    Adicionar ao catálogo (fica salvo pras próximas vendas)
                  </label>
                  {invCatalogo && (
                    <>
                      <select
                        value={invCatNova ? '__nova__' : invCategoria}
                        onChange={e => {
                          const v = e.target.value
                          if (v === '__nova__') { setInvCatNova(true); setInvCategoria('') }
                          else { setInvCatNova(false); setInvCategoria(v) }
                        }}
                        style={{ width: '100%', marginTop: 8, padding: '11px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 16, boxSizing: 'border-box' }}>
                        <option value="">Escolha a categoria</option>
                        {categorias.map(c => <option key={c} value={c}>{c}</option>)}
                        <option value="__nova__">➕ Criar categoria nova</option>
                      </select>
                      {invCatNova && (
                        <input value={invCategoria} onChange={e => setInvCategoria(e.target.value)} placeholder="Nome da categoria nova"
                          style={{ width: '100%', marginTop: 8, padding: '11px 10px', borderRadius: 8, border: '1px solid var(--primary)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 16, boxSizing: 'border-box' }} />
                      )}
                    </>
                  )}

                  <button type="button" onClick={adicionarInventado} disabled={invSalvando}
                    style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 8, cursor: invSalvando ? 'wait' : 'pointer',
                      border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 13, fontWeight: 800, opacity: invSalvando ? .6 : 1 }}>
                    {invSalvando ? 'Salvando...' : (invCatalogo ? 'Salvar no catálogo e adicionar' : 'Adicionar só nesta venda')}
                  </button>
                </div>
              )}

              {/* Busca + resultados moram juntos porque no celular os dois viram
                  TELA CHEIA quando há texto digitado — mesma receita do
                  "Inventar produto" (ver .sal-busca-painel no CSS). */}
              <div className="sal-busca-painel" data-buscando={busca.trim() ? '1' : undefined}>
              {/* Barra de volta: só existe no modo tela cheia. Sem ela o garçom
                  fica sem saída — o "← Ver a comanda" está atrás do painel. E o
                  contador é o único sinal de que o toque no produto pegou. */}
              <div className="sal-busca-topo">
                <button type="button" onClick={() => { setBusca(''); if (buscaRef.current) buscaRef.current.blur() }}>
                  ← Voltar
                </button>
                {rascunho.length > 0 && (
                  <span>{rascunho.reduce((n, r) => n + r.quantidade, 0)} a enviar · {fmt(subtotalRascunho)}</span>
                )}
              </div>
              <div className="sal-busca" style={{ position: 'relative', marginBottom: 8 }}>
                <input ref={buscaRef} value={busca} onChange={e => setBusca(e.target.value)} onKeyDown={teclaBusca} placeholder="Buscar produto... (↑ ↓ e Enter)"
                  style={{ width: '100%', padding: '10px 38px 10px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', boxSizing: 'border-box', fontSize: 14.5 }} />
                {busca && (
                  <button type="button" title="Limpar" aria-label="Limpar busca"
                    onClick={() => { setBusca(''); if (buscaRef.current) buscaRef.current.focus() }}
                    style={{
                      position: 'absolute', top: '50%', right: 6, transform: 'translateY(-50%)',
                      width: 26, height: 26, borderRadius: 999, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: 'none', background: 'var(--border)', color: 'var(--text)', fontSize: 15, fontWeight: 800, lineHeight: 1,
                    }}>×</button>
                )}
              </div>
              {/* Sem busca e sem categoria escolhida: mostra as CATEGORIAS (como no cardápio). */}
              {!busca.trim() && !categoriaSel && (
                <div className="sal-cats">
                  {categorias.map(cat => (
                    <button key={cat} type="button" className="sal-cat" onClick={() => setCategoriaSel(cat)}>
                      <span className="sal-cat-nome">{cat}</span>
                      <span className="sal-cat-qtd">{qtdPorCategoria[cat]}</span>
                      <span className="sal-cat-seta" aria-hidden="true">›</span>
                    </button>
                  ))}
                  {categorias.length === 0 && <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>Nenhuma categoria com produtos.</p>}
                </div>
              )}

              {/* Categoria escolhida (e sem busca): botão de voltar + produtos dela. */}
              {!busca.trim() && categoriaSel && (
                <button type="button" onClick={() => setCategoriaSel(null)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginBottom: 8, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--primary)', fontSize: 14.5, fontWeight: 700 }}>
                  ← {categoriaSel}
                </button>
              )}

              {/* Produtos: quando há busca OU quando uma categoria está aberta. */}
              {(busca.trim() || categoriaSel) && (
                <div className="sal-produtos" ref={listaProdRef}>
                  {produtosFiltrados.map((p, idx) => {
                    const marcado = !!busca && idx === destaque
                    return (
                    <button key={p.produto_id} type="button" onClick={() => addItem(p)}
                      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 48, padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                        border: `1px solid ${marcado ? 'var(--primary)' : 'var(--border)'}`,
                        background: marcado ? 'rgba(124,58,237,.16)' : 'transparent',
                        color: 'var(--text)', textAlign: 'left' }}>
                      <span className="sal-prod-nome" style={{ flex: 1, minWidth: 0, fontSize: 15.5, fontWeight: 600, lineHeight: 1.3 }}>{p.nome}</span>
                      <span className="sal-prod-preco" style={{ flexShrink: 0, whiteSpace: 'nowrap', fontSize: 14.5, fontWeight: 700, color: 'var(--primary)' }}>+ {fmt(p.preco_venda)}</span>
                    </button>
                    )
                  })}
                  {produtosFiltrados.length === 0 && <p className="sal-vazio" style={{ fontSize: 14, color: 'var(--text-muted)' }}>Nenhum produto encontrado.</p>}
                </div>
              )}
              </div>
            </div>
            </div>

            {/* rodapé — sempre à vista (ver .sal-rodape no PresencialSalao.css) */}
            <div className="sal-rodape">
              {/* Recado da cozinha fica AQUI, coladinho no botão de enviar: a observação
                  só sai impressa se for escrita ANTES do envio, então ela não pode estar
                  perdida lá em cima, fora da vista de quem está lançando no celular. */}
              {comandaSel.status !== 'aguardando_conferencia' && (
                <div className="sal-rodape-envio" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={alternarViagem} disabled={salvandoViagem}
                    title="Marca a comanda inteira como pedido para viagem — sai impresso na cozinha"
                    style={{
                      flexShrink: 0, padding: '10px 13px', borderRadius: 999, fontSize: 14.5, fontWeight: 800,
                      cursor: salvandoViagem ? 'wait' : 'pointer',
                      border: `1.5px solid ${comandaSel.para_viagem ? '#d97706' : 'var(--border)'}`,
                      background: comandaSel.para_viagem ? '#d97706' : 'transparent',
                      color: comandaSel.para_viagem ? '#fff' : 'var(--text)',
                    }}>
                    📦 {comandaSel.para_viagem ? 'Para viagem' : 'Viagem?'}
                  </button>
                  {!semCozinha && <input
                    value={obsEnvio}
                    onChange={e => setObsEnvio(e.target.value)}
                    placeholder="📝 Recado pra cozinha (sai impresso)"
                    style={{
                      flex: 1, minWidth: 130, padding: '10px 10px', fontSize: 14.5, fontWeight: 600, boxSizing: 'border-box',
                      borderRadius: 8, border: '1px solid var(--border)',
                      background: 'var(--input-bg, var(--bg))', color: 'var(--text)',
                    }}
                  />}
                </div>
              )}
              {!semCozinha && comandaSel.status !== 'aguardando_conferencia' && rascunho.length > 0 && (comandaSel.para_viagem || obsEnvio.trim()) && (
                <div style={{
                  marginBottom: 8, padding: '7px 10px', borderRadius: 8, fontSize: 13, fontWeight: 800,
                  background: 'rgba(217,119,6,.14)', color: '#d97706',
                }}>
                  A cozinha vai ler: {[comandaSel.para_viagem ? 'PARA VIAGEM' : '', obsEnvio.trim()].filter(Boolean).join(' · ')}
                </div>
              )}
              {!semCozinha && comandaSel.status !== 'aguardando_conferencia' && rascunho.length > 0 && (
                <button type="button" onClick={() => enviarCozinha()} disabled={enviando}
                  style={{ width: '100%', marginBottom: 12, padding: '12px 0', borderRadius: 10, border: 'none', cursor: enviando ? 'wait' : 'pointer',
                    background: '#16a34a', color: '#fff', fontWeight: 800, fontSize: 15, opacity: enviando ? 0.6 : 1 }}>
                  {enviando ? 'Enviando...' : `🍳 Enviar para a cozinha · ${rascunho.reduce((s, r) => s + r.quantidade, 0)} item(ns) · ${fmt(subtotalRascunho)}`}
                </button>
              )}
              <div className="sal-rodape-subtotal" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15.5, marginBottom: 4 }}>
                <span>Subtotal</span><strong>{fmt(subtotalSel)}</strong>
              </div>
              {/* Loja que cobra serviço: o rodapé mostrava só o subtotal, e o ADM
                  conferia a mesa azul por um valor MENOR do que o cliente pagou.
                  A conta certa só aparecia dentro do fechamento. */}
              {taxaSel > 0 && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: 'var(--text-muted)', marginBottom: 4 }}>
                    <span>Serviço ({taxaPct}%)</span><span>{fmt(taxaSel)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 16.5, marginBottom: 6 }}>
                    <span style={{ fontWeight: 800 }}>Total</span>
                    <strong style={{ color: 'var(--primary)' }}>{fmt(totalSel)}</strong>
                  </div>
                </>
              )}
              {comandaSel.status === 'aguardando_conferencia' ? (
                <div>
                  <div style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(59,130,246,.16)', color: '#2563eb', fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
                    🔵 Conta fechada pelo garçom — aguardando o ADM conferir o pagamento e liberar a mesa.
                  </div>
                  {/* Segunda via: fica FORA do bloco do ADM porque quem perde o
                      papel é o garçom — a térmica dele caiu do Bluetooth na hora
                      do fechamento e a conta não saiu. Antes o único jeito era
                      cancelar a mesa e lançar tudo de novo. */}
                  <button type="button" onClick={reimprimirConta}
                    style={{ width: '100%', marginBottom: 8, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
                      fontSize: 14.5, fontWeight: 700 }}>
                    🖨️ Imprimir a conta de novo
                  </button>
                  {preContaMsg && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', marginBottom: 8 }}>{preContaMsg}</div>
                  )}
                  {ehAdmin ? (
                    <div className="sal-acoes">
                      <button type="button" onClick={cancelarMesa}
                        className="sal-acao-icone" title="Cancelar a comanda" aria-label="Cancelar a comanda"
                        style={{ borderRadius: 10, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                        ✕<span className="sal-acao-txt">Cancelar</span>
                      </button>
                      {subtotalSel > 0 && (
                        <button type="button" onClick={abrirFechamento}
                          style={{ flex: '0 0 auto', padding: '0 14px', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                          Revisar
                        </button>
                      )}
                      <button type="button" onClick={confirmarLiberarAdm} disabled={salvando}
                        className="btn btn-primary sal-acao-principal" style={{ marginTop: 0 }}>
                        {salvando ? 'Liberando...' : (subtotalSel <= 0 ? '✅ Liberar mesa (sem itens)' : '✅ Confirmar e liberar mesa')}
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
                      Aguardando o administrador liberar a mesa.
                    </div>
                  )}
                </div>
              ) : (
                <div>
                  <div className="sal-acoes">
                    <button type="button" onClick={cancelarMesa}
                      className="sal-acao-icone" title="Cancelar a comanda" aria-label="Cancelar a comanda"
                      style={{ borderRadius: 10, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                      ✕<span className="sal-acao-txt">Cancelar</span>
                    </button>
                    {/* Cliente mudou de lugar: leva a comanda junto, com tudo
                        que já consumiu.
                        Vale também na comanda de NOME — o cliente abre a conta no
                        balcão e depois senta numa mesa. Só o card fixo "Balcão"
                        fica de fora, porque ele não é uma conta que anda. */}
                    {!mesaSel?.is_balcao && (
                      <button type="button" onClick={() => { setMoverErro(''); setMoverNome(comandaSel?.cliente?.nome || comandaSel?.nome_cliente || ''); setMovendo(true) }}
                        className="sal-acao-icone"
                        title={mesaSel?.is_comanda ? 'Pôr esta conta numa mesa' : 'Trocar de mesa'}
                        aria-label={mesaSel?.is_comanda ? 'Pôr numa mesa' : 'Trocar de mesa'}
                        style={{ borderRadius: 10, border: '1px solid var(--border)',
                          background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                        ↔<span className="sal-acao-txt">{mesaSel?.is_comanda ? 'Pôr numa mesa' : 'Trocar mesa'}</span>
                      </button>
                    )}
                    {/* Pré-conta: o cliente vê o que consumiu e quanto deu ANTES
                        de decidir como paga. Não fecha nada. */}
                    <button type="button" onClick={imprimirPreConta} disabled={subtotalSel <= 0}
                      className="sal-acao-icone"
                      title="Imprimir a conta pra mesa conferir, sem fechar"
                      aria-label="Imprimir pré-conta"
                      style={{ borderRadius: 10, border: '1px solid var(--border)',
                        background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
                      🖨️<span className="sal-acao-txt">Pré-conta</span>
                    </button>
                    {/* Mesma pré-conta, no zap do cliente: loja sem impressora
                        manda o cliente conferir pelo próprio celular. */}
                    <button type="button" onClick={mandarPreContaZap}
                      disabled={subtotalSel <= 0 || enviandoZap}
                      className="sal-acao-icone"
                      title={comandaSel?.cliente?.telefone
                        ? `Mandar a conta no WhatsApp de ${comandaSel.cliente.nome}`
                        : 'Ligue um cliente à comanda pra poder mandar'}
                      aria-label="Mandar a pré-conta no WhatsApp"
                      style={{ borderRadius: 10, border: '1px solid #16a34a',
                        background: 'rgba(22,163,74,.12)', color: '#16a34a', cursor: 'pointer' }}>
                      {enviandoZap ? '…' : <IconeZap />}
                      <span className="sal-acao-txt">{enviandoZap ? 'Enviando…' : 'Mandar no zap'}</span>
                    </button>
                    <button type="button" onClick={abrirFechamento} disabled={subtotalSel <= 0}
                      className="btn btn-primary sal-acao-principal" style={{ marginTop: 0, opacity: subtotalSel <= 0 ? 0.5 : 1 }}>
                      Fechar conta
                    </button>
                  </div>
                  {preContaMsg && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', marginTop: 6 }}>{preContaMsg}</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trilha da mesa: item por item, quem lancou e quem entregou, com hora.
          "Quem fechou" nao aparece de proposito — a conta ainda esta aberta. */}
      {/* ── Escolher o que reimprimir ───────────────────────────────────────
          Antes o botão mandava a comanda inteira de uma vez. Quando falta UM
          item (o cozinheiro perdeu a folha, saiu borrado), reimprimir tudo faz
          a cozinha refazer o que já está pronto. */}
      {reimpAberto && comandaSel && (() => {
        const itens = comandaSel.comanda_itens ?? []
        // Categoria marcada como "não imprime" (as bebidas da Saidera, por
        // exemplo) não vira papel em impressora nenhuma — mostrar como
        // escolhível seria prometer um papel que não sai.
        const semPapel = i => i.setor === 'nenhum'
        const alternar = id => setReimpSel(prev => {
          const n = new Set(prev)
          if (n.has(id)) n.delete(id); else n.add(id)
          return n
        })
        const marcados = itens.filter(i => reimpSel.has(i.id) && !semPapel(i))
        return (
        <div onClick={() => !reimprimindo && setReimpAberto(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} className="sal-separar"
            style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column',
              background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)' }}>

            <div style={{ flexShrink: 0, padding: '20px 22px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 19, fontWeight: 800 }}>Reimprimir</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
                Marque o que precisa sair de novo no papel.
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 22px' }}>
              {itens.map(i => {
                const nada = semPapel(i)
                const marcado = !nada && reimpSel.has(i.id)
                return (
                  <button key={i.id} type="button" disabled={nada} onClick={() => alternar(i.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                      padding: '10px 12px', marginBottom: 6, borderRadius: 10,
                      cursor: nada ? 'default' : 'pointer', opacity: nada ? .45 : 1,
                      border: `1.5px solid ${marcado ? 'var(--primary)' : 'var(--border)'}`,
                      background: marcado ? 'rgba(124,58,237,.12)' : 'transparent', color: 'var(--text)' }}>
                    <span style={{ width: 20, height: 20, flexShrink: 0, borderRadius: 6,
                      border: `2px solid ${marcado ? 'var(--primary)' : '#64748b'}`,
                      background: marcado ? 'var(--primary)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 13, fontWeight: 900 }}>{marcado ? '✓' : ''}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>{i.quantidade}× {i.nome}</span>
                      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-muted)' }}>
                        {nada ? 'categoria marcada como "não imprime"' : (i.setor === 'cozinha' ? 'cozinha' : 'salão')}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div style={{ flexShrink: 0, padding: '12px 22px 20px', borderTop: '1px solid var(--border)' }}>
              <button type="button" disabled={reimprimindo || marcados.length === 0}
                onClick={() => { setReimpAberto(false); reimprimir(marcados) }}
                style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: 'none',
                  cursor: reimprimindo ? 'wait' : 'pointer', background: 'var(--primary)', color: '#fff',
                  fontWeight: 800, fontSize: 15.5, opacity: marcados.length === 0 ? .5 : 1 }}>
                {reimprimindo ? 'Imprimindo...' : `🖨️ Reimprimir ${marcados.length} item(ns)`}
              </button>
              <button type="button" onClick={() => setReimpAberto(false)} disabled={reimprimindo}
                style={{ width: '100%', marginTop: 8, padding: '12px 0', borderRadius: 12, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 800, fontSize: 15 }}>
                Voltar
              </button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* ── Separar a conta de quem vai embora (mig 0205) ──────────────────
          Marca o que é dela, escreve o nome, e os itens viram uma comanda
          própria. A mesa continua aberta com o resto. */}
      {separando && comandaSel && (() => {
        const itens = comandaSel.comanda_itens ?? []
        // Só conta o que ela vai levar: 3 de 6 litrinhos cobra 3, não 6.
        const totalSep = itens.reduce((s, i) => s + Number(i.preco_unitario || 0) * (sepSel.get(i.id) ?? 0), 0)
        const unidSep = [...sepSel.values()].reduce((s, q) => s + q, 0)
        // Clicar na linha marca a linha INTEIRA (é o caso comum, e é como era
        // antes); quem leva só uma parte desce no "−".
        const alternar = (id, max) => setSepSel(prev => {
          const n = new Map(prev)
          if (n.has(id)) n.delete(id); else n.set(id, max)
          return n
        })
        const mudarQtd = (id, delta, max) => setSepSel(prev => {
          const n = new Map(prev)
          const novo = Math.min(max, Math.max(0, (n.get(id) ?? 0) + delta))
          if (novo === 0) n.delete(id); else n.set(id, novo)
          return n
        })
        return (
        <div onClick={() => !sepBusy && setSeparando(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} className="sal-separar"
            style={{ width: '100%', maxWidth: 520, maxHeight: '88vh', display: 'flex', flexDirection: 'column',
              background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)' }}>

            <div style={{ flexShrink: 0, padding: '20px 22px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 19, fontWeight: 800 }}>Separar conta</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>
                Marque o que é dela. Esses itens saem da {rotuloMesa(mesaSel)} e viram
                uma comanda no nome dela — a mesa continua aberta com o resto.
                Se ela leva só parte (3 das 6), use o − depois de marcar.
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 22px' }}>
              {itens.map(i => {
                const max = Math.max(1, Number(i.quantidade || 1))
                const sel = sepSel.get(i.id) ?? 0
                const marcado = sel > 0
                // Div e não button: dentro dela moram os botões de − e +, e
                // botão dentro de botão o navegador ignora.
                return (
                  <div key={i.id} role="button" tabIndex={0}
                    onClick={() => alternar(i.id, max)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(i.id, max) } }}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                      padding: '10px 12px', marginBottom: 6, borderRadius: 10, cursor: 'pointer', boxSizing: 'border-box',
                      border: `1.5px solid ${marcado ? 'var(--primary)' : 'var(--border)'}`,
                      background: marcado ? 'rgba(124,58,237,.12)' : 'transparent', color: 'var(--text)' }}>
                    <span style={{ width: 20, height: 20, flexShrink: 0, borderRadius: 6,
                      border: `2px solid ${marcado ? 'var(--primary)' : '#64748b'}`,
                      background: marcado ? 'var(--primary)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#fff', fontSize: 13, fontWeight: 900 }}>{marcado ? '✓' : ''}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: 15, fontWeight: 700 }}>
                        {marcado && max > 1 ? `${sel} de ${max}` : `${max}×`} {i.nome}
                      </span>
                      <span style={{ display: 'block', fontSize: 12.5, color: 'var(--text-muted)' }}>{fmt(i.preco_unitario)} cada</span>
                    </span>
                    {/* Só na linha com mais de uma unidade: "ele leva 3 das 6". */}
                    {max > 1 && marcado && (
                      <span onClick={e => e.stopPropagation()}
                        style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                        <button type="button" onClick={() => mudarQtd(i.id, -1, max)} disabled={sel <= 1}
                          aria-label="Menos um" style={{ width: 30, height: 30, borderRadius: 8, fontSize: 17, fontWeight: 900,
                            lineHeight: 1, padding: 0, cursor: sel <= 1 ? 'default' : 'pointer', opacity: sel <= 1 ? .35 : 1,
                            border: '1.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>−</button>
                        <span style={{ minWidth: 22, textAlign: 'center', fontSize: 15, fontWeight: 800 }}>{sel}</span>
                        <button type="button" onClick={() => mudarQtd(i.id, +1, max)} disabled={sel >= max}
                          aria-label="Mais um" style={{ width: 30, height: 30, borderRadius: 8, fontSize: 17, fontWeight: 900,
                            lineHeight: 1, padding: 0, cursor: sel >= max ? 'default' : 'pointer', opacity: sel >= max ? .35 : 1,
                            border: '1.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}>+</button>
                      </span>
                    )}
                    <span style={{ fontSize: 15, fontWeight: 800, whiteSpace: 'nowrap' }}>
                      {fmt(Number(i.preco_unitario || 0) * (marcado ? sel : max))}
                    </span>
                  </div>
                )
              })}
            </div>

            <div style={{ flexShrink: 0, padding: '12px 22px 20px', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                marginBottom: 10, fontSize: 13, fontWeight: 800, letterSpacing: .5, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                <span>Conta dela · {unidSep} item(ns)</span>
                <span style={{ fontSize: 26, fontWeight: 900, color: 'var(--primary)' }}>{fmt(totalSep)}</span>
              </div>
              <input value={sepNome} onChange={e => setSepNome(e.target.value)}
                placeholder="Nome de quem vai levar a conta" disabled={sepBusy}
                style={{ width: '100%', padding: '11px 12px', borderRadius: 10, boxSizing: 'border-box', marginBottom: 8,
                  border: '1.5px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 15 }} />
              {sepErro && (
                <div style={{ fontSize: 13.5, color: 'var(--danger, #ef4444)', marginBottom: 8, lineHeight: 1.4 }}>{sepErro}</div>
              )}
              <button type="button" onClick={separar} disabled={sepBusy}
                style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: 'none',
                  cursor: sepBusy ? 'wait' : 'pointer', background: 'var(--primary)', color: '#fff',
                  fontWeight: 800, fontSize: 15.5 }}>
                {sepBusy ? 'Separando...' : 'Separar e abrir a conta dela'}
              </button>
              <button type="button" onClick={() => setSeparando(false)} disabled={sepBusy}
                style={{ width: '100%', marginTop: 8, padding: '12px 0', borderRadius: 12, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 800, fontSize: 15 }}>
                Voltar
              </button>
            </div>
          </div>
        </div>
        )
      })()}

      {/* zIndex 1100 e não 300: a gaveta do salão é 900, então com camada menor
          este painel abria ATRÁS dela — o garçom clicava no botão e não
          acontecia nada. */}
      {verMovimentos && comandaSel && (
        <div onClick={() => setVerMovimentos(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1100,
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div onClick={ev => ev.stopPropagation()}
            style={{ width: '100%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto',
              background: 'var(--surface, var(--bg))', borderRadius: '16px 16px 0 0',
              border: '1px solid var(--border)', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
              <strong style={{ fontSize: 16 }}>🕑 Quem fez o quê</strong>
              <button type="button" onClick={() => setVerMovimentos(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, lineHeight: 1, color: 'var(--text-muted)' }}>×</button>
            </div>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              {mesaSel?.is_comanda ? rotuloMesa(mesaSel) : `Mesa ${mesaSel?.numero}`} · confira antes de fechar.
              Item errado tem que sair da conta agora.
            </p>

            {[...(comandaSel.comanda_itens ?? [])]
              .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
              .map(it => (
                <div key={it.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <strong style={{ fontSize: 13.5 }}>
                      {it.quantidade}× {it.nome}
                      {itemIsento(it) && (
                        <span style={{ fontWeight: 600, fontSize: 11.5, color: 'var(--text-muted)' }}> {MARCA_ISENTO}</span>
                      )}
                    </strong>
                    <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {fmt(Number(it.preco_unitario) * it.quantidade)}
                    </span>
                  </div>
                  {it.observacao && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>📝 {it.observacao}</div>
                  )}
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.6 }}>
                    <div>
                      ✍️ <strong style={{ color: 'var(--text)' }}>
                        {it.lancado_por ? (garcons[it.lancado_por] ?? 'alguém') : 'não registrado'}
                      </strong> lançou{it.created_at ? ` · ${horaCurta(it.created_at)}` : ''}
                    </div>
                    {it.status === 'entregue' ? (
                      <div>
                        🍽️ <strong style={{ color: 'var(--text)' }}>
                          {it.entregue_por ? (garcons[it.entregue_por] ?? 'alguém') : 'não registrado'}
                        </strong> entregou{it.entregue_at ? ` · ${horaCurta(it.entregue_at)}` : ''}
                      </div>
                    ) : (
                      <div style={{ color: it.status === 'pronto' ? '#16a34a' : 'var(--text-muted)' }}>
                        {it.status === 'pronto' ? '🔔 pronto, ainda não entregue' : '⏳ ainda não saiu'}
                      </div>
                    )}
                  </div>
                </div>
              ))}

            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.45 }}>
              Quem fechou a conta só aparece depois de fechada, em <strong>Vendas salão</strong>.
              Item lançado antes de 23/08/2026 não tem o "lançou" gravado.
            </div>
          </div>
        </div>
      )}

      {/* ── Modal de complementos (monta o item antes de ir pro rascunho) ── */}
      {montando && (
        <ModalComplementos
          produto={montando}
          grupos={compMap[montando.produto_id] ?? []}
          semObrigatorios={semObrigatorios}
          onCancelar={() => setMontando(null)}
          onConfirmar={(escolhas, qtdItem) => addMontado(montando, escolhas, qtdItem)}
        />
      )}

      {/* ── Fiado: quem está devendo (lista + receber) ── */}
      {showFiado && (
        <div className="modal-overlay" onClick={() => setShowFiado(false)} style={{ zIndex: 1100 }}>
          <div className="modal" onClick={e => e.stopPropagation()}
            style={{ maxWidth: 760, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
              <h2 style={{ margin: 0 }}>💳 Fiado — quem está devendo</h2>
              <button type="button" onClick={() => setShowFiado(false)}
                style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
            </div>
            <ClientesFiado empresaId={empresaId} />
          </div>
        </div>
      )}

      {/* ── Consumo de funcionários (alimentação) ── */}
      {showConsumoFunc && (
        <div className="modal-overlay" onClick={() => setShowConsumoFunc(false)} style={{ zIndex: 1100 }}>
          <div className="modal" onClick={e => e.stopPropagation()}
            style={{ maxWidth: 760, width: '100%', maxHeight: '88vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
              <h2 style={{ margin: 0 }}>🍽️ Consumo de funcionários</h2>
              <button type="button" onClick={() => setShowConsumoFunc(false)}
                style={{ background: 'none', border: 'none', fontSize: 24, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
            </div>
            <ConsumoFuncionario empresaId={empresaId} />
          </div>
        </div>
      )}

      {/* ── Cancelar a mesa: a pergunta que precisa ser lida ──
          Era um confirm() do navegador — uma linha cinza no topo da tela, igual
          à de sair da página, que o dedo dispensa no automático. Cancelar joga
          fora tudo que foi lançado e não tem desfazer, então aqui a conta
          aparece por extenso e o botão perigoso fica separado do de voltar. */}
      {/* ── Trocar de mesa ──────────────────────────────────────────────────
          Duas saídas, e a segunda existe porque juntar duas contas na mesma
          mesa vira briga na hora de fechar: ou a comanda vai pra uma mesa
          livre, ou ela sai da mesa e passa a ser chamada pelo nome do cliente
          (aí ele senta onde quiser, inclusive junto dos amigos). */}
      {movendo && comandaSel && (
        <div onClick={() => !moverBusy && setMovendo(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 420, maxHeight: '86vh', overflowY: 'auto',
              background: 'var(--bg)', borderRadius: 16, border: '1.5px solid var(--border)',
              padding: 20, boxSizing: 'border-box' }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 19, color: 'var(--text)' }}>
              {mesaSel?.is_comanda
                ? `Pôr a ${rotuloMesa(mesaSel)} numa mesa`
                : `Trocar a Mesa ${mesaSel?.numero} de lugar`}
            </h2>
            <p style={{ margin: '0 0 16px', fontSize: 13.5, lineHeight: 1.45, color: 'var(--text-muted)' }}>
              Os {(comandaSel.comanda_itens ?? []).reduce((n, i) => n + Number(i.quantidade || 0), 0)} item(ns)
              e os {fmt(subtotalSel)} já consumidos vão junto.
            </p>

            <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: .4, textTransform: 'uppercase',
              color: 'var(--text-muted)', marginBottom: 8 }}>
              Mesas livres
            </div>
            {mesasLivres.length === 0 ? (
              <div style={{ fontSize: 13.5, color: 'var(--text-muted)', padding: '6px 0 12px' }}>
                Nenhuma mesa livre agora.
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
                {mesasLivres.map(m => (
                  <button key={m.id} type="button" onClick={() => mover(m.id)} disabled={moverBusy}
                    style={{ minWidth: 62, padding: '10px 12px', borderRadius: 10, cursor: moverBusy ? 'wait' : 'pointer',
                      border: '1.5px solid var(--border)', background: 'transparent',
                      color: 'var(--text)', fontWeight: 800, fontSize: 15 }}>
                    {m.numero}
                  </button>
                ))}
              </div>
            )}

            {/* A conta que JÁ é de nome não tem pra onde "sair da mesa" — ela
                nunca esteve numa. Aqui só faz sentido escolher uma mesa livre. */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: mesaSel?.is_comanda ? 'none' : 'block' }}>
              <div style={{ fontSize: 12.5, fontWeight: 800, letterSpacing: .4, textTransform: 'uppercase',
                color: 'var(--text-muted)', marginBottom: 6 }}>
                Ou sentou junto de alguém
              </div>
              <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.45, color: 'var(--text-muted)' }}>
                A conta sai da mesa e passa a ser chamada pelo nome — as duas contas
                ficam na mesma mesa, mas cada uma fecha sozinha.
              </p>
              <input value={moverNome} onChange={e => setMoverNome(e.target.value)}
                placeholder="Nome do cliente" disabled={moverBusy}
                style={{ width: '100%', padding: '11px 12px', borderRadius: 10, boxSizing: 'border-box',
                  border: '1.5px solid var(--border)', background: 'var(--surface, transparent)',
                  color: 'var(--text)', fontSize: 15 }} />
              <button type="button" onClick={() => mover(null)} disabled={moverBusy}
                style={{ width: '100%', marginTop: 8, padding: '12px 0', borderRadius: 12, cursor: moverBusy ? 'wait' : 'pointer',
                  border: '1.5px solid #7c3aed', background: 'rgba(124,58,237,.12)',
                  color: 'var(--text)', fontWeight: 800, fontSize: 15 }}>
                {moverBusy ? 'Trocando…' : 'Tirar da mesa e usar o nome'}
              </button>
            </div>

            {moverErro && (
              <div style={{ marginTop: 12, fontSize: 13.5, lineHeight: 1.4, color: 'var(--danger, #ef4444)' }}>
                {moverErro}
              </div>
            )}

            <button type="button" onClick={() => setMovendo(false)} disabled={moverBusy}
              style={{ width: '100%', marginTop: 12, padding: '12px 0', borderRadius: 12, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
                fontWeight: 800, fontSize: 15 }}>
              Voltar
            </button>
          </div>
        </div>
      )}

      {confirmarCancelar && comandaSel && (
        <div onClick={() => !cancelando && setConfirmarCancelar(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1100,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 380, background: 'var(--bg)', borderRadius: 16,
              border: '1.5px solid var(--danger, #ef4444)', padding: 20, boxSizing: 'border-box' }}>
            <div style={{ fontSize: 40, textAlign: 'center', lineHeight: 1 }}>⚠️</div>
            <h2 style={{ margin: '10px 0 6px', fontSize: 19, textAlign: 'center', color: 'var(--text)' }}>
              Cancelar {mesaSel?.is_comanda ? 'esta comanda' : `a Mesa ${mesaSel?.numero}`}?
            </h2>
            <p style={{ margin: '0 0 14px', fontSize: 14.5, lineHeight: 1.45, textAlign: 'center', color: 'var(--text-muted)' }}>
              Tudo que já foi lançado será <strong style={{ color: 'var(--danger, #ef4444)' }}>perdido</strong>. Não dá pra desfazer.
            </p>

            {(comandaSel.comanda_itens ?? []).length > 0 && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                  <span>{(comandaSel.comanda_itens ?? []).reduce((n, i) => n + Number(i.quantidade || 0), 0)} item(ns) lançado(s)</span>
                  <span>{fmt(subtotalSel)}</span>
                </div>
                {/* Só os primeiros: a lista inteira empurraria os botões pra
                    fora da tela do celular, que é onde isso é usado. */}
                <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-muted)' }}>
                  {(comandaSel.comanda_itens ?? []).slice(0, 4).map(i => `${Number(i.quantidade || 0)}× ${i.nome}`).join(' · ')}
                  {(comandaSel.comanda_itens ?? []).length > 4 && ` · +${(comandaSel.comanda_itens ?? []).length - 4} …`}
                </div>
              </div>
            )}

            <button type="button" onClick={cancelarMesaDeVerdade} disabled={cancelando}
              style={{ width: '100%', padding: '13px 0', borderRadius: 12, border: 'none', cursor: cancelando ? 'wait' : 'pointer',
                background: 'var(--danger, #ef4444)', color: '#fff', fontWeight: 800, fontSize: 15.5, opacity: cancelando ? .6 : 1 }}>
              {cancelando ? 'Cancelando...' : 'Sim, cancelar e perder tudo'}
            </button>
            <button type="button" onClick={() => setConfirmarCancelar(false)} disabled={cancelando}
              style={{ width: '100%', marginTop: 8, padding: '13px 0', borderRadius: 12, cursor: 'pointer',
                border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 800, fontSize: 15.5 }}>
              Não, voltar pra mesa
            </button>
          </div>
        </div>
      )}

      {/* ── Ligar cliente à mesa ──
          `permitirSemCadastro` vale na MESA também, não só no balcão. Quem senta
          na mesa raramente quer virar cadastro, e obrigar a escolher alguém da
          lista (ou cadastrar na hora) só pra escrever "Mesa 4 · Marcos" fazia o
          atendente desistir de pôr o nome. Ao ABRIR a comanda isso já dava;
          faltava depois, com a conta já aberta — que é justamente quando o
          atendente descobre o nome de quem sentou. */}
      {pickerCliente && comandaSel && (
        <ClientePicker
          empresaId={empresaId}
          titulo={mesaSel?.is_balcao ? 'Cliente do balcão' : `Cliente da ${rotuloMesa(mesaSel)}`}
          permitirSemCadastro
          permitirTirar={!!(comandaSel.cliente || comandaSel.nome_cliente)}
          onPick={ligarClienteComanda}
          onFechar={() => setPickerCliente(false)}
        />
      )}

      {/* ── Quem fica devendo NESTA linha do fiado (modo "Dividir conta") ── */}
      {pickerFiadoIdx != null && pagamentos[pickerFiadoIdx] && (
        <ClientePicker
          empresaId={empresaId}
          titulo={`Quem fica devendo ${fmt(Number(pagamentos[pickerFiadoIdx].valor) || 0)}`}
          permitirTirar={!!pagamentos[pickerFiadoIdx].cliente}
          onPick={(c) => setClienteLinha(pickerFiadoIdx, c)}
          onFechar={() => setPickerFiadoIdx(null)}
        />
      )}

      {/* ── Modal de fechamento ── */}
      {fechando && comandaSel && (
        <div onClick={() => setFechando(false)} className="sal-modal-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          {/* Dividir a conta, o fiado e o cadastro de cliente na hora deixam este
              modal mais alto que a tela do celular. Sem altura máxima ele
              transbordava pra cima E pra baixo ao mesmo tempo (o overlay centraliza),
              e o botão de receber ficava fora da tela sem rolagem nenhuma pra
              alcançar. Mesmo remédio do ModalComplementos aqui embaixo: só o
              miolo rola, título e botão ficam sempre parados à vista. */}
          <div onClick={e => e.stopPropagation()} className="sal-fechar"
            style={{ width: '100%', maxWidth: 380, background: 'var(--bg)', borderRadius: 16, border: '1px solid var(--border)',
              maxHeight: '85dvh', display: 'flex', flexDirection: 'column' }}>
            <div className="sal-fechar-titulo" style={{ flexShrink: 0, padding: '20px 20px 0', fontWeight: 800, fontSize: 17 }}>Fechar conta — {rotuloMesa(mesaSel)}</div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 20px 0' }}>

            <div className="sal-fechar-linha" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '4px 0' }}>
              <span>Subtotal</span><span>{fmt(subtotalSel)}</span>
            </div>
            <label className="sal-fechar-linha" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 14, padding: '4px 0', cursor: 'pointer' }}>
              <span>
                <input type="checkbox" checked={aplicarTaxa} onChange={e => setAplicarTaxa(e.target.checked)} style={{ marginRight: 8 }} />
                Taxa de serviço ({taxaPct}%)
              </span>
              <span>{fmt(taxaSel)}</span>
            </label>
            <div className="sal-fechar-total" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 18, fontWeight: 800, padding: '10px 0', borderTop: '1px dashed var(--border)', marginTop: 6 }}>
              <span>Total</span><span style={{ color: 'var(--primary)' }}>{fmt(totalSel)}</span>
            </div>
            {cashbackAplicado > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: '#16a34a', marginTop: 4 }}>
                  <span>🎟️ Cashback</span><span>− {fmt(cashbackAplicado)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 16, marginTop: 4 }}>
                  <span>A receber</span><span style={{ color: 'var(--primary)' }}>{fmt(totalAPagar)}</span>
                </div>
              </>
            )}

            {/* Modo: pagamento único × dividir */}
            <div style={{ display: 'flex', gap: 8, margin: '14px 0 10px' }}>
              {[['unico', 'Pagamento único'], ['dividir', 'Dividir conta']].map(([id, label]) => (
                <button key={id} type="button"
                  onClick={() => { setModoPag(id); if (id === 'dividir' && pagamentos.length === 0) dividirIgual(comandaSel.num_pessoas > 1 ? comandaSel.num_pessoas : 2) }}
                  style={{ flex: 1, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                    border: `1.5px solid ${modoPag === id ? 'var(--primary)' : 'var(--border)'}`,
                    background: modoPag === id ? 'rgba(134,59,255,.1)' : 'transparent', color: 'var(--text)' }}>
                  {label}
                </button>
              ))}
            </div>

            {/* Crédito do cliente (mig 0179): caixinha de abatimento, não forma
                de pagamento. Marca, o total cai, e as formas abaixo cobrem só a
                diferença — que é o que acontece na prática. */}
            {cashbackSaldo > 0 && (
              <button
                type="button"
                onClick={() => setUsarCashbackConta(v => !v)}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer', marginBottom: 10,
                  padding: '11px 13px', borderRadius: 10,
                  border: `1.5px solid ${usarCashbackConta ? '#16a34a' : 'var(--border)'}`,
                  background: usarCashbackConta ? 'rgba(22,163,74,.12)' : 'transparent',
                  display: 'flex', alignItems: 'center', gap: 11, color: 'var(--text)',
                }}
              >
                <span style={{
                  width: 20, height: 20, borderRadius: 5, flexShrink: 0,
                  border: `2px solid ${usarCashbackConta ? '#16a34a' : 'var(--border)'}`,
                  background: usarCashbackConta ? '#16a34a' : 'transparent',
                  color: '#fff', fontSize: 13, lineHeight: '17px', textAlign: 'center', fontWeight: 800,
                }}>{usarCashbackConta ? '✓' : ''}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5 }}>
                    🎟️ Usar o cashback de {comandaSel?.cliente?.nome ?? 'do cliente'} · {fmt(cashbackSaldo)}
                    {comandaSel?.usar_cashback && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}> · o cliente pediu</span>
                    )}
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 1 }}>
                    {usarCashbackConta
                      ? `Abate ${fmt(cashbackAplicado)} · falta receber ${fmt(totalAPagar)}`
                      : 'Abate do total e ele paga só a diferença.'}
                  </span>
                </span>
              </button>
            )}

            {modoPag === 'unico' ? (
              // wrap: com o Fiado são 4 formas e no celular não cabem numa linha só
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {FORMAS.map(f => (
                  <button key={f.id} type="button" onClick={() => setForma(f.id)}
                    style={{ flex: '1 1 calc(50% - 4px)', padding: '10px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
                      border: `1.5px solid ${forma === f.id ? 'var(--primary)' : 'var(--border)'}`,
                      background: forma === f.id ? 'rgba(134,59,255,.1)' : 'transparent', color: 'var(--text)' }}>
                    {f.label}
                  </button>
                ))}
                {/* PIX ONLINE (mig 0193) — só pra loja que conectou o Mercado Pago.
                    Fica fora da fileira das outras formas de propósito: as de cima o
                    atendente MARCA (ele viu o dinheiro); esta COBRA de verdade e a
                    conta fecha sozinha quando o MP confirma. */}
                {mpConectado && pixDaMesa && modoPag === 'unico' && (
                  <div style={{ flex: '1 1 100%', padding: '9px 12px', borderRadius: 10, fontSize: 12.5, lineHeight: 1.45,
                    border: '1.5px solid #22c55e', background: 'rgba(34,197,94,.10)', color: 'var(--text)' }}>
                    ⚡ Esta mesa já tem um <strong>PIX de {fmt(Number(pixDaMesa.valor))}</strong> esperando.
                    Feche esta janela e o QR está na comanda. Se receber por aqui, cancele o PIX antes.
                  </div>
                )}
                {/* Chamado com () de propósito: `onClick={cobrarPixOnline}` passaria o
                    evento do clique como `valorParcial`, e a cobrança da conta inteira
                    quebrava antes de sair do navegador (o evento não vira JSON). O
                    rachado funcionava porque ali o valor vai explícito. */}
                {mpConectado && !pixDaMesa && (
                  <button type="button" onClick={() => cobrarPixOnline()}
                    disabled={pixGerando || cashbackAplicado > 0 || totalSel <= 0}
                    style={{ flex: '1 1 100%', padding: '11px 0', borderRadius: 10, fontWeight: 800, fontSize: 13,
                      cursor: (pixGerando || cashbackAplicado > 0) ? 'not-allowed' : 'pointer',
                      // Escolhido = marcado, igual às outras formas. Antes ficava
                      // "Dinheiro" aceso e ninguém sabia no que tinha clicado.
                      border: `1.5px solid ${forma === 'pix_online' ? '#16a34a' : '#22c55e'}`,
                      background: forma === 'pix_online' ? 'rgba(34,197,94,.30)' : 'rgba(34,197,94,.12)',
                      boxShadow: forma === 'pix_online' ? '0 0 0 2px rgba(34,197,94,.35)' : 'none',
                      color: 'var(--text)',
                      opacity: (pixGerando || cashbackAplicado > 0 || totalSel <= 0) ? .5 : 1 }}>
                    {pixGerando ? '⚡ Gerando o QR...'
                      : forma === 'pix_online' ? `✓ PIX online · ${fmt(totalSel)}`
                      : `⚡ PIX online · cobrar ${fmt(totalSel)} no QR`}
                  </button>
                )}
                {mpConectado && !pixDaMesa && cashbackAplicado > 0 && (
                  <div style={{ flex: '1 1 100%', fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                    Com crédito abatido o PIX online não vale — receba pelas formas de cima.
                  </div>
                )}
                {pixMsg && (
                  <div style={{ flex: '1 1 100%', fontSize: 12.5, color: 'var(--text)' }}>{pixMsg}</div>
                )}
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Pagamentos</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    rachar:
                    {[2, 3, 4].map(n => (
                      <button key={n} type="button" onClick={() => dividirIgual(n)}
                        style={{ marginLeft: 6, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)' }}>
                        {n}x
                      </button>
                    ))}
                  </span>
                </div>

                {pagamentos.map((p, i) => (
                  <div key={i} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <select value={p.forma} onChange={e => updatePagamento(i, 'forma', e.target.value)}
                        style={{ padding: '8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }}>
                        {FORMAS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                        {/* Um QR só pra ESTA parte (mig 0195). Fica no mesmo lugar
                            das outras formas porque, pro atendente, é a mesma
                            pergunta: como esta pessoa vai pagar? */}
                        {mpConectado && <option value="pix_online">⚡ PIX online (QR)</option>}
                      </select>
                      <input type="number" step="0.01" min="0" inputMode="decimal" value={p.valor}
                        onChange={e => updatePagamento(i, 'valor', e.target.value)} placeholder="0,00"
                        style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 13 }} />
                      <button type="button" onClick={() => removePagamento(i)}
                        style={{ width: 30, height: 34, borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--danger)', fontSize: 16 }}>×</button>
                    </div>

                    {/* Linha de PIX online: gera (ou mostra) o QR daquela parte. */}
                    {p.forma === 'pix_online' && (() => {
                      const alvo = Number(String(p.valor ?? '').replace(',', '.'))
                      // Casa pelo número da parte; o valor só serve pras cobranças
                      // antigas (sem parte gravada), senão duas partes iguais
                      // apontariam pro mesmo QR.
                      const jaTem = pixDaMesaTodos.find(x => x.parte === i)
                        ?? pixDaMesaTodos.find(x => x.parte == null && Math.abs(Number(x.valor) - alvo) < 0.005)
                      if (jaTem?.status === 'pago') {
                        return (
                          <div style={{ marginTop: 4, padding: '8px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 700,
                            border: '1px solid #22c55e', background: 'rgba(34,197,94,.12)', color: '#16a34a' }}>
                            ✅ PIX de {fmt(Number(jaTem.valor))} já caiu
                          </div>
                        )
                      }
                      return (
                        <button type="button"
                          onClick={() => (jaTem ? setPixAmpliado({ ...jaTem, cobranca_id: jaTem.id }) : cobrarPixDaLinha(i))}
                          disabled={pixGerando || !(alvo > 0)}
                          style={{ width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, cursor: (pixGerando || !(alvo > 0)) ? 'not-allowed' : 'pointer',
                            border: `1.5px solid ${jaTem ? '#16a34a' : '#22c55e'}`,
                            background: jaTem ? 'rgba(34,197,94,.25)' : 'rgba(34,197,94,.10)',
                            color: 'var(--text)', fontSize: 12.5, fontWeight: 800,
                            opacity: (pixGerando || !(alvo > 0)) ? .5 : 1 }}>
                          {pixGerando ? '⚡ Gerando...'
                            : jaTem ? `🔍 Mostrar o QR de ${fmt(Number(jaTem.valor))}`
                            : alvo > 0 ? `⚡ Gerar QR de ${fmt(alvo)}`
                            : 'Digite o valor pra gerar o QR'}
                        </button>
                      )
                    })()}

                    {/* Só a linha de fiado pede cliente — as outras já foram pagas. */}
                    {p.forma === 'fiado' && (
                      <button type="button" onClick={() => setPickerFiadoIdx(i)}
                        style={{ width: '100%', marginTop: 4, padding: '8px 10px', borderRadius: 8, textAlign: 'left', cursor: 'pointer',
                          border: p.cliente ? '1px solid var(--border)' : '1.5px dashed #d97706',
                          background: 'rgba(217,119,6,.06)', color: 'var(--text)', fontSize: 12.5, fontWeight: 700 }}>
                        {p.cliente
                          ? <>🧾 Fica devendo: {p.cliente.nome}{p.cliente.telefone && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> · {p.cliente.telefone}</span>} <span style={{ color: 'var(--primary)' }}>(trocar)</span></>
                          : '🧾 Escolher quem fica devendo (obrigatório)'}
                      </button>
                    )}
                  </div>
                ))}

                <button type="button" onClick={addPagamento}
                  style={{ width: '100%', padding: '8px 0', borderRadius: 8, marginTop: 2, cursor: 'pointer', border: '1.5px dashed var(--border)', background: 'transparent', color: 'var(--text-muted)', fontSize: 13 }}>
                  + Adicionar pagamento
                </button>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 14, fontWeight: 800,
                  color: Math.abs(restante) < 0.05 ? 'var(--success)' : 'var(--danger)' }}>
                  <span>{Math.abs(restante) < 0.05 ? '✓ Fecha certinho' : restante > 0 ? 'Falta receber' : 'Passou'}</span>
                  <span>{fmt(Math.abs(restante))}</span>
                </div>
              </div>
            )}

            {/* Cliente do fiado — no modo único é um devedor só pra conta inteira.
                No "Dividir conta" cada linha escolhe o seu (botão dentro da linha). */}
            {temFiadoNaTela && modoPag === 'unico' && (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 10, border: `1.5px solid ${clienteSel ? 'var(--border)' : '#d97706'}`, background: 'rgba(217,119,6,.06)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>
                  🧾 Quem vai ficar devendo {fmt(valorFiado)}
                </div>

                {clienteSel ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontWeight: 700, fontSize: 14.5 }}>
                      {clienteSel.nome}
                      {clienteSel.telefone && <span style={{ color: 'var(--text-muted)', fontSize: 12.5, fontWeight: 500 }}> · {clienteSel.telefone}</span>}
                    </span>
                    <button type="button" onClick={() => { setClienteSel(null); setBuscaCliente('') }}
                      style={{ padding: '6px 10px', borderRadius: 8, cursor: 'pointer', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 12.5, fontWeight: 700 }}>
                      Trocar
                    </button>
                  </div>
                ) : (
                  <>
                    <input value={buscaCliente} onChange={e => setBuscaCliente(e.target.value)}
                      placeholder="Buscar cliente pelo nome..."
                      style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' }} />

                    {buscaCliente.trim() && !novoCliente && (
                      <div style={{ maxHeight: 150, overflowY: 'auto', marginTop: 6 }}>
                        {clientesFiltrados.length === 0 ? (
                          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '6px 0' }}>
                            Nenhum cliente com esse nome.
                          </div>
                        ) : clientesFiltrados.map(c => (
                          <button key={c.id} type="button" onClick={() => { setClienteSel(c); setBuscaCliente('') }}
                            style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 6px', cursor: 'pointer',
                              border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontSize: 14 }}>
                            {c.nome}
                            {/* Telefone diferencia dois clientes de mesmo nome */}
                            {c.telefone && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}> · {c.telefone}</span>}
                          </button>
                        ))}
                      </div>
                    )}

                    {novoCliente ? (
                      <>
                        <input value={novoTelefone} onChange={e => setNovoTelefone(e.target.value)}
                          type="tel" inputMode="tel" placeholder="Telefone com DDD (opcional)"
                          style={{ width: '100%', marginTop: 8, padding: '9px 10px', borderRadius: 8, boxSizing: 'border-box',
                            border: '1px solid var(--border)', background: 'var(--input-bg, var(--bg))', color: 'var(--text)', fontSize: 14 }} />
                        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                          O telefone pode ficar pra depois. Só não dá pra ter dois clientes com o mesmo nome.
                        </div>
                        <button type="button" onClick={criarClienteFiado}
                          disabled={salvandoCliente || !buscaCliente.trim()}
                          style={{ width: '100%', marginTop: 8, padding: '9px 0', borderRadius: 8, border: 'none',
                            background: 'var(--primary)', color: '#fff', fontSize: 13, fontWeight: 800,
                            cursor: salvandoCliente ? 'wait' : 'pointer',
                            opacity: (salvandoCliente || !buscaCliente.trim()) ? .5 : 1 }}>
                          {salvandoCliente ? 'Cadastrando...' : `Cadastrar "${buscaCliente.trim()}" e usar`}
                        </button>
                      </>
                    ) : (
                      <button type="button" onClick={() => setNovoCliente(true)}
                        style={{ width: '100%', marginTop: 8, padding: '8px 0', borderRadius: 8, cursor: 'pointer',
                          border: '1.5px dashed var(--primary)', background: 'transparent', color: 'var(--primary)', fontSize: 12.5, fontWeight: 700 }}>
                        ➕ Cliente novo (cadastrar na hora)
                      </button>
                    )}
                  </>
                )}
              </div>
            )}

            </div>

            <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8,
              padding: '14px 20px calc(20px + env(safe-area-inset-bottom, 0px))' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setFechando(false)}
                  style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 700 }}>
                  Voltar
                </button>
                <button type="button" onClick={imprimirConta} title="Imprimir conta"
                  style={{ flex: 1, padding: '10px 0', borderRadius: 10, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontWeight: 700 }}>
                  🖨️ Conta
                </button>
              </div>
              <button type="button" onClick={confirmarFechamento} disabled={salvando || !podeReceber}
                className="btn btn-primary" style={{ width: '100%', marginTop: 0, opacity: (salvando || !podeReceber) ? 0.5 : 1 }}>
                {salvando ? 'Fechando...'
                  : esperandoPix ? '⚡ Esperando o PIX cair — a conta fecha sozinha'
                  : !ehAdmin ? `Fechar e enviar pro caixa · ${fmt(totalSel)}`
                  // No fiado não entra dinheiro agora: "Receber" mentiria no valor.
                  : valorFiado >= totalSel - 0.05 ? `Fechar no fiado · ${fmt(totalSel)}`
                  : temFiadoNaTela ? `Receber ${fmt(totalSel - valorFiado)} · fiado ${fmt(valorFiado)}`
                  : `Receber ${fmt(totalSel)}`}
              </button>
            </div>
          </div>
        </div>
      )}
      {avisoConfirmar}

      {avisoPix && (
        <AvisoPix
          tipo={avisoPix.tipo}
          valor={avisoPix.valor}
          titulo={avisoPix.titulo}
          texto={avisoPix.texto}
          onFechar={() => setAvisoPix(null)}
        />
      )}

      {/* ── QR grande, só pra mostrar pro cliente (mig 0193) ────────────────
          Sai com um toque em qualquer lugar e NÃO cancela nada: a cobrança
          continua viva na mesa. Era isto que prendia o garçom antes — a única
          saída da tela era cancelar o PIX. */}
      {/* Mesmo caso da gaveta, e este ainda abre por cima da tela de fechamento
          (1100): o QR que o cliente vai ler tem que estar na frente de tudo. */}
      {pixAmpliado && (
        <div onClick={() => setPixAmpliado(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.8)', zIndex: 1200,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 340, background: 'var(--bg)', borderRadius: 16,
              border: '1px solid var(--border)', padding: 20, textAlign: 'center', maxHeight: '92dvh', overflowY: 'auto' }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>Pague no PIX</div>
            <div style={{ fontSize: 26, fontWeight: 900, color: 'var(--primary)', margin: '6px 0 2px' }}>
              {fmt(Number(pixAmpliado.valor))}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>
              Aponte a câmera do banco pro código
            </div>

            {pixAmpliado.qr_base64 && (
              <img src={`data:image/png;base64,${pixAmpliado.qr_base64}`} alt="QR do PIX"
                style={{ width: '100%', maxWidth: 300, borderRadius: 10, background: '#fff', padding: 10, boxSizing: 'border-box' }} />
            )}

            {pixAmpliado.qr_code && (
              <button type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(pixAmpliado.qr_code)
                    .then(() => setPixMsg('✅ Copia e cola copiado.'))
                    .catch(() => setPixMsg('Não consegui copiar aqui.'))
                }}
                style={{ width: '100%', marginTop: 12, padding: '10px 0', borderRadius: 10, cursor: 'pointer',
                  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', fontWeight: 700, fontSize: 13 }}>
                📋 Copiar o copia e cola
              </button>
            )}
            {pixMsg && <div style={{ fontSize: 12.5, marginTop: 8 }}>{pixMsg}</div>}

            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.45 }}>
              Pode fechar esta tela e continuar trabalhando — a cobrança fica guardada
              na mesa e a conta fecha sozinha quando o pagamento cair.
            </div>

            <button type="button" onClick={() => setPixAmpliado(null)}
              style={{ width: '100%', marginTop: 12, padding: '11px 0', borderRadius: 10, cursor: 'pointer',
                border: 'none', background: 'var(--primary)', color: '#fff', fontWeight: 800 }}>
              Pronto, mostrei
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const qtdBtn = {
  width: 28, height: 28, borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)',
  fontSize: 16, lineHeight: 1, flexShrink: 0,
}

// Modal "montar o item": escolhe os complementos por grupo, com QUANTIDADE por opção
// (a opção não some ao ser escolhida — dá pra somar no +). O `max` do grupo limita a
// soma das quantidades daquele grupo; `min` obriga um mínimo antes de confirmar.
function ModalComplementos({ produto, grupos, semObrigatorios, onCancelar, onConfirmar }) {
  const [sel, setSel] = useState({}) // { grupoId: { opcaoId: qtd } }

  const somaDe = (mapa) => Object.values(mapa ?? {}).reduce((s, q) => s + q, 0)
  const somaGrupo = (gId) => somaDe(sel[gId])

  function mudar(g, o, delta) {
    setSel(prev => {
      const atual = prev[g.id] ?? {}
      const q = (atual[o.id] ?? 0) + delta
      if (q < 0) return prev
      // trava no máximo do grupo (só barra quando está aumentando).
      // Conta a partir do `prev`, não do `sel` do render — senão dois cliques
      // rápidos passariam do limite.
      if (delta > 0 && !g.modo_quantidade && g.max > 0 && somaDe(atual) >= g.max) return prev
      const novo = { ...atual }
      if (q === 0) delete novo[o.id]
      else novo[o.id] = q
      return { ...prev, [g.id]: novo }
    })
  }

  // Digitar o número direto. No + e - a conta vai de um em um; cliente que quer
  // 100 picolés não vai clicar 100 vezes — desiste antes, e o garçom também.
  function definir(g, o, valor) {
    const n = Math.max(0, Math.floor(Number(valor) || 0))
    setSel(prev => {
      const atual = { ...(prev[g.id] ?? {}) }
      // Fora do atacado o teto do grupo continua valendo: "escolha até 2
      // sabores" não pode virar 40 pela digitação.
      const limite = !g.modo_quantidade && g.max > 0
        ? Math.max(0, g.max - (somaDe(atual) - (atual[o.id] ?? 0)))
        : n
      const q = Math.min(n, limite)
      if (q <= 0) delete atual[o.id]
      else atual[o.id] = q
      return { ...prev, [g.id]: atual }
    })
  }

  const escolhas = grupos.flatMap(g =>
    Object.entries(sel[g.id] ?? {}).map(([oId, qtd]) => {
      const o = g.opcoes.find(x => String(x.id) === String(oId))
      return {
        grupoId: g.id, nome: o?.nome ?? '', preco_adicional: Number(o?.preco_adicional || 0), qtd,
        // Pra comanda/cupom não multiplicarem de novo pela qtd do item.
        absoluto: !!g.modo_quantidade,
      }
    })
  )
  const adicional = adicionalComplementos(
    grupos,
    escolhas.map(e => ({ grupoId: e.grupoId, preco: e.preco_adicional, qtd: e.qtd })),
  )
  // No atacado a linha leva a soma dos sabores (10 + 15 + 20 = 45 picolés) e o
  // adicional entra rateado, pra a linha ter UM preço unitário e o subtotal
  // (qtd × unitário) continuar batendo.
  const grupoQtd = grupos.find(g => g.modo_quantidade)
  const qtdItem = grupoQtd ? Math.max(1, somaGrupo(grupoQtd.id)) : 1
  const precoFinal = Number(produto.preco_venda) + adicional / qtdItem
  const totalItem = precoFinal * qtdItem
  // Com "complementos livres" ligado, o mínimo do grupo é ignorado: o garçom
  // lança direto e monta o prato com o cliente. O máximo continua valendo.
  const faltando = semObrigatorios
    ? []
    : grupos.filter(g => (g.min ?? 0) > 0 && somaGrupo(g.id) < g.min)

  return (
    <div onClick={onCancelar} className="sal-modal-overlay"
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      {/* Quentinha tem 9 grupos: se o modal rolasse inteiro, o botão de
          adicionar ficava lá embaixo e o atendente tinha que descer a lista toda
          só pra confirmar. Agora só a LISTA rola — título em cima e botão
          embaixo ficam sempre à vista.
          A classe sal-modal-overlay faz esta folha parar acima da barra de menu
          do celular quando o salão está dentro do painel — senão o "Adicionar"
          nasce por baixo dela e não dá pra confirmar o sabor do suco. */}
      <div onClick={e => e.stopPropagation()} className="sal-modal-folha"
        style={{ width: '100%', maxWidth: 460, background: 'var(--bg)', borderTopLeftRadius: 16, borderTopRightRadius: 16, border: '1px solid var(--border)', maxHeight: '85dvh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '18px 18px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontWeight: 800, fontSize: 17 }}>{produto.nome}</div>
            <button type="button" onClick={onCancelar}
              style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)', lineHeight: 1 }}>×</button>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{fmt(produto.preco_venda)}</div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px 4px' }}>
        {grupos.map(g => {
          const conta = somaGrupo(g.id)
          const falta = !semObrigatorios && (g.min ?? 0) > 0 && conta < g.min
          const cheio = !g.modo_quantidade && g.max > 0 && conta >= g.max
          return (
            <div key={g.id} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 14.5 }}>{g.nome}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: falta ? '#d97706' : 'var(--text-muted)' }}>
                  {g.modo_quantidade
                    ? `${conta} un${g.min > 0 && !semObrigatorios ? ` · mín ${g.min}` : ''}`
                    : `${conta}/${g.max}${g.min > 0 && !semObrigatorios ? ' · obrigatório' : ''}`}
                </span>
              </div>
              {g.opcoes.map(o => {
                const q = sel[g.id]?.[o.id] ?? 0
                return (
                  <div key={o.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14.5, fontWeight: q > 0 ? 700 : 500 }}>{o.nome}</div>
                      {Number(o.preco_adicional) > 0 && (
                        <div style={{ fontSize: 12.5, color: 'var(--primary)', fontWeight: 700 }}>+{fmt(o.preco_adicional)}</div>
                      )}
                    </div>
                    <button type="button" onClick={() => mudar(g, o, -1)} disabled={q === 0}
                      style={{ ...qtdBtn, opacity: q === 0 ? .35 : 1, cursor: q === 0 ? 'default' : 'pointer' }}>−</button>
                    <input
                      type="number" min="0" inputMode="numeric"
                      aria-label={`Quantidade de ${o.nome}`}
                      value={q === 0 ? '' : q} placeholder="0"
                      onChange={e => definir(g, o, e.target.value)}
                      onFocus={e => e.target.select()}
                      style={{ width: 52, textAlign: 'center', fontWeight: 700, fontSize: 14.5,
                        padding: '5px 2px', borderRadius: 8, border: '1px solid var(--border)',
                        background: 'var(--surface, transparent)', color: 'var(--text)' }} />
                    <button type="button" onClick={() => mudar(g, o, +1)} disabled={cheio}
                      style={{ ...qtdBtn, opacity: cheio ? .35 : 1, cursor: cheio ? 'default' : 'pointer' }}>+</button>
                  </div>
                )
              })}
            </div>
          )
        })}

        </div>

        <div style={{
          flexShrink: 0, padding: '12px 18px calc(12px + env(safe-area-inset-bottom, 0px))',
          borderTop: '1px solid var(--border)', background: 'var(--bg)',
        }}>
          {faltando.length > 0 && (
            <div style={{ fontSize: 12.5, color: '#d97706', fontWeight: 700, marginBottom: 8 }}>
              ⚠️ Falta escolher: {faltando.map(g => g.nome).join(', ')}
            </div>
          )}

          <button type="button" onClick={() => onConfirmar(escolhas, qtdItem)} disabled={faltando.length > 0}
            style={{ width: '100%', padding: '12px 0', borderRadius: 10,
              border: 'none', background: 'var(--primary)', color: '#fff', fontSize: 15, fontWeight: 800,
              cursor: faltando.length > 0 ? 'default' : 'pointer', opacity: faltando.length > 0 ? .5 : 1 }}>
            {grupoQtd ? `Adicionar ${qtdItem} un · ${fmt(totalItem)}` : `Adicionar · ${fmt(precoFinal)}`}
          </button>
        </div>
      </div>
    </div>
  )
}
