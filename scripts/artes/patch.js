const sharp=require('sharp');
// patch(src, out, svgInner, w, h) — sobrepõe um SVG do tamanho da imagem
module.exports = async function patch(src,out,inner,quality=82){
  const m=await sharp(src).metadata();
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}">${inner}</svg>`;
  await sharp(src).composite([{input:Buffer.from(svg),top:0,left:0}]).jpeg({quality,chromaSubsampling:'4:4:4'}).toFile(out);
  return out;
};
