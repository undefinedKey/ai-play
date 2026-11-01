import {expect} from '@playwright/test';

export async function assertCanvasResolution(page){
  const ink=await page.getByTestId('phaser-world').getAttribute('data-art-style')==='ink';
  const canvas=page.getByTestId('phaser-canvas');
  const backend=await canvas.evaluate(element=>{
    const gl=element.getContext('webgl')||element.getContext('webgl2');let description='';
    if(gl)try{const info=gl.getExtension('WEBGL_debug_renderer_info');description=gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER);}catch{try{description=gl.getParameter(gl.RENDERER);}catch{}}
    return /swiftshader|llvmpipe|softpipe|software\s+rasterizer|microsoft\s+basic\s+render\s+driver/i.test(description)?'software':'hardware-or-unknown';
  });
  const resolution=ink&&backend==='hardware-or-unknown'&&(await page.evaluate(()=>innerWidth))>=900?2:1;
  await expect(canvas).toHaveAttribute('data-render-backend',backend);
  await expect(page.locator('.phaser-canvas-host')).toHaveAttribute('data-render-backend',backend);
  await expect(canvas).toHaveAttribute('data-render-resolution',String(resolution));
  await expect(canvas).toHaveAttribute('data-logical-width','1536');
  await expect(canvas).toHaveAttribute('data-logical-height','1024');
  await expect(canvas).toHaveJSProperty('width',1536*resolution);
  await expect(canvas).toHaveJSProperty('height',1024*resolution);
  return resolution;
}
