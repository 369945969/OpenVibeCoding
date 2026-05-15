/**
 * Augmented tool: cronTask
 *
 * 完全新增的工具：定时任务 CRUD。直接操作本地 DB + node-cron 调度器。
 *
 * 历史背景：原本在 sandbox-mcp-proxy.ts 中硬编码（line 591-781）。
 *
 * 注意：cronTask 是 server 端能力，直接 import getDb / scheduleTask 等本地模块。
 *      currentModel 通过 ctx.extra.currentModel 传入（创建任务时复用当前模型）。
 */

import { nanoid } from 'nanoid'
import cron from 'node-cron'
import { getDb } from '../../../db/index.js'
import { scheduleTask, unscheduleTask } from '../../../services/cron-scheduler.js'
import type { McpPolicy } from './_index.js'

export const policy: McpPolicy = {
  description: 'Cron task CRUD (create / list / update / delete)',

  augment: {
    description:
      '定时任务管理工具。支持创建、查询、更新、删除定时任务。' +
      '定时任务到达设定时间后会自动创建 Agent 会话执行指定操作。' +
      '当用户提到定时、定期、每天/每周/每小时执行时使用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete'], description: '操作类型' },
        id: { type: 'string', description: '任务 ID（update/delete 时必填）' },
        name: { type: 'string', description: '任务名称（create 时必填）' },
        prompt: { type: 'string', description: 'Agent 要执行的内容（create 时必填）' },
        cronExpression: { type: 'string', description: 'Cron 表达式，如 "0 20 * * *"（create 时必填）' },
        enabled: { type: 'boolean', description: '是否启用，默认 true' },
      },
      required: ['action'],
    },
  },

  async use(ctx) {
    const action = ctx.input.action as string
    const userId = ctx.userId
    const args = ctx.input as Record<string, unknown>

    try {
      if (action === 'list') {
        const tasks = await getDb().cronTasks.findByUserId(userId)
        return JSON.stringify({
          success: true,
          data: tasks.map((t) => ({
            id: t.id,
            name: t.name,
            prompt: t.prompt,
            cronExpression: t.cronExpression,
            enabled: t.enabled,
            lastRunAt: t.lastRunAt,
          })),
        })
      }

      if (action === 'create') {
        const name = args.name as string
        const prompt = args.prompt as string
        const cronExpression = args.cronExpression as string
        const enabled = (args.enabled as boolean) ?? true

        if (!name || !prompt || !cronExpression) {
          return JSON.stringify({ error: true, message: 'create 需要 name、prompt、cronExpression' })
        }
        if (!cron.validate(cronExpression)) {
          return JSON.stringify({ error: true, message: 'Cron 表达式无效' })
        }

        const newTask = await getDb().cronTasks.create({
          id: nanoid(),
          userId,
          name,
          prompt,
          cronExpression,
          enabled,
          repoUrl: null,
          selectedAgent: 'codebuddy',
          selectedModel: ctx.extra.currentModel || 'gml-5.0',
          lastRunAt: null,
          nextRunAt: null,
          lockedBy: null,
          lockedAt: null,
        })

        if (newTask.enabled) scheduleTask(newTask)

        return JSON.stringify({
          success: true,
          id: newTask.id,
          name: newTask.name,
          cronExpression: newTask.cronExpression,
          enabled: newTask.enabled,
        })
      }

      if (action === 'update') {
        const id = args.id as string
        if (!id) return JSON.stringify({ error: true, message: 'update 需要 id' })
        if (args.cronExpression && !cron.validate(args.cronExpression as string)) {
          return JSON.stringify({ error: true, message: 'Cron 表达式无效' })
        }
        const updateData: Record<string, unknown> = {}
        if (args.name !== undefined) updateData.name = args.name
        if (args.prompt !== undefined) updateData.prompt = args.prompt
        if (args.cronExpression !== undefined) updateData.cronExpression = args.cronExpression
        if (args.enabled !== undefined) updateData.enabled = args.enabled

        const updated = await getDb().cronTasks.update(id, userId, updateData)
        if (!updated) return JSON.stringify({ error: true, message: '任务不存在' })
        if (updated.enabled) scheduleTask(updated)
        else unscheduleTask(updated.id)

        return JSON.stringify({ success: true, id: updated.id, name: updated.name, enabled: updated.enabled })
      }

      if (action === 'delete') {
        const id = args.id as string
        if (!id) return JSON.stringify({ error: true, message: 'delete 需要 id' })
        const existing = await getDb().cronTasks.findByIdAndUserId(id, userId)
        if (!existing) return JSON.stringify({ error: true, message: '任务不存在' })
        unscheduleTask(id)
        await getDb().cronTasks.delete(id, userId)
        return JSON.stringify({ success: true, message: '已删除' })
      }

      return JSON.stringify({ error: true, message: '未知操作' })
    } catch (e: any) {
      return JSON.stringify({ error: true, message: e.message })
    }
  },
}
