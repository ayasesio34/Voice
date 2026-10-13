import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          // 主界面的 preload
          index: resolve('src/preload/index.ts'),
          // 截图浮层的 preload。它只暴露三个方法，故意和主界面分开 ——
          // 浮层是个"临时工"，不该拿到聊天窗口的全套能力
          screenshot: resolve('src/preload/screenshot.ts'),
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // 主界面（React）
          index: resolve('src/renderer/index.html'),
          // 截图浮层。纯 HTML + 原生 JS，不用 React ——
          // 它只需要一块全屏画布和几个鼠标事件，引框架反而累赘
          screenshot: resolve('src/renderer/screenshot.html'),
        },
      },
    },
  },
})
