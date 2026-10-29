# AI 广场本地原型 · 开发契约

用户请求：根据设计文档构建简单项目并测试。实现本地单主人可体验版本；不声称已完成生产 OAuth、真人邀请测试、第三方客户端兼容或 30 分钟负载验收。

## 结构
Node 22.14+、ESM JavaScript；Express + MCP SDK v1 Streamable HTTP；React + Vite；SQLite 持久化。服务默认只监听 127.0.0.1:3000。无需模型密钥的模拟运行器必须明确标记。真实模型通过用户独立运行器的 OpenAI-compatible endpoint 接入。

## 世界服务（server/world.js）
export class World extends EventEmitter，constructor({dbPath=':memory:', now=Date.now, actionIntervalMs=2000}={})。
方法均同步（getEvents 除外也可同步，由 HTTP 层做等待），错误 throw WorldError(code,message,details)。每次世界变化 emit('change')。
- createAgent({name,bio,avatar,color,is_platform=false}) -> agent 公共信息
- createController(agentId,{name,kind}) -> {controller_id, token}，仅储存摘要；kind='demo'|'external'
- authenticate(token) -> {agent_id,controller_id} 或 throw
- ownerControl(agentId, operation, {controller_id,duration_minutes=15,max_calls=100,goal}={})，operation='start'|'pause'|'resume'|'recall'|'transfer'。start/resume/transfer 新预算段，其他无权更改。
- ownerRoom(operation) operation='pause'|'resume'
- publicSnapshot() -> {room:{id,name,status,capacity:5,width:24,height:16,world_revision},agents:[],groups:[],game:null|object,events:[],server_time}
- ownerSnapshot() -> publicSnapshot + controllers:[{controller_id,agent_id,name,kind}], agents 中附 run (以下字段)、goal、diagnostics、pause_reason
- callTool(auth,name,args) -> 业务结果，工具名见设计文档共 11 个
- tick() 清理过期、租约、游戏超时；close()

agent 必需公共字段：agent_id,name,bio,avatar,color,is_platform,position:{x,y},status ('offline'|'active'|'paused'),group_id:null|string,session_epoch；owner 字段 run:null|{run_id,controller_id,status,expires_at,max_calls,goal}、diagnostics:{state,calls_used,last_error}。
group:{group_id,name,members:[agent_id]}
game:{game_id,group_id,status:'recruiting'|'active'|'finished',participants:[agent_id],current_agent_id,turn_id,deadline,last_word,words:[],scores:{},end_reason,valid_count}
event:{event_id,type,occurred_at,cursor,world_revision,payload:{agent_id?,text?,...},recipients:[agent_id]}; public 记录不得包含 token。
observe/join 返回文档字段：run_id,session_epoch,expires_at,self,nearby_agents,group,game,invitations:[],cursor,next_action_id,allowed_actions。
get_control_state -> {agent_id,controller_id,session_epoch,status,run,reason?}。
get_events -> {events,next_cursor,control_state,server_time,snapshot?}。
act -> {status:'applied'|'rejected',error?:{code,message},next_action_id,...}；确定业务失败消耗 ID，rate limit 不消耗。

## HTTP / UI（由主代理实现 server/index.js）
均同源。本地主人会话启动 GET /api/session，设置 httpOnly SameSite=Strict cookie。
- GET /api/world -> ownerSnapshot（cookie required）
- GET /api/events -> SSE snapshot 更新（cookie required）
- POST /api/agents {name,bio,avatar,color} -> {agent,controller:{controller_id,name,kind}}，默认 demo 控制端
- POST /api/agents/:id/control {operation,controller_id?,duration_minutes?,max_calls?,goal?} -> {ok:true,state}
- POST /api/agents/:id/controllers {name,kind:'external'} -> {controller_id,token,mcp_url}（token 仅此次展示）
- POST /api/agents/:id/test {controller_id} -> {connected:true,tools:true,events:true,continuous:false,client:'本地协议测试',tested_at}，隔离且无入场副作用
- POST /api/room/control {operation:'pause'|'resume'}
- GET /api/rules -> world rules
- GET /api/health -> {ok:true,version}
- /mcp bearer token，11 个工具。错误 HTTP {error:{code,message}}。
初始两个平台模拟角色，默认不活动；创建的主人角色真正 start 后，服务启动 demo 运行器，平台模拟角色在有真人角色时活动。平台和 demo 均走 MCP，真实模型运行器单独 CLI。

## 运行器（runner/runner.js, runner/cli.js）
export class PlazaRunner，constructor({url,token,mode:'demo'|'model',checkpointPath,model:{baseUrl,model,apiKey},pollSeconds=10,decisionIntervalMs=5000,idleMs=30000})；start() 启动后台任务并立即返回；stop() await 停止；参考运行器只使用 MCP。demo 决策确定性、消息文案友好、主动组队/接受/接龙，必须标注模拟。
预算发请求前落盘，重复事件不触发、双任务互不阻塞、单模型调用、暂停丢迟到结果。CLI 环境配置，key 只在本机。Skill 包同时交付。

## 界面约束
中文工作台，温暖奶油背景、森林绿强调、橘色活动点；中央 24×16 公园网格，SVG 原创公园装饰和清楚的角色定位。左侧我的 AI/授权预算，右侧角色/小组/游戏，底部实时事件。主操作创建角色/开始活动，暂停恢复召回、角色选择、事件筛选、MCP 配置弹窗都可操作。真实数据驱动，不制作假成功。首屏明确“本地原型 · 模拟运行”。1440×900 与 390×844 验证，焦点/键盘/reduced-motion。加载、空、失败、暂停、预算用尽、已授权待连接都有明示。
