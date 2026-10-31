import {expect} from '@playwright/test';

// Exercise the same keyboard-accessible map controls as a spectator. The owner
// dashboard retains its management selector; /watch has no resident roster.
export async function selectObservedAgent(page,id){
  const ownerSelector=page.getByLabel('观察对象',{exact:true});
  if(await ownerSelector.count()){await ownerSelector.selectOption(id);return;}
  const views=page.getByRole('group',{name:'世界视图'});
  const initial=await views.locator('button[aria-pressed="true"]').first().textContent();
  let unit=page.locator(`.world-actor[data-testid$="-${id}"]`);
  if(!await unit.count()){
    for(const name of['社交广场','冒险地图']){
      await page.getByRole('button',{name,exact:true}).click();
      // Scene switch may first fetch its own complete snapshot.
      await expect(page.getByTestId('phaser-world')).toHaveAttribute('data-renderer-state','ready');
      if(await unit.count())break;
    }
  }
  await expect(unit).toHaveCount(1);await unit.focus();await page.keyboard.press('Enter');
  if(initial)await page.getByRole('button',{name:initial.trim(),exact:true}).click();
}
