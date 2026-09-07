# Trocar o preço escrito dentro da arte

As artes de divulgação da **Sorveteria CDBom** têm o preço impresso na imagem
("R$ 18,00", "2,20 cada"). Quando o preço muda no cadastro, a foto continua
anunciando o valor velho, e ela não dá para editar pelo sistema — é imagem
pronta, feita fora.

`trocar.js` reescreve só o número, no mesmo lugar, no mesmo tamanho e na mesma
largura. Ele apaga o desenho do número antigo (mais a sombra), refaz o fundo
copiando a cor real da arte, e escreve o número novo por cima. O "R$", o
"cada", a borda da caixa e o resto da arte não são tocados.

## Usar

```js
const trocar = require('./trocar')

await trocar(
  'arte-antiga.jpg',
  'arte-nova.jpg',
  [316, 158, 76, 39],   // janela onde procurar o número (x, y, largura, altura)
  '2,50',               // o preço novo
  { alvo: 'creme', limite: [316,157,391,196], corFundo: ['#e60610','#c1030a'] }
)
```

- **win** precisa conter SÓ o número. Se pegar o "cada" ou a borda da caixa, a
  medida sai errada e o remendo fica grande demais.
- **alvo**: a cor do número — `branco`, `creme`, `dourado` ou `escuro`.
- **limite** `[x0,y0,x1,y1]`: o remendo nunca passa daí. É o que protege o
  "R$" ao lado e o "cada" embaixo.
- **corFundo**: em cartão de cor chapada, diz a cor (uma só, ou duas para o
  degradê de cima para baixo). Sem isso, a cor é calculada linha a linha —
  melhor quando o fundo tem textura.
- **raioSombra** / **limSombra**: apagam a sombra escura do número antigo.
- **sombra** `{dx,dy,cor}`: desenha a sombra do número novo.

Ver `exemplo-cdbom.js` para os valores reais usados em setembro de 2026.

## O que não dá

A arte da **Moreninha** tem o preço inclinado, colado na pastilha preta do
"cada" e no contorno escuro do selo. Não sai limpo — essa precisa do designer.

## Voltar atrás

`backup-fotos-cdbom-2026-09-07.json` guarda o endereço da foto original de cada
produto. Os arquivos antigos continuam no Storage: as artes novas subiram com
nome próprio (`...-p2026-09-07.jpg`), nada foi apagado.
