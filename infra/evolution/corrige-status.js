/*
 * Corrige "conectado mas surdo" no Evolution 2.3.7 / Baileys 7.0.0-rc.9.
 *
 * O QUE ACONTECE SEM ISSO (issue evolution-api#2778, baileys#2858):
 * Desde o fim de setembro/2026 o WhatsApp manda stanza <status> no nível de
 * cima. O Baileys rc.9 não confirma o recebimento. O servidor do WhatsApp
 * espera ~50 min e FECHA o stream. A sessão reconecta em 1-3 s, o mesmo
 * stanza é reenviado, e de novo não é confirmado — daí pra frente a sessão
 * fica "open" e não entrega mais NENHUMA mensagem de entrada. Enviar continua
 * funcionando, por isso a tela mostra tudo verde.
 *
 * A CORREÇÃO (backport de WhiskeySockets/Baileys#2883):
 * só confirmar o stanza. Não interpreta nada, não muda comportamento.
 *
 * Este script FALHA O BUILD de propósito se qualquer âncora não bater. É de
 * propósito: imagem que sobe sem a correção é pior do que build quebrado,
 * porque o problema volta calado e a gente perde dias de novo achando que
 * consertou.
 */
const fs = require("fs")
const path = require("path")

// BAILEYS_DIR só é usado pra testar o script fora da imagem.
const RAIZ = process.env.BAILEYS_DIR || "/evolution/node_modules/baileys"
const ALVO = path.join(RAIZ, "lib/Socket/messages-recv.js")

function morre(msg) {
  console.error("\n[corrige-status] FALHOU: " + msg)
  console.error("[corrige-status] A imagem NAO foi corrigida. Build abortado de proposito.\n")
  process.exit(1)
}

// 1. A versão tem que ser a que a gente estudou.
const pkg = path.join(RAIZ, "package.json")
if (!fs.existsSync(pkg)) morre("não achei o baileys em " + RAIZ)
const versao = JSON.parse(fs.readFileSync(pkg, "utf8")).version
console.log("[corrige-status] baileys encontrado:", versao)
if (!/^7\.0\.0-rc\.?9$/.test(versao)) {
  morre(`esperava baileys 7.0.0-rc.9 e achei ${versao}. ` +
    "A correção foi conferida nessa versão — revisar antes de liberar outra.")
}

if (!fs.existsSync(ALVO)) morre("não achei " + ALVO)
let src = fs.readFileSync(ALVO, "utf8")

if (src.includes("CB:status")) {
  console.log("[corrige-status] já estava corrigido, nada a fazer.")
  process.exit(0)
}

// 2. A função que confirma o stanza, logo antes do mapa de processadores.
const ancoraMapa = "['notification', handleNotification]"
if (!src.includes(ancoraMapa)) morre("não achei a entrada 'notification' no mapa de processadores")

const funcao = `
    // Confirma o stanza <status> do WhatsApp. Sem esta confirmação o servidor
    // fecha o stream ~50 min depois e a sessao volta aberta e surda.
    const handleStatus = async (node) => {
        try {
            await sendMessageAck(node);
        }
        catch (error) {
            onUnexpectedError(error, 'acking status stanza');
        }
    };
`

// A função precisa ficar no MESMO escopo de handleNotification e de
// sendMessageAck — ou seja, FORA de makeOfflineNodeProcessor. Se cair dentro,
// o ouvinte CB:status lá embaixo não enxerga ela e o build passa com um
// ReferenceError esperando acontecer em produção.
const ancoraEscopo = "const makeOfflineNodeProcessor = () => {"
const idxEscopo = src.indexOf(ancoraEscopo)
if (idxEscopo < 0) morre("não achei makeOfflineNodeProcessor")
if (src.indexOf("const sendMessageAck = ") > idxEscopo) {
  morre("sendMessageAck está definido depois do ponto de inserção")
}
const inicioLinha = src.lastIndexOf("\n", idxEscopo)
src = src.slice(0, inicioLinha) + funcao + src.slice(inicioLinha)

// 3. Registra no mapa.
src = src.replace(ancoraMapa, ancoraMapa + ",\n        ['status', handleStatus]")

// 4. O ouvinte, logo depois do de notification.
const ancoraOuvinte = "ws.on('CB:notification'"
const idxOuv = src.indexOf(ancoraOuvinte)
if (idxOuv < 0) morre("não achei o ouvinte CB:notification")
// Fim do bloco: a primeira ocorrência de "});" depois dele.
const fimBloco = src.indexOf("});", idxOuv)
if (fimBloco < 0) morre("não achei o fim do bloco CB:notification")
const corte = fimBloco + 3

const ouvinte = `

    ws.on('CB:status', async (node) => {
        // processNode confirma JID ignorado por fora do try do handleStatus,
        // por isso o catch aqui fora tambem.
        processNode('status', node, 'acking status stanza', handleStatus)
            .catch(error => onUnexpectedError(error, 'acking status stanza'));
    });`

src = src.slice(0, corte) + ouvinte + src.slice(corte)

fs.writeFileSync(ALVO, src)

// 5. Conferência final: as três partes têm que estar lá.
const conf = fs.readFileSync(ALVO, "utf8")
for (const parte of ["const handleStatus", "['status', handleStatus]", "ws.on('CB:status'"]) {
  if (!conf.includes(parte)) morre("depois de gravar, não encontrei: " + parte)
}
console.log("[corrige-status] OK — as 3 partes foram aplicadas em", ALVO)
