# 服务器邀请测试版契约

用户：Linux服务器，未装Docker，邀请少量用户各自接入AI，无域名先IP测试。以原生Node + systemd为主，Docker可选。根代理负责server/index.js/config.js/world.js所有者绑定和集成测试。保持本地演示默认行为。

## 账号模块（auth代理）
server/auth.js export class AccountStore extends? 普通class即可。
constructor({dbPath=':memory:',now=Date.now}={})；SQLite独立auth.sqlite，同一data目录。
- async createAdmin({username,password,name}) -> owner；仅CLI使用，已有同名不静默覆盖。
- async login({username,password}) -> {owner,token,csrf_token,expires_at}，失败throw code INVALID_CREDENTIALS
- async register({username,password,name,invite_code}) -> 同login；邀请码一次性、有期限、消费与创建事务；角色固定member。
- session(token) -> null|{owner,csrf_token,expires_at}；只存token摘要，不泄露password/hash。
- logout(token) -> void
- createInvite(ownerId,{expires_hours=72}={}) -> {invite_code,expires_at,invite_id}；再次检验admin身份
- listInvites(ownerId) -> 无原始token的邀请列表（可不实现UI历史）
- firstAdmin() -> owner|null；getOwner(id) -> owner|null；close()
owner={id,username,name,role:'admin'|'member'}。
密码12–128字符；用户名3–32 ASCII字母数字下划线连字符（大小写标准化）；密码异步scrypt+随机salt/timingSafeEqual；合理scrypt参数、session24小时。
错误可用AuthError(code,message)，无SQL敏感信息。数据库失败不能假成功。认证速率限制由HTTP层负责。
server/admin.js CLI从环境读取 PLAZA_AUTH_DB 或 PLAZA_DB同目录/auth.sqlite、PLAZA_ADMIN_USERNAME、PLAZA_ADMIN_PASSWORD、PLAZA_ADMIN_NAME，用 node --env-file=... server/admin.js create-admin 创建一次管理员；stdout只显示账号名不显示密码；不得通过网页先到先得创建管理员。

## 环境（根代理）
PLAZA_AUTH_MODE=local|accounts 默认local；HOST 默认127.0.0.1；PORT默认3000；PLAZA_PUBLIC_URL（accounts必填）如http://SERVER_IP:3000；PLAZA_ALLOW_HTTP=1 才可accounts非HTTPS IP测试；PLAZA_DB=/var/lib/ai-plaza/world.sqlite；PLAZA_AUTH_DB默认同目录auth.sqlite；PLAZA_DEMO默认0，仅显式1提供开发模拟控制端，不再生成默认角色。
local模式禁止绑定非loopback。accounts使用确定publicURL校验Host/Origin；本机127.0.0.1:实际port仅在req.socket.remoteAddress loopback时接受，用于内置runner/health。不信任客户端X-Forwarded-For；上层代理配置不透明放宽。HTTPS cookie Secure，IP测试http cookie不Secure需明确opt-in。

## 前端/HTTP（frontend代理）
GET /api/session -> {owner:null|owner,mode:'local-prototype'|'accounts',csrf_token?:string}；未登录是200，不自动获得账号。
POST /api/auth/login {username,password} -> session；POST /api/auth/register {username,password,name,invite_code} -> session；POST /api/auth/logout -> {ok:true}。
登录注册无CSRF token但严格同源Origin与JSON Content-Type；其余所有accounts写接口需 X-CSRF-Token=session.csrf_token。cookie HttpOnly SameSite=Strict。
GET /api/world -> public快照+own私有信息；agents[i].is_mine boolean，controllers仅自己的；own agents包含run/goal/diagnostics，别人只有公开字段；snapshot.viewer=owner。
SSE相同按观看者过滤，注销/会话过期后连接关闭。HTTP401前端回到登录页。
POST /api/admin/invites {expires_hours:72} -> {invite_code,expires_at,invite_id}；仅admin可调用。邀请码只此次展示，界面提供复制（HTTP IP clipboard缺失需可选中手动复制/可靠fallback）。
POST /api/room/control只有admin，member UI隐藏。角色API仅owner本人可操作，管理员也不能冒用成员角色。
已有公共浏览数据需要登录（邀请房间非公开匿名观众）。我的AI筛选用is_mine，旧local兼容!platform。
前端实现账号登录/邀请码注册/注销、管理员生成邀请码模态；既有公园风格保留。服务端模式文案改“邀请测试”，明确模拟仅平台/demo控制端。后台新功能无需引入营销界面。

## 部署产物（deploy代理）
deploy/ai-plaza.service、deploy/server.env.example、deploy/admin.env.example、deploy/Caddyfile.example（将来域名HTTPS）、docs/服务器部署.md。Node22最新版LTS（项目已实测22.14，服务器用受支持修补版），目录/opt/ai-plaza、data/var/lib/ai-plaza、低权限系统用户ai-plaza。先npm ci npm run build，再管理员CLI初始化，systemd常驻。端口3000实例1个，SQLite及auth和demo checkpoint同一持久目录备份。
不要编造仓库URL或服务器IP。无实际服务器凭据，不声称线上部署完成。HTTP仅短期IP测试，明确密码/token明文传输；正式启用域名TLS。备份与回滚说明可操作并停止服务保证SQLite文件一致。不用Docker作为前提，未执行的Linux/systemd步骤明确待服务器验证。
