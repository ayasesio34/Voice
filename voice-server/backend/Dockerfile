# ⚠️ 已弃用，仅作参考
#
# 本项目最终没有用 Docker，原因是国内从 Docker Hub 拉镜像会频繁失败
# （unexpected EOF / unknown error），配镜像源也治不好 —— 阿里云的加速器
# 只加速"官方镜像"，livekit/livekit-server 不在其列。
#
# 现在 LiveKit 用官方 18 MB 单文件二进制 + systemd 直接跑，
# 部署流程见 开始操作.md，运维命令见 README.md。
#
# 如果将来要部署到境外服务器（Docker Hub 可达），这个 Dockerfile 仍然可用，
# 但需要自己补一个 compose 文件把 livekit 服务也加进来。
#
# 用 Debian(glibc) 基础镜像而不是 alpine(musl)：
# 某些原生依赖在 glibc 下有预编译二进制，alpine 上需要现场编译。
FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

# 先只拷 package.json，让 npm install 这层能被 Docker 缓存
COPY package.json ./

# 走国内 npm 源会快很多
RUN npm install --omit=dev --no-audit --no-fund \
      --registry=https://registry.npmmirror.com \
 && npm cache clean --force

COPY src ./src

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3005

CMD ["node", "src/index.js"]
