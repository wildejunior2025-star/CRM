// Lê o PDF de "Repasse" do iFood (Portal do Parceiro → Repasses → um período) e
// extrai o valor EXATO do repasse + o anúncio + o período. É o número que bate
// centavo por centavo com o iFood (o anúncio varia toda semana e só existe aqui).
//
// A lib pdfjs-dist é pesada — este arquivo é carregado por import dinâmico, só
// quando o dono clica em "Importar PDF".
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const num = s => Number(String(s).replace(/\./g, '').replace(',', '.')) || 0
const toISO = s => { const m = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null }

export async function parseRepassePdf(file) {
  const buf = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise
  let txt = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    txt += content.items.map(it => it.str).join(' ') + '\n'
  }

  const per = txt.match(/Per[ií]odo de apura[çc][ãa]o\s+(\d{2}\/\d{2}\/\d{4})\s+a\s+(\d{2}\/\d{2}\/\d{4})/)
  if (!per) throw new Error('Não parece o PDF de Repasse do iFood (não achei o "Período de apuração"). Exporte o repasse de UM período.')
  const rep = txt.match(/Valor do repasse\s+(?:Pago|Em aberto|Em antecipa[çc][ãa]o)?\s*R\$\s*([\d.,]+)/i)
  const anu = txt.match(/Pacote de an[úu]ncios\s*-?\s*R\$\s*([\d.,]+)/i)
  const ven = txt.match(/itens e entrega pr[óo]pria da loja\s*R\$\s*([\d.,]+)/i)
  const pag = txt.match(/Repasse de\s+(\d{2}\/\d{2}\/\d{4})/)
  const situacao = /Valor do repasse\s+Pago/i.test(txt) ? 'pago' : 'em aberto'

  return {
    periodo_ini: toISO(per[1]),
    periodo_fim: toISO(per[2]),
    previsao_pagamento: pag ? toISO(pag[1]) : null,
    situacao,
    valor_repasse: rep ? num(rep[1]) : 0,
    anuncio: anu ? num(anu[1]) : 0,
    vendas: ven ? num(ven[1]) : 0,
  }
}
