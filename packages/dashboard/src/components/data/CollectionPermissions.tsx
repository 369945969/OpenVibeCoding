import { useEffect, useState } from 'react'
import { Modal, ModalBody, ModalFooter } from '../ui/Modal'
import { Button } from '../ui'
import { Shield, Lock, Eye, Users, FileEdit } from 'lucide-react'
import { useCapiClient } from '../../services/capi'
import { useApiContext } from '../../services/api-context'
import { toast } from 'sonner'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  collectionName: string
}

const ACL_OPTIONS = [
  {
    value: 'READONLY',
    label: '所有用户可读，仅创建者和管理员可写',
    icon: Eye,
    desc: '适合公开内容，登录用户可读，只能管理自己创建的文档',
  },
  {
    value: 'PRIVATE',
    label: '仅创建者及管理员可读写',
    icon: Lock,
    desc: '每个用户只能访问自己创建的文档',
  },
  {
    value: 'ADMINWRITE',
    label: '所有用户可读，仅管理员可写',
    icon: Users,
    desc: '适合共享配置数据，由管理员统一管理',
  },
  {
    value: 'ADMINONLY',
    label: '仅管理员可读写',
    icon: Shield,
    desc: '最严格的权限，仅后端 / 管理员可操作',
  },
  {
    value: 'CUSTOM',
    label: '自定义安全规则',
    icon: FileEdit,
    desc: '基于 JSON 的细粒度规则（按用户、字段、操作等维度控制）',
  },
]

const DEFAULT_CUSTOM_RULE = JSON.stringify(
  {
    read: 'auth != null',
    write: 'doc._openid == auth.openid',
  },
  null,
  2,
)

export default function CollectionPermissions({ open, onOpenChange, collectionName }: Props) {
  const { envId } = useApiContext()
  const capiClient = useCapiClient()
  const [acl, setAcl] = useState('PRIVATE')
  const [rule, setRule] = useState(DEFAULT_CUSTOM_RULE)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !collectionName) return
    setLoading(true)
    capiClient
      .tcb('DescribeSafeRule', { EnvId: envId, CollectionName: collectionName })
      .then((res: any) => {
        if (res?.AclTag) setAcl(res.AclTag)
        if (res?.Rule && typeof res.Rule === 'string' && res.Rule.trim()) {
          // 服务端可能返回压缩 JSON 字符串，尝试 pretty 化
          try {
            setRule(JSON.stringify(JSON.parse(res.Rule), null, 2))
          } catch {
            setRule(res.Rule)
          }
        } else {
          setRule(DEFAULT_CUSTOM_RULE)
        }
      })
      .catch((e: any) => {
        toast.error(e?.message || '加载权限失败')
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collectionName, envId])

  const handleSave = async () => {
    if (!collectionName || saving) return

    // CUSTOM 模式校验 JSON
    let ruleString: string | undefined
    if (acl === 'CUSTOM') {
      const trimmed = rule.trim()
      if (!trimmed) {
        toast.error('自定义规则不能为空')
        return
      }
      try {
        // 校验 + 压缩成单行（接口接受字符串）
        ruleString = JSON.stringify(JSON.parse(trimmed))
      } catch {
        toast.error('JSON 格式有误，请检查')
        return
      }
    }

    setSaving(true)
    try {
      const params: Record<string, unknown> = {
        EnvId: envId,
        CollectionName: collectionName,
        AclTag: acl,
      }
      if (ruleString) params.Rule = ruleString

      await capiClient.tcb('ModifySafeRule', params)
      toast.success('权限已更新')
      onOpenChange(false)
    } catch (e: any) {
      toast.error(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`权限设置 - ${collectionName}`}
      description="设置集合的访问控制权限"
      size="md"
    >
      <ModalBody className="space-y-2">
        {loading ? (
          <p className="text-xs text-fg-muted py-4 text-center">加载当前权限...</p>
        ) : (
          <>
            {ACL_OPTIONS.map((opt) => {
              const Icon = opt.icon
              return (
                <label
                  key={opt.value}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    acl === opt.value ? 'border-brand bg-brand/5' : 'border-border-default hover:border-border-strong'
                  }`}
                >
                  <input
                    type="radio"
                    value={opt.value}
                    checked={acl === opt.value}
                    onChange={() => setAcl(opt.value)}
                    className="mt-1 accent-brand"
                  />
                  <Icon
                    size={16}
                    className={`mt-0.5 shrink-0 ${acl === opt.value ? 'text-brand' : 'text-fg-lighter'}`}
                  />
                  <div>
                    <p className="text-xs font-medium text-fg-default">{opt.label}</p>
                    <p className="text-xs text-fg-lighter mt-0.5">{opt.desc}</p>
                  </div>
                </label>
              )
            })}

            {acl === 'CUSTOM' && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-default">自定义规则 (JSON)</span>
                  <a
                    href="https://docs.cloudbase.net/database/safety-rules"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-brand hover:underline"
                  >
                    查看规则语法 →
                  </a>
                </div>
                <textarea
                  value={rule}
                  onChange={(e) => setRule(e.target.value)}
                  spellCheck={false}
                  rows={10}
                  className="w-full px-3 py-2 rounded-lg border border-border-default bg-bg-surface-200 text-xs font-mono text-fg-default placeholder:text-fg-muted focus:border-brand focus:ring-1 focus:ring-brand/30 focus:outline-none transition-colors resize-y"
                  placeholder={DEFAULT_CUSTOM_RULE}
                />
                <p className="text-xs text-fg-lighter">
                  支持 <code className="font-mono">read</code> / <code className="font-mono">write</code> /
                  <code className="font-mono"> create</code> / <code className="font-mono">update</code> /
                  <code className="font-mono"> delete</code> 字段，值为表达式或布尔。
                </p>
              </div>
            )}
          </>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="tiny" onClick={() => onOpenChange(false)} disabled={saving}>
          取消
        </Button>
        <Button variant="primary" size="tiny" onClick={handleSave} loading={saving} disabled={loading}>
          <Shield size={14} /> 保存权限
        </Button>
      </ModalFooter>
    </Modal>
  )
}
