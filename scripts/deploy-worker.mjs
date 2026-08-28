// Sobe o Worker E coloca a versão no ar — porque `wrangler deploy` sozinho nem
// sempre coloca.
//
// O que aconteceu em 28/08/2026
// -----------------------------
// O `wrangler deploy` terminou dizendo "Uploaded crm" e "Current Version ID:
// ...", parecendo sucesso — mas no meio da saída ele avisava:
//
//     No targets deployed for crm
//
// A versão nova subiu e ficou GUARDADA, sem entrar no ar. O site seguiu
// servindo o index.html antigo, apontando pro bundle antigo, e a correção
// simplesmente não existia pra quem abria o sistema. Purgar o cache não
// resolvia: não era a borda, era a origem servindo a versão velha mesmo.
//
// Isso acontece porque as rotas (fwcinter.com e os subdomínios) estão ligadas
// ao Worker pelo painel da Cloudflare, e não no wrangler.jsonc. Sem rota no
// arquivo, o wrangler não tem "alvo" pra publicar e só faz o upload.
//
// Aqui a gente lê o Version ID da saída e publica a 100% quando o wrangler
// avisar que não publicou. Se ele já tiver publicado, não faz nada.
import { spawnSync } from 'node:child_process'

function rodar(cmd) {
  console.log(`\n$ ${cmd}`)
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' })
  const saida = `${r.stdout ?? ''}${r.stderr ?? ''}`
  process.stdout.write(saida)
  return { codigo: r.status, saida }
}

const deploy = rodar('npx wrangler deploy')
if (deploy.codigo !== 0) {
  console.error('\n❌ wrangler deploy falhou.')
  process.exit(deploy.codigo ?? 1)
}

// "No targets deployed" = subiu mas NÃO entrou no ar. É o caso que precisa do
// empurrão. Quando o wrangler publica sozinho, essa linha não aparece.
if (!/No targets deployed/i.test(deploy.saida)) {
  console.log('\n✅ O wrangler já colocou a versão no ar.')
  process.exit(0)
}

const m = deploy.saida.match(/Current Version ID:\s*([0-9a-f-]{36})/i)
if (!m) {
  console.error('\n❌ O wrangler avisou "No targets deployed" e eu não achei o Version ID na saída.')
  console.error('   Publique na mão:  npx wrangler versions deploy <version-id>@100% -y')
  process.exit(1)
}

console.log(`\n⚠️  O wrangler subiu mas NÃO publicou. Colocando a versão ${m[1]} no ar...`)
const promo = rodar(`npx wrangler versions deploy ${m[1]}@100% -y`)
if (promo.codigo !== 0 || !/SUCCESS/i.test(promo.saida)) {
  console.error('\n❌ Não consegui colocar a versão no ar.')
  process.exit(promo.codigo || 1)
}
console.log('\n✅ Versão publicada a 100%.')
