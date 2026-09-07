const sharp=require('sharp');
const lum=c=>0.299*c[0]+0.587*c[1]+0.114*c[2];
const ALVOS={
  branco: c=>c[0]>175&&c[1]>175&&c[2]>175,
  creme:  c=>c[0]>195&&c[1]>180&&c[2]>160,
  dourado:c=>c[0]>150&&c[1]>105&&c[2]<140&&c[0]-c[2]>55,
  escuro: c=>lum(c)<70,
};
const med=a=>a.sort((p,q)=>p-q)[a.length>>1];
const hex=c=>'#'+c.map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');

/**
 * Troca o número de uma arte mantendo posição, altura e largura exatas.
 * Repinta só o desenho do número antigo (mais a sombra dele), sem encostar
 * no "cada", no "R$" nem na borda da caixa.
 *
 * win    [x,y,w,h]  janela onde procurar o número
 * limite [x0,y0,x1,y1] área que o remendo NUNCA ultrapassa
 */
module.exports = async function trocar(src,out,win,novo,opt={}){
  const {data,info}=await sharp(src).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const W=info.width,H=info.height,C=info.channels;
  const P=(x,y)=>{const i=(y*W+x)*C;return [data[i],data[i+1],data[i+2]]};
  const alvo=ALVOS[opt.alvo||'branco'];
  const [wx,wy,ww,wh]=win;

  const marca=new Uint8Array(W*H);
  let L=1e9,R=-1,T=1e9,B=-1;const cores=[[],[],[]];
  for(let y=wy;y<wy+wh;y++)for(let x=wx;x<wx+ww;x++){const c=P(x,y);
    if(alvo(c)){ marca[y*W+x]=1; if(x<L)L=x; if(x>R)R=x; if(y<T)T=y; if(y>B)B=y;
      cores[0].push(c[0]);cores[1].push(c[1]);cores[2].push(c[2]); }}
  if(R<0) throw new Error('nao achei o numero em '+src);
  const corTexto=opt.cor||hex(cores.map(med));

  const lim=opt.limite||[0,0,W-1,H-1];
  const dentro=(x,y)=>x>=lim[0]&&x<=lim[2]&&y>=lim[1]&&y<=lim[3];

  // a sombra escura colada no número antigo também tem que sair
  const somb=opt.raioSombra??0, limS=opt.limSombra??110;
  if(somb>0){ const add=[];
    for(let y=Math.max(0,T-somb);y<=Math.min(H-1,B+somb);y++)
      for(let x=Math.max(0,L-somb);x<=Math.min(W-1,R+somb);x++){
        if(marca[y*W+x]||!dentro(x,y)||lum(P(x,y))>limS) continue;
        let perto=0;
        for(let dy=-somb;dy<=somb&&!perto;dy++)for(let dx=-somb;dx<=somb;dx++){
          const yy=y+dy,xx=x+dx; if(yy>=0&&yy<H&&xx>=0&&xx<W&&marca[yy*W+xx]){perto=1;break;}}
        if(perto) add.push(y*W+x);
      }
    for(const i of add) marca[i]=1;
  }

  const k=opt.folga??3;
  const px=Math.max(lim[0],L-k), py=Math.max(lim[1],T-k);
  const pw=Math.min(W-1,lim[2],R+k)-px+1, ph=Math.min(H-1,lim[3],B+k)-py+1;
  const mask=new Uint8Array(pw*ph);
  for(let y=py;y<py+ph;y++)for(let x=px;x<px+pw;x++){
    let on=0;
    for(let dy=-k;dy<=k&&!on;dy++)for(let dx=-k;dx<=k;dx++){
      const yy=y+dy,xx=x+dx;
      if(yy>=0&&yy<H&&xx>=0&&xx<W&&marca[yy*W+xx]&&dx*dx+dy*dy<=k*k+k){on=1;break;}}
    mask[(y-py)*pw+(x-px)]=on?255:0;
  }


  // fundo liso: em cartao de cor chapada da pra dizer a cor em vez de calcular
  const rgbDe=h=>[1,3,5].map(i=>parseInt(h.substr(i,2),16));
  const fixo=opt.corFundo? (Array.isArray(opt.corFundo)?opt.corFundo:[opt.corFundo,opt.corFundo]).map(rgbDe) : null;
  const busca=opt.busca??18, teto=(opt.tetoFundo===null?null:(opt.tetoFundo??175));
  const rgba=new Uint8Array(pw*ph*4);
  for(let r=0;r<ph;r++){
    const y=py+r; const rr=[],gg=[],bb=[];
    const x0=Math.max(0,lim[0],px-busca), x1=Math.min(W,lim[2]+1,px+pw+busca);
    for(let x=x0;x<x1;x++){
      const c=P(x,y);
      if(marca[y*W+x]||alvo(c)) continue;
      if(teto!=null&&lum(c)>teto) continue;   // vizinho claro (o "cada", o "R$") nao entra na media
      rr.push(c[0]);gg.push(c[1]);bb.push(c[2]);}
    const t=ph>1?r/(ph-1):0;
    const cor= fixo? [0,1,2].map(i=>fixo[0][i]+(fixo[1][i]-fixo[0][i])*t)
                   : (rr.length?[med(rr),med(gg),med(bb)]:[0,0,0]);
    for(let j=0;j<pw;j++){const i=(r*pw+j)*4;
      rgba[i]=cor[0];rgba[i+1]=cor[1];rgba[i+2]=cor[2];rgba[i+3]=mask[r*pw+j];}
  }
  const remendo=await sharp(Buffer.from(rgba),{raw:{width:pw,height:ph,channels:4}}).png().toBuffer();

  const soDigitos=opt.base==='digitos';
  const fs=(B-T)/((!soDigitos&&/[,.]/.test(novo))?0.938:0.808);
  const base=T+0.808*fs;
  const ajX=opt.ajusteX??0, larg=(R-L+1)+(opt.ajusteLarg??0);
  const s=opt.sombra;
  const linha=(dx,dy,fill)=>`<text x="${(L+ajX+dx).toFixed(2)}" y="${(base+dy).toFixed(2)}" font-family="Impact" font-size="${fs.toFixed(2)}" fill="${fill}" textLength="${larg}" lengthAdjust="spacingAndGlyphs">${novo}</text>`;
  const txt=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    +(s?linha(s.dx,s.dy,s.cor):'')+linha(0,0,corTexto)+`</svg>`;

  await sharp(src).composite([{input:remendo,left:px,top:py},{input:Buffer.from(txt),left:0,top:0}])
    .jpeg({quality:88,chromaSubsampling:'4:4:4'}).toFile(out);
  return {L,R,T,B,fs:+fs.toFixed(1),corTexto};
};
