import { useState } from 'react'
import { HashIcon, SpeakerIcon } from './icons'
import type { ChannelInfo } from '../lib/api'

type Props = {
  open: boolean
  onCancel: () => void
  /**
   * 可以当父频道的候选（**只传顶层频道** ✓）
   *
   * ⚠️ 由调用方筛好"顶层"，不在这里筛 ✗
   *    因为那是个业务规则（服务端也拦 ✓）✓ 放两处筛迟早会不一致 ✓
   *    这里只负责把同类的那几个列出来 ✓
   */
  parents?: ChannelInfo[]
  onCreate: (name: string, kind: 'text' | 'voice', parentId: string | null) => void
}

export function ChannelCreateDialog({ open, onCancel, parents = [], onCreate }: Props) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'text' | 'voice'>('text')
  const [parentId, setParentId] = useState<string | null>(null)

  if (!open) return null

  // ⚠️ 只列**同类**的父频道 ✗
  //    文字频道下面挂语音子频道、或者反过来，语义都很绕 ✓
  //    服务端也会拒（parent_kind_mismatch ✓）
  //    但这里直接不列出来更好 —— 让人根本选不到会失败的东西 ✓
  const candidates = parents.filter((p) => p.kind === kind)

  const submit = () => {
    const n = name.trim()
    if (!n) return
    onCreate(n, kind, parentId)
    setName('')
    setParentId(null)
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <h2>创建频道</h2>

        <label>类型</label>
        <div className="kind-row">
          <button
            className={kind === 'text' ? '' : 'ghost'}
            onClick={() => {
              setKind('text')
              // ⚠️ 换类型必须清掉已选的父频道 ✗
              //    不清的话会留着上一个类型里的那个 id ✓
              //    而它已经不在候选列表里了 ✓ 于是下拉框显示空白
              //    但提交时**还是会把它发出去** ✓ 服务端直接拒 ✓ 用户一头雾水 ✓
              setParentId(null)
            }}
          >
            <HashIcon size={14} /> 文字频道
          </button>
          <button
            className={kind === 'voice' ? '' : 'ghost'}
            onClick={() => {
              setKind('voice')
              setParentId(null)
            }}
          >
            <SpeakerIcon size={14} /> 语音频道
          </button>
        </div>

        <label>
          名字
          <input
            value={name}
            autoFocus
            maxLength={24}
            placeholder={kind === 'text' ? '例如：闲聊' : '例如：开黑'}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
        </label>

        {/* 父频道选择。**一个候选都没有时整块不显示** ✓
            这种情况下"顶层"是唯一选项 ✓ 摆一个只有一个选项的下拉框只会碍事 ✓
            （新装好、还没建过频道时就是这个样子 ✓） */}
        {candidates.length > 0 && (
          <label>
            放在哪里
            <select
              value={parentId ?? ''}
              onChange={(e) => setParentId(e.target.value || null)}
            >
              <option value="">顶层（和别的频道并列）</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  挂在「{p.name}」下面
                </option>
              ))}
            </select>
          </label>
        )}

        <p className="hint">
          {parentId
            ? '子频道会缩进显示在父频道下面。删掉父频道时它会一起被删掉。'
            : kind === 'voice'
              ? '语音频道的名字会成为 LiveKit 的房间名，加入的人互相能听见。'
              : '文字频道的消息会存在服务端，历史消息随时能翻。'}
        </p>

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button onClick={submit} disabled={!name.trim()}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
