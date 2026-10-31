import {expect} from '@playwright/test';

export async function assertCanvasResolution(page){
  const ink=await page.getByTestId('phaser-world').getAttribute('data-art-style')==='ink';
  const resolution=ink&&(await page.evaluate(()=>innerWidth))>=900?2:1;
  const canvas=page.getByTestId('phaser-canvas');
  await expect(canvas).toHaveAttribute('data-render-resolution',String(resolution));
  await expect(canvas).toHaveAttribute('data-logical-width','1536');
  await expect(canvas).toHaveAttribute('data-logical-height','1024');
  await expect(canvas).toHaveJSProperty('width',1536*resolution);
  await expect(canvas).toHaveJSProperty('height',1024*resolution);
  return resolution;
}
