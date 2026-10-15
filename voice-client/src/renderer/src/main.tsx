import React, { useCallback, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { LangCtx, LangSetCtx, loadLang, saveLang, type Lang } from './lib/i18n'

/**
 * 语言状态的**唯一持有者** ✓
 *
 * ⚠️ 为什么包在这一层、而不是放进 App 里 ✗
 *    App 的 return 是一整棵大 JSX（两千多行那个文件 ✓）
 *    要在它外面包 Provider 就得动那棵树的**头尾** ✓
 *    而头尾中间全是布局相关的代码 ✓ 动它纯属不必要的风险 ✓
 *    包在这儿的话 App 和别的组件一样用 `useT()` 就行 ✓ **一行都不用改** ✓
 *
 * ⚠️ 初始值用**惰性初始化**（传函数而不是值）✗
 *    写 `useState(loadLang())` 的话每次渲染都会去读一次 localStorage ✓
 *    结果一样 ✓ 但那是白读 ✓ 而且 StrictMode 下会读两遍 ✓
 */
function Root() {
  const [lang, setLang] = useState<Lang>(() => loadLang())

  const set = useCallback((l: Lang) => {
    setLang(l)
    // ⚠️ 存盘和 setState 必须**一起**做 ✗
    //    只 setState：这次能用 ✓ 但下次启动又变回中文 ✓
    //    只存盘：得重启才生效 ✓
    saveLang(l)
  }, [])

  return (
    <LangCtx.Provider value={lang}>
      <LangSetCtx.Provider value={set}>
        <App />
      </LangSetCtx.Provider>
    </LangCtx.Provider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
