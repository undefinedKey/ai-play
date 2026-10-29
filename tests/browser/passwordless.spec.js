import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const URL = 'http://127.0.0.1:3108';
const PASSWORD = 'Only-for-browser-tests-2026!';
const authHeaders = csrf => ({ Origin: URL, ...(csrf ? { 'X-CSRF-Token': csrf } : {}) });
async function admin(request) {
  const response=await request.post(URL+'/api/auth/login',{headers:authHeaders(),data:{username:'admin_test',password:PASSWORD}});
  expect(response.status()).toBe(200); return response.json();
}
async function post(request,path,data,csrf) {
  const response=await request.post(URL+path,{headers:authHeaders(csrf),data});
  expect(response.ok()).toBe(true); return response.json();
}

test('免密码链接先预览确认，立即移除地址凭据且保留Skill配对，登录后无法重用', async ({ page, request }) => {
  const session=await admin(request);
  const link=await post(request,'/api/auth/link/create',{},session.csrf_token);
  const pairResponse=await request.post(URL+'/api/skill/pair',{data:{client_name:'免密码接入测试'}});
  const pair=await pairResponse.json();
  const address=new globalThis.URL(link.login_url); const token=new URLSearchParams(address.hash.slice(1)).get('login');
  address.searchParams.set('connect',pair.user_code);
  const requests=[]; page.on('request',request=>requests.push({url:request.url(),method:request.method()}));
  await page.goto(address.href);
  await expect(page.getByRole('heading',{name:'确认身份，进入广场'})).toBeVisible();
  await expect(page.getByRole('button',{name:'以 测试管理员 进入',exact:true})).toBeVisible();
  expect(new globalThis.URL(page.url()).hash).toBe('');
  expect(new globalThis.URL(page.url()).searchParams.get('connect')).toBe(pair.user_code);
  expect(requests.filter(request=>request.url===URL+'/api/auth/link')).toEqual([]);
  expect(requests.every(request=>!request.url.includes(token))).toBe(true);
  expect(await page.locator('body').innerText()).not.toContain(token);
  expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(token);
  expect((await (await page.request.get(URL+'/api/session')).json()).owner).toBeNull();
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(axe.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)}))).toEqual([]);
    await page.screenshot({path:`artifacts/passwordless-${viewport.width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'以 测试管理员 进入',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'让你的 AI 进入广场'})).toBeVisible();
  expect(requests.filter(request=>request.url===URL+'/api/auth/link'&&request.method==='POST')).toHaveLength(1);
  await page.getByRole('button',{name:'关闭弹窗',exact:true}).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  await page.goto(link.login_url);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button',{name:'以 测试管理员 进入',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'取消，返回原账号',exact:true}).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
});

test('账号设置按点击签发本人链接；管理员可生成有界AI邀请，成员不能越权', async ({ page, request, playwright }) => {
  const session=await admin(request);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.goto(URL);
  await expect(page.getByTestId('plaza-map')).toBeVisible();
  let created=0;page.on('request',request=>{if(request.url()===URL+'/api/auth/link/create')created++;});
  await page.getByRole('button',{name:'账号设置',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'账号与接入'})).toBeVisible();
  expect(created).toBe(0);
  await page.getByRole('button',{name:'生成免密码登录链接',exact:true}).click();
  await expect(page.getByLabel('一次性登录链接',{exact:true})).toHaveValue(/#login=/);
  expect(created).toBe(1);
  await page.getByRole('button',{name:'完成',exact:true}).click();
  await page.getByRole('button',{name:'账号设置',exact:true}).click();
  await page.getByRole('button',{name:'邀请 AI 直接加入',exact:true}).click();
  const invitationDialog=page.getByRole('dialog',{name:'邀请 AI 直接加入'});
  await expect(invitationDialog).toContainText('不会获得你的账号或管理员权限');
  await page.getByLabel('AI 邀请活动时长',{exact:true}).selectOption('1440');
  await page.getByLabel('AI 邀请调用上限',{exact:true}).selectOption('500');
  const sent=page.waitForRequest(request=>request.url()===URL+'/api/admin/ai-invites');
  await page.getByRole('button',{name:'生成 AI 邀请码',exact:true}).click();
  expect((await sent).postDataJSON()).toMatchObject({duration_minutes:1440,max_calls:500});
  const prompt=page.getByLabel('发给 AI 的接入提示词',{exact:true});
  await expect(prompt).toHaveValue(/plaza_ai_/);
  expect(await prompt.inputValue()).toContain(URL);
  expect(await prompt.inputValue()).toContain('24 小时');
  expect(await prompt.inputValue()).toContain('500 次');
  expect(await prompt.inputValue()).not.toContain(PASSWORD);
  await page.getByRole('button',{name:'选中手动复制',exact:true}).click();
  expect(await prompt.evaluate(element=>element.selectionEnd-element.selectionStart)).toBe((await prompt.inputValue()).length);
  await page.getByRole('button',{name:'我已保存，完成',exact:true}).click();

  const invite=await post(request,'/api/admin/invites',{},session.csrf_token);
  const memberContext=await playwright.request.newContext();
  try {
    const username='link_'+Date.now().toString(36);
    const member=await post(memberContext,'/api/auth/register',{username,name:'设备成员',password:'Member-Test-Password-2026!',invite_code:invite.invite_code});
    const ownLink=await post(memberContext,'/api/auth/link/create',{},member.csrf_token);
    const denied=await memberContext.post(URL+'/api/admin/ai-invites',{headers:authHeaders(member.csrf_token),data:{}});
    expect(denied.status()).toBe(403);
    // Existing page navigation to a new fragment must also remove the token and request confirmation.
    await page.goto(ownLink.login_url);
    await expect(page.getByRole('status')).toContainText('确认后将切换到 设备成员');
    const before=await (await page.request.get(URL+'/api/session')).json();
    expect(before.owner.role).toBe('admin');
    await page.getByRole('button',{name:'确认切换并以 设备成员 进入',exact:true}).click();
    await expect(page.getByTestId('plaza-map')).toBeVisible();
    await expect(page.getByRole('button',{name:'邀请成员',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'账号设置',exact:true}).click();
    await expect(page.getByRole('button',{name:'生成免密码登录链接',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'邀请 AI 直接加入',exact:true})).toHaveCount(0);
  } finally { await memberContext.dispose(); }
});

test('无效免密码链接不暴露身份，返回普通登录后仍可旁观', async ({ page }) => {
  await page.goto(URL+'/#login='+'x'.repeat(43));
  await expect(page.getByRole('alert')).toBeVisible();
  expect(new globalThis.URL(page.url()).hash).toBe('');
  await expect(page.getByRole('button',{name:/^以 .* 进入$/})).toHaveCount(0);
  await page.getByRole('button',{name:'返回账号入口',exact:true}).click();
  await expect(page.getByRole('heading',{name:'欢迎回到广场'})).toBeVisible();
  await expect(page.getByText(/无需查服务器密码/)).toBeVisible();
  await page.getByRole('link',{name:/先看看广场/}).click();
  await expect(page.getByTestId('plaza-map')).toBeVisible();
});
