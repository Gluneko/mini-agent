#!/usr/bin/env node
/**
 * mini-agent — 最小 Agent 执行引擎(单文件、零依赖)
 *
 * 目的:吃透 Agent 的核心循环与防护机制。生产系统是它的工程化放大:
 *   工具注册表 → MCP 工具商店 ｜ 执行日志 → 前端轨迹可视化 ｜ 熔断常量 → 可配置策略
 *
 * 运行:
 *   node agent.js --mock "帮我算 (37*89+12),再告诉我现在的时间"     # 无需 API key,看执行轨迹
 *   OPENAI_API_KEY=sk-xx [OPENAI_BASE_URL=https://api.xx.com/v1] [MODEL=gpt-4o-mini] \
 *     node agent.js "读取 ./agent.js 前 5 行并总结"                  # 任意 OpenAI 兼容端点
 */

// ─────────────────────── 1. 工具注册表 ───────────────────────
// 一个工具 = name + description(模型靠它决定何时调用,质量决定调用准确率)+ 参数 schema + run
const TOOLS = {
  calculator: {
    description: '计算一个四则运算表达式,如 "(37*89+12)/3"。只支持数字与 + - * / ( ) .',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '算式' } },
      required: ['expression'],
    },
    run: async ({ expression }) => {
      if (!/^[\d+\-*/().\s]+$/.test(expression)) throw new Error('表达式含非法字符');
      return String(Function(`"use strict"; return (${expression})`)());
    },
  },
  now: {
    description: '返回当前日期和时间(ISO 格式)',
    parameters: { type: 'object', properties: {} },
    run: async () => new Date().toString(),
  },
  read_file: {
    description: '读取本地文本文件的前 N 行',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        lines: { type: 'number', description: '读取行数,默认 20' },
      },
      required: ['path'],
    },
    run: async ({ path, lines = 20 }) => {
      const fs = await import('node:fs/promises');
      const text = await fs.readFile(path, 'utf8');
      return text.split('\n').slice(0, lines).join('\n');
    },
  },
};

// ─────────────────────── 2. 防护常量(引擎层硬限制,模型无法绕过) ───────────────────────
const MAX_STEPS = 8;          // 全局最大步数:防无限循环烧 token 的最后防线
const TOOL_TIMEOUT_MS = 10_000; // 单工具超时:防单个工具卡死整个任务
const KEEP_LAST_ROUNDS = 6;   // 上下文裁剪:保 system + 首条用户消息(任务目标)+ 最近 N 条

// ─────────────────────── 3. 模型调用(OpenAI 兼容 / mock) ───────────────────────
async function callModel(messages, mock) {
  if (mock) return mockModel(messages);
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.MODEL || 'gpt-4o-mini',
      messages,
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        type: 'function',
        function: { name, description: t.description, parameters: t.parameters },
      })),
    }),
  });
  if (!res.ok) throw new Error(`模型调用失败 ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message;
}

// mock 模型:演示"先调两个工具再总结"的典型轨迹,让引擎无 key 也能跑通
function mockModel(messages) {
  const called = messages.filter(m => m.role === 'tool').map(m => m.name);
  if (!called.includes('calculator'))
    return { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"(37*89+12)"}' } }] };
  if (!called.includes('now'))
    return { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'now', arguments: '{}' } }] };
  const calc = messages.find(m => m.role === 'tool' && m.name === 'calculator');
  return { role: 'assistant', content: `计算结果是 ${calc.content},当前时间见上一步工具结果。(mock 回答)` };
}

// ─────────────────────── 4. 主循环:Agent 的全部秘密就在这 30 行里 ───────────────────────
async function runAgent(task, { mock = false } = {}) {
  let messages = [
    { role: 'system', content: '你是一个严谨的助手。需要外部信息或计算时调用工具;信息足够时直接给最终回答,不要重复调用同一工具。' },
    { role: 'user', content: task },
  ];
  const toolCallHistory = []; // 重复调用检测用

  for (let step = 1; step <= MAX_STEPS; step++) {
    const msg = await callModel(pruneContext(messages), mock);
    messages.push(msg);

    // 模型没有再要工具 → 任务完成,返回最终回答
    if (!msg.tool_calls?.length) {
      console.log(`\n✅ [第 ${step} 步] 最终回答:\n${msg.content}`);
      return msg.content;
    }

    // 逐个执行工具调用,结果塞回上下文
    for (const tc of msg.tool_calls) {
      const { name } = tc.function;
      const args = JSON.parse(tc.function.arguments || '{}');
      console.log(`🔧 [第 ${step} 步] 调用工具 ${name}(${tc.function.arguments})`);

      // 防死循环第 2 层:重复调用检测 → 注入纠偏指令(软引导)
      const sig = name + tc.function.arguments;
      if (toolCallHistory.includes(sig)) {
        console.log(`⚠️  检测到重复调用,注入纠偏指令`);
        messages.push({ role: 'tool', tool_call_id: tc.id, name, content: '[系统] 该工具已用相同参数调用过,请基于已有结果换思路或直接总结。' });
        continue;
      }
      toolCallHistory.push(sig);

      // 防死循环第 3 层:单工具超时(硬限制)
      let result;
      try {
        result = await Promise.race([
          TOOLS[name] ? TOOLS[name].run(args) : Promise.reject(new Error(`未知工具 ${name}`)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('工具执行超时')), TOOL_TIMEOUT_MS)),
        ]);
      } catch (e) {
        result = `[工具错误] ${e.message}`; // 错误也塞回去:让模型自己决定重试还是换路,而不是引擎崩溃
      }
      console.log(`   ↳ 结果: ${String(result).slice(0, 120)}`);
      messages.push({ role: 'tool', tool_call_id: tc.id, name, content: String(result) });
    }
  }
  // 防死循环第 1 层:全局步数熔断(最后防线,纯代码实现,模型无法绕过)
  console.log(`\n⛔ 达到最大步数 ${MAX_STEPS},强制中断(生产环境这里返回友好提示 + 记录轨迹日志)`);
  return null;
}

// 上下文裁剪:保 system + 首条用户消息(别让模型"忘记任务目标"),中间只留最近几轮
function pruneContext(messages) {
  if (messages.length <= 2 + KEEP_LAST_ROUNDS) return messages;
  return [messages[0], messages[1], ...messages.slice(-KEEP_LAST_ROUNDS)];
}

// ─────────────────────── 入口 ───────────────────────
const mock = process.argv.includes('--mock');
const task = process.argv.filter(a => !a.startsWith('--')).slice(2).join(' ') || '帮我算 (37*89+12),再告诉我现在的时间';
console.log(`🎯 任务: ${task}\n`);
runAgent(task, { mock }).catch(e => { console.error('运行失败:', e.message); process.exit(1); });
