const trocar=require('./trocar');const SP=__dirname;
const lista=[
 {f:'16_Dad_.jpg', win:[55,168,78,38], novo:'1,25', alvo:'dourado',
  limite:[58,169,128,206], raioSombra:2, folga:3},
 {f:'21_Picol_Del_cia.jpg', win:[97,289,76,32], novo:'2,50', alvo:'dourado',
  limite:[97,289,169,321], raioSombra:4, limSombra:78, folga:3,
  corFundo:['#ac0004','#960203'], sombra:{dx:-1.5,dy:1.5,cor:'#6b1207'}},
 {f:'24_Picol_Premium.jpg', win:[296,316,108,52], novo:'2,50', alvo:'dourado',
  limite:[296,316,403,367], raioSombra:5, limSombra:62, folga:3,
  corFundo:['#820009','#6d0202'], sombra:{dx:-2,dy:2,cor:'#4d0d05'}},
 {f:'27_Sorvete_CDBOM_Pote_200_ml_.jpg', win:[316,158,76,39], novo:'2,50', alvo:'creme', base:'digitos',
  limite:[316,157,391,196], raioSombra:2, limSombra:92, folga:3, ajusteX:4, ajusteLarg:-4,
  corFundo:['#e60610','#c1030a'], sombra:{dx:-1.5,dy:1.5,cor:'#8f0b12'}},
];
(async()=>{for(const a of lista){
 try{ console.log(a.f.padEnd(38), JSON.stringify(await trocar(SP+'/artes/'+a.f, SP+'/novas/'+a.f, a.win, a.novo, a))); }
 catch(e){ console.log(a.f,'ERRO',e.message); }
}})();
