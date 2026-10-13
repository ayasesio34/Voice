import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

/**
 * 签发 LiveKit 接入 token。
 *
 * ⚠️ 这个函数用到 LIVEKIT_API_SECRET，**只能在服务端调用**。
 * 绝对不要把 secret 打包进客户端 —— 那等于把服务器钥匙发出去，
 * 任何人都能伪造身份、往任意房间推流。
 *
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.apiSecret
 * @param {string} o.identity  参与者唯一标识，同一房间内不能重复
 * @param {string} o.name      显示名
 * @param {string} o.room      房间名（本项目的"频道"直接当房间名用）
 * @param {string} [o.ttl]     token 有效期，默认 12 小时
 */
export async function createAccessToken({
  apiKey,
  apiSecret,
  identity,
  name,
  room,
  ttl = '12h',
}) {
  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name,
    ttl,
  });

  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,        // 发麦克风 / 屏幕
    canSubscribe: true,      // 收别人的流
    canPublishData: true,    // 走 data channel（表情、举手之类）
    canUpdateOwnMetadata: true,
  });

  // v2 SDK 的 toJwt() 是异步的
  return await at.toJwt();
}

/**
 * LiveKit 的服务端查询客户端。
 *
 * 用来回答「每个语音频道里现在有谁」—— 客户端自己只能看到它加入的那个房间，
 * 其它房间的占用情况必须由服务端去问 LiveKit。
 *
 * ⚠️ 这里要用**本地** HTTP 地址（127.0.0.1:7880），不要用对外的 ws:// 域名/IP。
 *    后端和 LiveKit 在同一台机器上，走环回更快也更稳。
 *
 * @param {string} apiUrl  形如 http://127.0.0.1:7880
 * @param {string} apiKey
 * @param {string} apiSecret
 */
export function createRoomService(apiUrl, apiKey, apiSecret) {
  return new RoomServiceClient(apiUrl, apiKey, apiSecret);
}
