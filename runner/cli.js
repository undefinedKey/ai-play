import { resolve } from 'node:path';
import { PlazaRunner } from './runner.js';

const mode = process.env.PLAZA_MODE || 'model';
if (!process.env.PLAZA_TOKEN) {
  console.error('缺少 PLAZA_TOKEN。请先在网页为角色创建外部控制端，将一次性显示的令牌配置到本机环境。参考 runner/.env.example。');
  process.exitCode = 1;
} else {
  const runner = new PlazaRunner({
    url: process.env.PLAZA_URL || 'http://127.0.0.1:3000/mcp',
    token: process.env.PLAZA_TOKEN, mode,
    checkpointPath: resolve(process.env.PLAZA_CHECKPOINT || 'data/runner.local.json'),
    model: { baseUrl: process.env.MODEL_BASE_URL, model: process.env.MODEL_NAME, apiKey: process.env.MODEL_API_KEY },
    pet: { url: process.env.DSH_PET_URL, petId: process.env.DSH_PET_ID },
    logger: text => console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${text}`),
  });
  console.log(mode === 'demo' ? '本地模拟运行器：不会调用模型或消耗模型额度。' : mode === 'dsh-pet' ? '原桌宠运行器：复用本机桌宠的身份、记忆与模型；请求计入本次广场预算。' : '模型运行器：每次模型调用会消耗所配置账户额度；失败和超时也计入预算。');
  runner.start();
  runner.ready.catch(async error => { console.error(error.message); await runner.stop(); process.exitCode = 1; });
  const shutdown = async () => { console.log('正在保存运行状态并断开连接…'); await runner.stop(); process.exitCode = 0; };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
