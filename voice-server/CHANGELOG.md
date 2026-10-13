# 服务端改动记录

> 服务端版本号写在 `backend/src/version.js`（`SERVER_VERSION`），
> `GET /health` 会报出来 —— 部署完扫一眼就知道服务器上跑的是哪一版。
>
> **版本号只改那一个地方。**

---

> **记号约定**：本文里 `✓` 表示「已经做了 / 推荐这样做」，`✗` 表示「没做 / 不要这样做 / 踩过的坑」。
> 这套记号是开发过程中的工作约定，所以只出现在 CHANGELOG 里，README 用的是普通书面语气。

## 1.4.1

### 🛠 `fix-member.mjs list` 改成能**分辨真人和幽灵**

**症状**：名单里有好几个 `用户XXXX` ✗ 分不清谁才是真正的人 ✗

**先搞清楚 `用户XXXX` 是谁造的** —— 都在 1.4.0 我加的代码里，是**两种不同情况**：

| 位置 | 什么时候触发 | 后果 |
|---|---|---|
| `index.js` 843 行 | `userKey` 对不上 ✗ | **凭空新建一个成员** ✗ ← "多了好几个"就是这里 |
| `index.js` 868 行 | 昵称和 `OWNER_NAME` 撞了 ✗ | 把**已有的人改名**成 `用户XXXX` ✗ ← "分不清谁是真的" |

**判断真人的关键**：**创建之后还回来过吗**

```
幽灵：只在被创建的那一刻上线过一次，之后再也不来
      → last_seen 和 created_at 几乎相同
真人：会反复上线
      → last_seen 明显晚于 created_at
```

⚠️ **光看 `last_seen` 不够** ✗ —— 幽灵可能是**今天**才冒出来的 ✗
那它的 `last_seen` 也是"刚刚" ✗ 会和真人混在一起 ✓ 必须比这两个时间 ✓

现在 `list` 会把两个时间都打出来、按最后在线排序，并给疑似幽灵标 👻 ✓
**被改名过的真人不会被误标** ✓（因为他还回来过 ✓）并附一句"先别删" ✓

顺手把版本号补到 **1.4.1**（这个号之前只写进了 CHANGELOG ✗ 没落到 `version.js` ✗）——
部署脚本现在会比对版本号 ✓ 两边不一致的话部署会**报错退出** ✓

---

### 🛠 部署脚本：清单改成自动生成 + 复核真的会对比

**症状**：代码改了、`deploy.cmd` 也"成功"了，但服务器上跑的还是旧的 ——
`/health` 一直显示 `serverVersion = 1.0.0`。

**根因**：`$Files` 是**手写清单** ✗，而 `src` 下有三个文件从来没被列进去：

```
version.js       ← 所以版本号永远是旧的
livekit.js
voice-chime.js
```

**更糟的是上传脚本自己没发现** ✗ —— 复核那一步只是把服务器上的
`serverVersion` **念了一遍**，根本没和本地比 ✗ 于是"文件没传上去"
被打印成一行绿油油的 `[OK]` ✗ 看着像成功。

两处都改了：

1. **清单自动生成**（`src` 下所有 `.js` / `.mjs`）——
   手写清单迟早和真实目录对不上，和之前那个写死的 `mv` 是同一个教训。
2. **复核和本地 `version.js` 对比**，不一致就报错退出，
   并提示去服务器上看文件时间戳。

> 实际影响：`index.js` / `db.js` 一直在清单里，所以**功能其实是活的** ✓
> 只有版本号显示不对（外加 `livekit.js` / `voice-chime.js` 的任何改动没上去）。

---

## 1.4.0

### 新增 `games` 表 + `reportGame` 消息（全服共享的游戏库）

一个人上报过，所有人以后都能检测到 —— 不用各报各的。

**表是新的**，所以 `CREATE TABLE IF NOT EXISTS` 对老库也生效，
**不用手工改库、也不用走 migrate()**（那个是给"新加的列"用的）。

```sql
CREATE TABLE IF NOT EXISTS games (
  exe        TEXT PRIMARY KEY,   -- 小写、不带 .exe，和 Get-Process 的 ProcessName 对齐
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

- `welcome` 里带上 `games`（和 channels/members 并列）——
  所以**后来的人连上就直接能用**。
- WS `reportGame`：**任何已加入的成员**都能报，不需要管理员。
  有变化才 `broadcast({type:'games', games})`。
- 规整一律在 `upsertGame` 里（小写、去 `.exe`、名字截 40 字）。
  放调用方做的话早晚有人漏掉，然后同一个游戏会出现好几条。

`test-games.mjs` **8 条**端到端，含"新连上的人 welcome 里直接就有"。

---

## 1.3.0

### `activity` 支持 `kind: 'game'`

配合客户端的「正在玩游戏」。和听歌**共用同一条路径**（同一个 `activity`
字段、同一个 `presence` 广播），只是 `kind` 不同：

```js
if (a.kind !== 'music' && a.kind !== 'game') return null;   // 别的一律丢掉
```

游戏的 `artist` 是空串（服务端照样截断到 80 字）。

⚠️ `activity` 的内容**由客户端提供、广播给所有人** —— 所以类型校验和长度
截断（title 120 / artist 80）一个都不能少，不然别人可以塞几十万字把所有人的
界面撑爆。

`test-activity.mjs` 加到 12 条：新增「kind=game 也能广播」和
「不认识的 kind 被丢掉」。

---

## 1.2.0

### 新增：`removeMember`（只有频道主能调用）

配合客户端的「移除成员」菜单。他会立刻断开、`members` 那一行被删掉、
名册和在线列表都会广播刷新。

**权限判断在服务端**：客户端的按钮只是不给入口，伪造消息照样得被拦。

```js
if (!actor || actor.role !== 'owner') return deny('forbidden');
if (targetId === myUserId) return deny('cannot_remove_self');   // ← 必须放在前面
if (target.role === 'owner') return deny('cannot_remove_owner');
```

> 那两条顺序不能反：频道主也是 owner，反了的话"移除自己"会命中下面那条，
> 报出「不能移除频道主」这种看不出问题的提示（测试当场抓到的）。

**只删 `members` 那一行** —— 他发过的消息、上传的文件都留着。
和 Discord 一样：人走了，聊天记录不该出现空洞。

**这是踢出，不是封禁** —— 身份没了，但清掉本地配置重连会拿到新身份。
真要挡住人得换 `INVITE_CODE`。

新增 `test-remove-member.mjs`（10 条端到端）。

---

## 1.1.0

### 🛠 部署脚本：加了一道编码护栏（`check-bom.ps1`）

`deploy.ps1` 一度**丢了 UTF-8 BOM**，于是 Windows PowerShell 5.1 按 ANSI 读它，
中文注释变成乱码，某些字节组合把引号吃掉，报出来的是这种**完全指错方向**的错误：

```
标记"||"不是此版本中的有效语句分隔符。
标记"&&"不是此版本中的有效语句分隔符。
字符串缺少终止符: "。
```

看起来像脚本逻辑坏了，其实是**编码问题**。这个坑本项目踩过三次，
每次都是编辑器重写文件之后。

现在 `deploy.cmd` 会**先跑** `check-bom.ps1`：

- 扫全仓库的 `.ps1`，凡是「有非 ASCII 字符但没有 BOM」就报出来并中止部署
- 报错里直接给修复命令
- `check-bom.ps1` 自己是**纯 ASCII**（所以它不需要 BOM —— 否则就成了先有鸡还是先有蛋）

> 负向测试过：造一个「有中文、没 BOM」的脚本 → 正确拦下（退出码 1）；
> 删掉 → 恢复正常。

---

### 🔒 安全修复：改个昵称就能抢走频道主

**这是个真实的提权漏洞，而且已经造成过实际后果**
（服务器上曾经一次出现 3 个都叫频道主名字的成员）。

#### 漏洞是怎么成立的

两个问题凑在一起：

**① 昵称等于 `OWNER_NAME` 就自动提拔成频道主**

```js
// 改之前
if (isWantedOwner) role = 'owner';
// 而且 makeOwner 会把原来的频道主降级成 admin
```

`OWNER_NAME` 是配置在 `.env` 里的（例如 `Owner`），
而**任何成员都能在设置里把昵称改成它** —— 于是谁都能把自己提成频道主，
还会把真正的频道主踢下去。

**② `userId` 对但 `userKey` 不对时，服务端静默新建一个成员**

```js
// 改之前
if (existing && existing.user_key !== userKey) {
  userId = randomUUID();   // ← 直接建一个新的
  existing = null;         // ← 而且名字采信客户端传的
}
```

两条加在一起：随便编个 userId + 随便编个 key + 名字填 `OWNER_NAME`，
就能凭空造出一个**频道主**。

#### 改成了什么

| 位置 | 现在的行为 |
|---|---|
| `db.js` `registerMember` | 只有**还没有频道主**时才按昵称认领（首次搭建）。已经有频道主之后，昵称再也换不来角色 |
| `index.js` hello 处理 | key 不对 → **名字不采信**，换成中性的「用户XXXX」，角色一定是 `member` |
| `index.js` hello 处理 | 别人报频道主的名字 → 同样换成「用户XXXX」（**名字由频道主独占**） |

#### ⚠️ 代价：换电脑拿回频道主不再是自动的

以前"名字对上就能拿回频道主"。现在这条路堵死了（它本身就是漏洞），
改成在服务器上跑一条命令：

```bash
# 1. 在新电脑上装好、连上去（会得到一个全新身份）
# 2. 在名单里找到那个新身份的 userId
./member.cmd list
# 3. 提成频道主
./member.cmd promote <新身份的 userId>
```

> `member.cmd` 会 ssh 到服务器执行 `src/fix-member.mjs`（会问一次密码）。

#### 验证

新增 `test-identity.mjs` —— **端到端**，起真服务端 + 真 WebSocket：

```
✅ ① 还没有频道主时，昵称对得上 → 拿到 owner（首次搭建）
✅ ② ★ 已经有频道主了，另一个人也叫 Owner → 只能是 member
✅ ③ 原来的频道主没被顶掉
✅ ④ ★ 已有成员把昵称改成 Owner → 角色不变（这才是提权口子）
✅ ⑤ ★ userId 对、key 错 → 不能顶掉频道主
✅ ⑥ ★ 冒充时名字不被采信
✅ ⑦ 冒充进去的人角色是 member
✅ ⑧ ★ 不管怎么折腾，全服只有一个 owner
✅ ⑨ 全服名册里没有重复的 OWNER_NAME
```

9/9 通过。

> 写第一版补丁时漏了「还没有频道主」这个条件，结果**谁也拿不到频道主** ✗ ——
> 测试 ① 当场抓到，已修。

---

### 新增：`src/fix-member.mjs` 维护工具

改成员名字、提拔频道主、删掉多余的成员。**动库前自动备份**。

```bash
node src/fix-member.mjs list
node src/fix-member.mjs rename <userId> <新名字>
node src/fix-member.mjs promote <userId>
node src/fix-member.mjs delete <userId>
```

从 Windows 上用 `member.cmd <子命令>` 走，会自动 ssh 过去。

> 拒绝删除 `owner` 角色的人 —— 要删先降级。

---

## 1.0.0

最初的版本号，之前服务端没有版本号。
