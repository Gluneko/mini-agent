#!/usr/bin/env node
/**
 * mcp-geo-tools — 一个真实的 MCP Server(stdio 传输,JSON-RPC 2.0,换行分隔)
 * 对应 GeoGPT "找矿工具 / GIS基础工具" 这类 MCP:暴露 tools/list 与 tools/call。
 * 任何 MCP host(agent-builder.js、Claude Code、Cursor…)都能通过 `node mcp-geo-tools.js` 挂载它。
 */
const readline = require('node:readline');

const TOOLS = [
  { name: 'get_layers_metadata', description: '列出可用图层及其元数据(类型、范围、要素数)',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ layers: [{ id: 'faults', type: 'line', count: 128 }, { id: 'samples', type: 'point', count: 2048 }, { id: 'strata', type: 'polygon', count: 36 }] }) },
  { name: 'show_layer_in_map', description: '把指定图层加载到地图上显示',
    inputSchema: { type: 'object', properties: { layer: { type: 'string', description: '图层 id' } }, required: ['layer'] },
    run: ({ layer }) => ({ shown: layer, view: { center: [113.2, 23.1], zoom: 8 } }) },
  { name: 'buffer_analysis', description: '对图层做缓冲区分析,返回缓冲区面积与覆盖要素数',
    inputSchema: { type: 'object', properties: { layer: { type: 'string' }, distance_m: { type: 'number', description: '缓冲距离(米)' } }, required: ['layer', 'distance_m'] },
    run: ({ layer, distance_m }) => ({ layer, distance_m, area_km2: +(Math.PI * (distance_m / 1000) ** 2 * 12).toFixed(2), features_covered: Math.round(distance_m / 25) }) },
  { name: 'IDW_algorithm', description: '反距离加权插值,生成品位/属性栅格',
    inputSchema: { type: 'object', properties: { field: { type: 'string' }, power: { type: 'number', default: 2 } }, required: ['field'] },
    run: ({ field, power = 2 }) => ({ field, power, raster: `idw_${field}_p${power}.tif`, cells: 250000 }) },
  { name: 'extract_vectors_features', description: '按属性条件提取矢量要素',
    inputSchema: { type: 'object', properties: { layer: { type: 'string' }, where: { type: 'string' } }, required: ['layer', 'where'] },
    run: ({ layer, where }) => ({ layer, where, extracted: 17 }) },
];

const send = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { id, method, params = {} } = msg;
  if (method === 'notifications/initialized') return;                         // 通知无需响应
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mcp-geo-tools', version: '0.1.0' } } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  if (method === 'tools/call') {
    const t = TOOLS.find(t => t.name === params.name);
    if (!t) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
    for (const k of t.inputSchema.required || []) if ((params.arguments || {})[k] === undefined) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `缺少必填参数 ${k}` }] } });
    try { return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(t.run(params.arguments || {})) }] } }); }
    catch (e) { return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: e.message }] } }); }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
});
